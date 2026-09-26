/**
 * Environment self-test.
 *
 * Proves the three things that have to work before StrukAI is useful at all:
 *   1. the QVAC worker boots on this machine
 *   2. a model can be downloaded and loaded into memory
 *   3. tokens actually stream back out of it
 *
 * Everything runs locally. The only network traffic is the one-time model
 * download; after that the model is cached under the QVAC cache directory
 * (~/.qvac/models by default) and runs fully offline.
 *
 * Usage:
 *   npm run selftest
 */
import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from '@qvac/sdk'

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`

async function main() {
	console.log('StrukAI self-test')
	console.log('-----------------')

	const started = Date.now()
	const modelId = await loadModel({
		modelSrc: QWEN3_600M_INST_Q4,
		onProgress: (p) => {
			const line = `  downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)})`
			process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
			if (p.percentage >= 100) process.stderr.write('\n')
		},
	})
	console.log(`  model loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`)

	const run = completion({
		modelId,
		history: [{ role: 'user', content: 'In one sentence: what is OCR?' }],
		stream: true,
	})

	let text = ''
	for await (const event of run.events) {
		if (event.type === 'contentDelta') {
			process.stdout.write(event.text)
			text += event.text
		}
	}
	const final = await run.final
	console.log('\n-----------------')
	console.log(`  ${text.trim().split(/\s+/).length} words streamed back`)
	if (final.stats) console.log(`  stats: ${JSON.stringify(final.stats)}`)
	console.log('  OK - on-device inference works.')

	await unloadModel({ modelId })
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error('\n  FAILED:', error)
		process.exit(1)
	},
)
