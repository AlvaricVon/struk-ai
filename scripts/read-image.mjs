/**
 * OCRs an arbitrary image and prints the reconstructed text to stdout.
 *
 * Useful for checking that a screenshot really shows the result before it gets
 * published:
 *
 *   node scripts/read-image.mjs docs/screenshot.png
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { close, loadModel, ocr, unloadModel, OCR_LATIN } from '@qvac/sdk'
import { blocksToLines, linesToText, meanConfidence } from '../src/ocr-lines.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] ?? 'docs/screenshot.png'
const image = path.isAbsolute(target) ? target : path.join(root, target)

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

const started = Date.now()
const { blocks } = ocr({ modelId, image, options: { paragraph: false } })
const result = await blocks
const lines = blocksToLines(result)

console.log(`\n${target}: ${result.length} words -> ${lines.length} lines, ${(meanConfidence(result) * 100).toFixed(1)}% mean confidence, ${Date.now() - started}ms\n`)
console.log(linesToText(lines))

await unloadModel({ modelId })
close()
process.exit(0)
