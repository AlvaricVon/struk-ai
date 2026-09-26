/**
 * Model residency.
 *
 * QVAC keeps every loaded model in GPU/CPU memory, and reloading a 1 GB LLM
 * costs seconds, so models are loaded once and kept. What we deliberately do
 * *not* keep is the upscaler: it is only useful for a low-confidence retry and
 * its weights are dead weight the rest of the time.
 *
 * Concurrent requests share one load. Without the promise memo below, two
 * scans arriving together would each start a download of the same weights.
 */

import { loadModel, unloadModel, QWEN3_1_7B_INST_Q4, QWEN3_600M_INST_Q4 } from '@qvac/sdk'

/** The two extraction models, cheapest first. */
export const LLM_MODELS = {
	fast: QWEN3_600M_INST_Q4,
	accurate: QWEN3_1_7B_INST_Q4,
}

export const DEFAULT_LLM = 'accurate'

const CTX_SIZE = 4096

/** @type {Map<string, {promise: Promise<string>, modelId: string|null, label: string, resident: boolean}>} */
const registry = new Map()

/**
 * Ensures one model is resident, loading it at most once.
 *
 * @param {string} key slot name, so different configs never collide
 * @param {object} spec passed straight to `loadModel`
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<string>} the model id
 */
export function ensureModel(key, spec, onProgress) {
	const existing = registry.get(key)
	if (existing) return existing.promise

	const entry = { promise: null, modelId: null, label: key, resident: false }
	registry.set(key, entry)

	entry.promise = (async () => {
		if (onProgress) onProgress(0)
		const modelId = await loadModel({ ...spec, onProgress: report(onProgress) })
		entry.modelId = modelId
		entry.resident = true
		if (onProgress) onProgress(100)
		return modelId
	})().catch((err) => {
		// A failed load must not poison the slot, or every later request fails
		// with a stale error instead of retrying.
		registry.delete(key)
		throw err
	})

	return entry.promise
}

function report(onProgress) {
	if (!onProgress) return undefined
	return (event) => {
		const pct = event?.percentage ?? event?.progress ?? 0
		onProgress(Math.max(0, Math.min(100, Math.round(pct))))
	}
}

/** Loads whichever extraction model the caller asked for. */
export function ensureLlm(quality, onProgress) {
	const key = `llm:${quality}`
	return ensureModel(
		key,
		{
			modelSrc: LLM_MODELS[quality] ?? LLM_MODELS[DEFAULT_LLM],
			modelConfig: { ctx_size: CTX_SIZE },
		},
		onProgress,
	)
}

export function isResident(key) {
	return registry.get(key)?.resident === true
}

/** Snapshot for the health endpoint and the UI's model list. */
export function residency() {
	return [...registry.entries()].map(([key, entry]) => ({
		key,
		modelId: entry.modelId,
		resident: entry.resident,
	}))
}

/** Frees everything. Called on shutdown and by the "release models" button. */
export async function releaseAll() {
	const entries = [...registry.entries()]
	registry.clear()
	for (const [, entry] of entries) {
		if (!entry.modelId) continue
		try {
			await unloadModel({ modelId: entry.modelId })
		} catch {
			// Already gone, or the worker died with it. Nothing useful to do.
		}
	}
}
