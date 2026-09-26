/**
 * The scan pipeline.
 *
 * Everything here runs on-device. The order is chosen so the expensive work
 * happens last and can be skipped:
 *
 *   OCR -> confidence check -> (optional upscale) -> classify -> LLM
 *
 * Reading the receipt with OCR is the only way to know whether the image was
 * legible, and the confidence score is what tells us. Upscaling a crisp
 * receipt wastes six minutes and can make it worse, so it is opt-in and only
 * offered when the first pass actually came out shaky.
 */

import fs from 'node:fs'
import {
	ocr,
	classify,
	upscale,
	completion,
	OCR_LATIN,
	REALESRGAN_X4PLUS,
} from '@qvac/sdk'
import { blocksToLines, linesToText, meanConfidence } from './ocr-lines.js'
import { RECEIPT_SCHEMA, buildPrompt, buildReceipt } from './receipt.js'
import { ensureLlm, ensureModel, DEFAULT_LLM } from './engine.js'

/** Below this mean OCR confidence the image is worth a second look. */
export const LOW_CONFIDENCE = 0.8
const PREDICT_TOKENS = 700

const OCR_CONFIG = {
	langList: ['en'],
	magRatio: 1.5,
	// 0 is excluded on purpose: the plugin rejects an all-zero list, and these
	// are the angles a phone photo of a receipt actually arrives at.
	defaultRotationAngles: [90, 180, 270],
	contrastRetry: true,
	lowConfidenceThreshold: 0.4,
	recognizerBatchSize: 1,
}

/**
 * Reads one image with the OCR model.
 *
 * @returns {Promise<{text: string, lines: object[], confidence: number|null, words: number}>}
 */
async function readImage(modelId, image) {
	const { blocks } = ocr({ modelId, image, options: { paragraph: false } })
	const result = await blocks
	const lines = blocksToLines(result)
	return {
		text: linesToText(lines),
		lines,
		confidence: meanConfidence(result),
		words: result.length,
	}
}

/** Labels the image with a bundled classifier so we can sanity-check the LLM. */
async function readLabels(modelId, image) {
	try {
		const results = await classify({ modelId, image })
		return results.map(({ label, confidence }) => ({
			label,
			confidence,
		}))
	} catch {
		// The classifier is a nice-to-have cross-check, never a hard dependency.
		return []
	}
}

/** Runs the local upscaler, returning a PNG buffer. */
async function enhance(modelId, image) {
	const { outputs } = upscale({ modelId, image, repeats: 1 })
	const [png] = await outputs
	return png
}

/** Grammar-constrained extraction. The schema is enforced by llama.cpp. */
async function extract(modelId, ocrText) {
	const run = completion({
		modelId,
		history: buildPrompt(ocrText),
		stream: true,
		modelConfig: { ctx_size: 4096 },
		generationParams: {
			predict: PREDICT_TOKENS,
			temp: 0,
			top_p: 1,
			seed: 42,
		},
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
	for await (const event of run.events) {
		if (event.type === 'contentDelta') deltas++
		if (event.type === 'completionDone') {
			stopReason = event.stopReason ?? event.error?.message ?? 'done'
		}
	}

	const final = await run.final
	return {
		raw: final.contentText ?? final.raw?.fullText ?? '',
		stopReason,
		deltas,
	}
}

/**
 * Scans one receipt image.
 *
 * @param {object} options
 * @param {string|Buffer} options.image path or encoded image bytes
 * @param {boolean} [options.enhance] upscale first, for a hard-to-read photo
 * @param {'fast'|'accurate'} [options.quality]
 * @param {(progress: {stage: string, message: string, pct: number}) => void} [options.onProgress]
 */
export async function scanReceipt({ image, enhance: doEnhance = false, quality = DEFAULT_LLM, onProgress = () => {} }) {
	const started = Date.now()
	const bytes = Buffer.isBuffer(image) ? image : fs.readFileSync(image)
	const timings = {}
	const time = async (name, fn) => {
		const t0 = Date.now()
		const value = await fn()
		timings[name] = Date.now() - t0
		return value
	}

	let working = bytes
	let enhanced = false
	let upscaleMs = null

	if (doEnhance) {
		onProgress({ stage: 'enhance', message: 'Enhancing the photo', pct: 5 })
		const esrgan = await ensureModel(
			'esrgan',
			{
				modelSrc: REALESRGAN_X4PLUS,
				modelType: 'diffusion',
				modelConfig: { mode: 'upscale', upscaler: { tile_size: 128 } },
			},
			(pct) => onProgress({ stage: 'enhance', message: `Downloading upscaler ${pct}%`, pct }),
		)
		working = await time('enhance', () => enhance(esrgan, bytes))
		enhanced = true
		upscaleMs = timings.enhance
	}

	onProgress({ stage: 'ocr', message: 'Reading the receipt', pct: enhanced ? 20 : 8 })
	const ocrModel = await ensureModel('ocr', { modelSrc: OCR_LATIN, modelConfig: OCR_CONFIG }, (pct) =>
		onProgress({ stage: 'ocr', message: `Preparing OCR ${pct}%`, pct }),
	)
	const firstPass = await time('ocr', () => readImage(ocrModel, working))

	const confidence = firstPass.confidence
	const shaky = confidence === null || confidence < LOW_CONFIDENCE

	// Reading it a second time is only worth the wait when the first pass was
	// genuinely poor, and the user asked for it.
	let pass = firstPass
	if (doEnhance && enhanced && shaky) {
		onProgress({ stage: 'ocr', message: 'Re-reading the enhanced photo', pct: 45 })
		pass = await readImage(ocrModel, working)
	}

	if (!pass.text.trim()) {
		throw Object.assign(new Error('No text could be read from that image.'), { stage: 'ocr' })
	}

	onProgress({ stage: 'classify', message: 'Classifying the document', pct: 55 })
	const classifyModel = await ensureModel('classify', { modelType: 'ggml-classification' })
	const labels = await time('classify', () => readLabels(classifyModel, working))

	onProgress({ stage: 'extract', message: 'Reading the expense', pct: 65 })
	const llm = await ensureLlm(quality, (pct) =>
		onProgress({ stage: 'extract', message: `Loading model ${pct}%`, pct: 65 + Math.round(pct * 0.2) }),
	)
	const extraction = await time('extract', () => extract(llm, pass.text))

	onProgress({ stage: 'done', message: 'Done', pct: 100 })

	let receipt = null
	let parseError = null
	try {
		receipt = buildReceipt(extraction.raw, pass.text)
	} catch (err) {
		// The raw text is still worth showing the user even when the JSON did
		// not survive, so we report the failure instead of throwing it away.
		parseError = err.message
	}

	return {
		receipt,
		parseError,
		diagnostics: {
			enhanced,
			shaky,
			// The first pass decides whether the image is legible at all; a retry
			// is judged on the same scale, so report the number we acted on.
			ocrConfidence: pass === firstPass ? confidence : pass.confidence,
			lowConfidence: confidence === null ? null : confidence < LOW_CONFIDENCE,
			upscaleMs,
			words: pass.words,
			lines: pass.lines.length,
			labels,
			stopReason: extraction.stopReason,
			timings,
			totalMs: Date.now() - started,
			quality,
		},
		rawText: pass.text,
		rawModelOutput: extraction.raw,
	}
}
