/**
 * Measures extraction quality of a given model against the checked-in OCR
 * fixtures. Run it once per candidate model and compare the printed receipts:
 *
 *   node scripts/eval-extract.mjs QWEN3_600M_INST_Q4
 *   node scripts/eval-extract.mjs QWEN3_1_7B_INST_Q4
 *
 * Sampling is pinned (temp 0, fixed seed) so a rerun on the same model gives
 * the same numbers and a difference is always the model, never the dice.
 * Only the LLM is loaded here - the fixtures are the text OCR already read, so
 * the OCR model does not need to be resident.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	loadModel,
	completion,
	QWEN3_600M_INST_Q4,
	QWEN3_1_7B_INST_Q4,
	QWEN3_4B_INST_Q4_K_M,
} from '@qvac/sdk'
import { RECEIPT_SCHEMA, buildPrompt, buildReceipt } from '../src/receipt.js'

/**
 * A bare model id string cannot be loaded: the SDK infers the engine from the
 * registry descriptor, so we have to hand it the constant itself.
 */
const CATALOG = {
	QWEN3_600M_INST_Q4,
	QWEN3_1_7B_INST_Q4,
	QWEN3_4B_INST_Q4_K_M,
}

const choice = process.argv[2] ?? 'QWEN3_600M_INST_Q4'
const modelSrc = CATALOG[choice]
if (!modelSrc) {
	throw new Error(
		`unknown model "${choice}", try one of: ${Object.keys(CATALOG).join(', ')}`,
	)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = ['ocr-coffee.txt', 'ocr-market.txt']
const CTX_SIZE = 4096
const PREDICT = 700

console.log(`\n=== ${choice} ===`)

const started = Date.now()
const loaded = await loadModel({
	modelSrc,
	modelConfig: { ctx_size: CTX_SIZE },
})
console.log(`loaded in ${Date.now() - started}ms (modelId: ${loaded})\n`)

for (const fixture of fixtures) {
	const ocrText = fs.readFileSync(path.join(root, 'samples', fixture), 'utf8')
	const began = Date.now()

	const run = completion({
		modelId: loaded,
		history: buildPrompt(ocrText),
		stream: true,
		modelConfig: { ctx_size: CTX_SIZE },
		generationParams: { predict: PREDICT, temp: 0, top_p: 1, seed: 42 },
		responseFormat: {
			type: 'json_schema',
			json_schema: {
				name: 'receipt',
				description: 'A structured record of the fields printed on one receipt.',
				schema: RECEIPT_SCHEMA,
			},
		},
	})

	let deltas = 0
	let stopReason = null
	let stats = null
	for await (const event of run.events) {
		if (event.type === 'contentDelta') deltas++
		if (event.type === 'completionStats') stats = event.stats
		if (event.type === 'completionDone') stopReason = event.stopReason ?? event.error?.message ?? 'done'
	}

	const final = await run.final
	const elapsed = Date.now() - began
	const raw = final.contentText ?? final.raw?.fullText ?? ''

	console.log(`--- ${fixture}  (${elapsed}ms) ---`)
	console.log(
		`  ${deltas} contentDeltas, stopReason=${stopReason ?? 'n/a'}, ` +
			`${stats?.generatedTokens ?? '?'} tokens, ` +
			`${stats?.tokensPerSecond ? Math.round(stats.tokensPerSecond) + ' tok/s' : 'n/a'}`,
	)
	if (stopReason === 'length') {
		console.log(`  !! hit the ${PREDICT}-token cap, the JSON is likely truncated`)
	}

	console.log('\nraw model output:')
	console.log(raw.trim() || '(empty)')

	try {
		const receipt = buildReceipt(raw, ocrText)
		console.log('\nnormalised receipt:')
		console.log(JSON.stringify(receipt, null, 2))
	} catch (err) {
		console.log(`\n!! buildReceipt failed: ${err.message}`)
	}
	console.log()
}

// The SDK keeps its worker resident, so the event loop never drains on its own.
process.exit(0)
