/**
 * Capability probe.
 *
 * Runs a single QVAC capability against a file, in isolation, so you can find
 * out which parts work on *your* machine before wiring up the whole app. Every
 * model runs on-device; only the first run of each downloads weights.
 *
 * Usage:
 *   node scripts/probe.mjs ocr      [image]   default samples/receipt-coffee.png
 *   node scripts/probe.mjs classify [image]   default samples/receipt-coffee.png
 *   node scripts/probe.mjs upscale  [image]   default samples/receipt-market.png
 *   node scripts/probe.mjs llm                  grammar-constrained JSON check
 *   node scripts/probe.mjs all
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	close,
	completion,
	classify,
	loadModel,
	ocr,
	unloadModel,
	upscale,
	OCR_LATIN,
	REALESRGAN_X4PLUS,
	QWEN3_600M_INST_Q4,
} from '@qvac/sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => (p ? path.resolve(process.cwd(), p) : null)

/** Download progress is emitted per chunk, across several assets at once. Log every 5% per asset. */
function progress(label) {
	const seen = new Map()
	return (p) => {
		const key = p.downloadKey ?? label
		const pct = Math.floor(p.percentage)
		const prev = seen.get(key) ?? -1
		if (pct < 100 && pct - prev < 5) return
		seen.set(key, pct)
		const mb = (n) => `${(n / 1e6).toFixed(0)} MB`
		process.stderr.write(
			`  ${label} ${pct}% (${mb(p.downloaded)}/${mb(p.total)})\n`,
		)
	}
}

const RECEIPT_SCHEMA = {
	type: 'object',
	properties: {
		merchant: { type: 'string' },
		date: { type: 'string' },
		total: { type: 'number' },
		currency: { type: 'string' },
		payment_method: { type: 'string' },
		category: {
			type: 'string',
			enum: ['food', 'groceries', 'transport', 'shopping', 'utilities', 'other'],
		},
	},
	required: ['merchant', 'date', 'total', 'currency', 'payment_method', 'category'],
	additionalProperties: false,
}

async function probeOcr(imageArg) {
	const image = rel(imageArg) ?? path.join(root, 'samples', 'receipt-coffee.png')
	console.log(`OCR on ${path.relative(root, image)}`)

	const modelId = await loadModel({
		modelSrc: OCR_LATIN,
		onProgress: progress('ocr model'),
		modelConfig: {
			langList: ['en'],
			magRatio: 1.5,
			defaultRotationAngles: [90, 180, 270],
			contrastRetry: true,
			lowConfidenceThreshold: 0.4,
			recognizerBatchSize: 1,
		},
	})
	console.log(`  model: ${modelId}`)

	const started = Date.now()
	const { blocks } = ocr({ modelId, image, options: { paragraph: false } })
	const result = await blocks
	console.log(`  ${result.length} blocks in ${Date.now() - started}ms\n`)

	for (const b of result) {
		const conf = b.confidence !== undefined ? ` ${(b.confidence * 100).toFixed(0)}%` : ''
		console.log(`  [${(b.bbox || []).join(',')}]${conf}\n    ${JSON.stringify(b.text)}`)
	}
	await unloadModel({ modelId })
}

async function probeClassify(imageArg) {
	const image = rel(imageArg) ?? path.join(root, 'samples', 'receipt-coffee.png')
	console.log(`classify on ${path.relative(root, image)}`)

	const modelId = await loadModel({ modelType: 'ggml-classification' })
	const results = await classify({ modelId, image: fs.readFileSync(image) })
	for (const { label, confidence } of results) {
		console.log(`  ${label.padEnd(8)} ${(confidence * 100).toFixed(1)}%`)
	}
	await unloadModel({ modelId })
}

async function probeUpscale(imageArg) {
	const image = rel(imageArg) ?? path.join(root, 'samples', 'receipt-market.png')
	console.log(`upscale on ${path.relative(root, image)}`)

	const modelId = await loadModel({
		modelSrc: REALESRGAN_X4PLUS,
		modelType: 'diffusion',
		modelConfig: { mode: 'upscale', upscaler: { tile_size: 128 } },
		onProgress: progress('esrgan model'),
	})
	console.log(`  model: ${modelId}`)

	const started = Date.now()
	const { outputs, stats } = upscale({ modelId, image: fs.readFileSync(image), repeats: 1 })
	const [png] = await outputs
	const out = path.join(root, 'out', 'probe-upscaled.png')
	fs.mkdirSync(path.dirname(out), { recursive: true })
	fs.writeFileSync(out, png)
	console.log(`  ${Date.now() - started}ms -> ${path.relative(root, out)} (${(png.length / 1024) | 0} KB)`)
	console.log(`  stats: ${JSON.stringify(await stats)}`)
	await unloadModel({ modelId })
}

async function probeLlm() {
	console.log('llm: grammar-constrained JSON extraction')
	const modelId = await loadModel({
		modelSrc: QWEN3_600M_INST_Q4,
		modelConfig: { ctx_size: 2048 },
		onProgress: progress('llm model'),
	})

	const history = [
		{
			role: 'system',
			content:
				'You extract expense data from receipt text. Reply only with JSON. /no_think',
		},
		{
			role: 'user',
			content: `Receipt text:
TOTAL 29.92
VISA ****4412
BREW & CO.
12/03/2026 09:41`,
		},
	]

	const run = completion({
		modelId,
		history,
		stream: true,
		responseFormat: {
			type: 'json_schema',
			json_schema: { name: 'receipt', schema: RECEIPT_SCHEMA },
		},
	})
	for await (const event of run.events) {
		if (event.type === 'contentDelta') process.stdout.write(event.text)
	}
	const final = await run.final
	console.log(`\n  schema-valid: ${JSON.stringify(JSON.parse(final.contentText.trim()))}`)
	await unloadModel({ modelId })
}

const PROBES = { ocr: probeOcr, classify: probeClassify, upscale: probeUpscale, llm: probeLlm }

const [which, ...rest] = process.argv.slice(2)
if (!which || which === 'all') {
	for (const [name, fn] of Object.entries(PROBES)) {
		console.log(`\n=== ${name} ===`)
		try {
			await fn(...rest)
		} catch (error) {
			console.error(`  FAILED: ${error?.message ?? error}`)
		}
	}
} else if (PROBES[which]) {
	await PROBES[which](...rest)
} else {
	console.error(`unknown probe '${which}' - try: ${Object.keys(PROBES).join(', ')}, all`)
	process.exit(1)
}

await close()
process.exit(0)
