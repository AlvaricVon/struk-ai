/**
 * Rebuilds readable text lines from the word-level boxes the OCR stage returns.
 *
 * The OCR engine hands back one box per *word* with a bounding box
 * ([x1, y1, x2, y2]), in no guaranteed reading order. A receipt is a
 * two-column layout though - "ITEM" on the left, "AMOUNT" on the right - and
 * that column structure is exactly what a parser needs in order to tell
 * "Iced Vanilla Latte 13.00" apart from two unrelated numbers.
 *
 * So we do two things:
 *   1. group boxes into lines by vertical overlap, then sort each line left to
 *      right, which restores reading order;
 *   2. keep horizontal *gaps* as wide runs of spaces instead of collapsing
 *      them, so the column split survives into the text we hand to the model.
 */

/** Words closer than this (as a multiple of the median glyph width) are one word. */
const SPACE_RATIO = 0.9
/** A gap wider than this many "spaces" is treated as a column break. */
const COLUMN_GAP_SPACES = 3

function median(values) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Normalises a box into { left, top, right, bottom, midY, midX, height }. */
function toBox(block) {
	const raw = Array.isArray(block.bbox) ? block.bbox : null
	if (!raw || raw.length < 4 || raw.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
		return null
	}
	const [left, top, right, bottom] = raw
	return {
		text: String(block.text ?? '').trim(),
		left: Math.min(left, right),
		right: Math.max(left, right),
		top: Math.min(top, bottom),
		bottom: Math.max(top, bottom),
		midX: (left + right) / 2,
		midY: (top + bottom) / 2,
		height: Math.abs(bottom - top),
		confidence: typeof block.confidence === 'number' ? block.confidence : null,
	}
}

/**
 * Groups word boxes into text lines.
 *
 * @param {Array<{text: string, bbox?: number[], confidence?: number}>} blocks
 * @returns {Array<{text: string, confidence: number|null, words: number}>}
 */
export function blocksToLines(blocks) {
	const boxes = (blocks ?? [])
		.map(toBox)
		.filter((b) => b && b.text.length > 0)
		.sort((a, b) => a.midY - b.midY || a.left - b.left)

	if (boxes.length === 0) return []

	// Typical glyph height gives us the tolerance for "same line" and the
	// reference width for judging gaps.
	const glyphWidth = median(
		boxes.map((b) => (b.right - b.left) / Math.max(1, b.text.length)),
	)
	const lineTolerance = Math.max(4, median(boxes.map((b) => b.height)) * 0.55)

	/** @type {Array<{midY: number, boxes: object[]}>} */
	const lines = []
	for (const box of boxes) {
		// Attach to the closest existing line whose band still covers this box.
		let target = null
		let bestDelta = Infinity
		for (const line of lines) {
			const delta = Math.abs(line.midY - box.midY)
			if (delta <= lineTolerance && delta < bestDelta) {
				target = line
				bestDelta = delta
			}
		}
		if (target) {
			target.boxes.push(box)
			// Running mean keeps the anchor centred as the line fills up.
			target.midY =
				(target.midY * (target.boxes.length - 1) + box.midY) / target.boxes.length
		} else {
			lines.push({ midY: box.midY, boxes: [box] })
		}
	}

	return lines
		.sort((a, b) => a.midY - b.midY)
		.map((line) => {
			line.boxes.sort((a, b) => a.left - b.left)

			let text = ''
			let previous = null
			for (const box of line.boxes) {
				if (previous) {
					const gap = box.left - previous.right
					// A big horizontal jump means we crossed into another column;
					// preserve it so the model can see the layout.
					const spaces =
						gap > glyphWidth * SPACE_RATIO * COLUMN_GAP_SPACES
							? ' '.repeat(COLUMN_GAP_SPACES)
							: ' '
					text += spaces
				}
				text += box.text
				previous = box
			}

			const confidences = line.boxes
				.map((b) => b.confidence)
				.filter((c) => typeof c === 'number')
			const confidence = confidences.length
				? confidences.reduce((a, b) => a + b, 0) / confidences.length
				: null

			return {
				text: text.replace(/\s+$/, ''),
				confidence,
				words: line.boxes.length,
			}
		})
		.filter((line) => line.text.trim().length > 0)
}

/** Joins reconstructed lines into the single blob of text the model reads. */
export function linesToText(lines) {
	return lines.map((l) => l.text).join('\n')
}

/** Mean confidence across all recognised words, or null when none reported any. */
export function meanConfidence(blocks) {
	const values = (blocks ?? [])
		.map((b) => b.confidence)
		.filter((c) => typeof c === 'number')
	if (!values.length) return null
	return values.reduce((a, b) => a + b, 0) / values.length
}
