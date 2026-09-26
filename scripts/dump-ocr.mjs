/**
 * Dumps reconstructed OCR text for the bundled sample receipts into
 * samples/ocr-*.txt.
 *
 * Those files are checked in so the parsing half of the app can be developed and
 * tested without paying the ~40s OCR cost on every change, and so there is a
 * fixed, reviewable record of what the OCR stage actually produces for our
 * samples. Regenerate with: node scripts/dump-ocr.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { close, loadModel, ocr, unloadModel, OCR_LATIN } from '@qvac/sdk'
import { blocksToLines, linesToText, meanConfidence } from '../src/ocr-lines.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const samples = path.join(root, 'samples')

const TARGETS = [
	{ image: 'receipt-coffee.png', out: 'ocr-coffee.txt' },
	{ image: 'receipt-market.png', out: 'ocr-market.txt' },
]

const modelId = await loadModel({
	modelSrc: OCR_LATIN,
	modelConfig: {
		langList: ['en'],
		magRatio: 1.5,
		defaultRotationAngles: [90, 180, 270],
		contrastRetry: true,
		lowConfidenceThreshold: 0.4,
		recognizerBatchSize: 1,
	},
})

for (const { image, out } of TARGETS) {
	const imagePath = path.join(samples, image)
	const started = Date.now()
	const { blocks } = ocr({ modelId, image: imagePath, options: { paragraph: false } })
	const result = await blocks
	const lines = blocksToLines(result)
	const confidence = meanConfidence(result)

	fs.writeFileSync(path.join(samples, out), `${linesToText(lines)}\n`)
	console.log(
		`${image}: ${result.length} words -> ${lines.length} lines ` +
			`(${(meanConfidence(result) * 100).toFixed(1)}% mean confidence, ` +
			`${((Date.now() - started) / 1000).toFixed(1)}s) -> samples/${out}`,
	)
	if (confidence !== null) {
		const weak = lines.filter((l) => l.confidence !== null && l.confidence < 0.7)
		if (weak.length) {
			console.log(`  low-confidence lines: ${weak.length}`)
			for (const l of weak) {
				console.log(`    ${(l.confidence * 100).toFixed(0)}%  ${JSON.stringify(l.text)}`)
			}
		}
	}
}

await unloadModel({ modelId })
await close()
process.exit(0)
