/**
 * Turning OCR text into a structured expense.
 *
 * Two independent things have to happen here, and keeping them separate is the
 * whole point of this file:
 *
 *   1. The model reads the receipt the way a person would - it works out which
 *      shop this was, which line is the total rather than the subtotal, what the
 *      items were, and how to bucket the spend. That is a judgement call, and it
 *      is what a 1-2B on-device model is genuinely useful for.
 *
 *   2. A plain regex then re-reads the raw OCR text and looks for the total
 *      itself. OCR is lossy, but the word TOTAL is short, high-contrast and
 *      repeated on every receipt, so a regex is often *more* reliable than a
 *      small model at finding that one number.
 *
 * When the two disagree we keep the regex number, because a wrong total is the
 * one field that has to be right in an expense log, and we surface the conflict
 * so the person scanning can see the model was unsure.
 */

export const CATEGORIES = [
	'food',
	'groceries',
	'transport',
	'shopping',
	'utilities',
	'health',
	'other',
]

/** Grammar handed to the engine, so the output is schema-valid by construction. */
export const RECEIPT_SCHEMA = {
	type: 'object',
	properties: {
		merchant: { type: 'string' },
		address: { type: 'string' },
		date_raw: { type: 'string' },
		date: { type: 'string' },
		subtotal: { type: 'number' },
		tax: { type: 'number' },
		total: { type: 'number' },
		currency: { type: 'string' },
		payment_method: { type: 'string' },
		category: { type: 'string', enum: CATEGORIES },
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					qty: { type: 'integer' },
					name: { type: 'string' },
					amount: { type: 'number' },
				},
				required: ['qty', 'name', 'amount'],
				additionalProperties: false,
			},
		},
	},
	required: [
		'merchant',
		'date_raw',
		'total',
		'currency',
		'payment_method',
		'category',
		'items',
	],
	additionalProperties: false,
}

const SYSTEM_PROMPT = [
	'You read receipt text produced by OCR and return the expense as JSON.',
	'',
	'Rules:',
	'- "total" is the amount actually charged, never the subtotal and never the tax.',
	'- If the total is not legible, use 0 rather than guessing.',
	'- "date_raw" is the date exactly as printed. "date" is the same date as YYYY-MM-DD,',
	'  or "" if the printed date is too damaged to be sure. If the day and month could',
	'  be swapped, still pick the most likely reading.',
	'- "currency" is the 3-letter code of the currency the total is printed in,',
	'  such as USD, EUR, IDR, GBP. A currency sign that appears next to a word',
	'  rather than next to a figure, such as the "Lane €" on a damaged receipt, is',
	'  usually OCR noise - ignore it and use the code implied by the amounts.',
	'- "items" lists each purchased line with its quantity and line amount.',
	'- Any string you are unsure about should be your best guess, not an empty string.',
	'/no_think',
].join('\n')

/** Builds the chat history for one receipt. */
export function buildPrompt(ocrText) {
	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Receipt text:\n"""\n${ocrText.trim()}\n"""\n\nReturn the JSON expense.`,
		},
	]
}

/**
 * Parses a number out of a noisy OCR string.
 *
 * Handles "$1,234.56", "1.234,56", "1 234.56", "29 .92" and "Rp 90.200" - the
 * last one matters because Indonesian and European receipts use "." as a
 * thousands separator, which a naive parseFloat reads as a decimal point.
 *
 * @returns {number|null} null when there is no number in there at all
 */
export function parseAmount(raw) {
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
	if (typeof raw !== 'string') return null

	// Keep digits, separators and a leading minus; drop currency symbols/letters.
	const cleaned = raw.replace(/[^\d.,\-]/g, '').replace(/(?!^)-/g, '')
	if (!/\d/.test(cleaned)) return null

	const negative = cleaned.startsWith('-')
	const body = cleaned.replace(/-/g, '')

	const lastSep = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','))
	let normalised
	if (lastSep === -1) {
		normalised = body
	} else {
		const tail = body.length - lastSep - 1
		const sepIsDecimal = tail > 0 && tail <= 2 && !body.slice(lastSep + 1).includes('.')
			&& !body.slice(lastSep + 1).includes(',')
		// "29.92" / "29,92" -> decimal. "1.234" / "90.200" -> thousands.
		normalised = sepIsDecimal
			? body.slice(0, lastSep).replace(/[.,]/g, '') + '.' + body.slice(lastSep + 1)
			: body.replace(/[.,]/g, '')
	}

	const value = Number.parseFloat(normalised)
	if (!Number.isFinite(value)) return null
	return negative ? -value : value
}

const CURRENCY_HINTS = [
	[/\b(?:rp|idr)\b|\brp\.?\s*\d/i, 'IDR'],
	[/\b(?:usd)\b|\$/, 'USD'],
	[/\b(?:eur)\b|€/i, 'EUR'],
	[/\b(?:gbp)\b|£/i, 'GBP'],
	[/\b(?:jpy)\b|¥/i, 'JPY'],
	[/\b(?:aud)\b|\ba\$/i, 'AUD'],
	[/\b(?:sgd)\b|\bs\$/i, 'SGD'],
	[/\b(?:myr)\b|\brm\b/i, 'MYR'],
]

/** Detects the currency from the raw text, falling back to whatever the model said. */
export function detectCurrency(ocrText, fallback = 'USD') {
	for (const [pattern, code] of CURRENCY_HINTS) {
		if (pattern.test(ocrText)) return code
	}
	const upper = String(fallback ?? '').toUpperCase()
	return /^[A-Z]{3}$/.test(upper) ? upper : 'USD'
}

/**
 * OCR routinely turns the leading T of TOTAL into a pipe, a 1 or a capital I,
 * and sometimes drops the crossbar so it reads as a zero. Matching on a fuzzy
 * keyword means we still find the total on a receipt where the recogniser was
 * unsure, without also matching words that merely end in "otal".
 */
const TOTAL_LINE = /(?:^|[\s|])(?:t|i|l|1|0|\|)otal\b|grand\s*total|amount\s*due|jumlah\s*total/i
const SUBTOTAL_LINE = /sub\s*total/i
/**
 * OCR drops the crossbar of the T often enough that "Tax" comes back as "lax"
 * or "1ax", and sometimes loses the letter outright and leaves "ax", so the
 * first character is optional.
 */
const TAX_LINE = /(?:^|[\s|])[t1l|i0]?ax\b|\bvat\b|\bppn\b|\bmwh\b/i
/** "Tax 8.8%" is a rate, not an amount. */
const AMOUNT_CANDIDATE = /(\d[\d.,\s]*\d|\d)(\s*%)?/g
/** How far below a bare label we will look for its amount. */
const AMOUNT_LOOKAHEAD = 2

/**
 * Finds labelled amounts in the OCR text.
 *
 * Two shapes matter in practice. Usually the label and the amount share a line
 * ("TOTAL 29.92"), but OCR often breaks thermal-print columns apart and emit
 * the label alone on one line with the figure on the next ("IOTAL" / "58 .25").
 * A label-only line therefore borrows from the lines below it, stopping at the
 * first blank line so an orphaned label never adopts a phone number.
 *
 * @param {string} ocrText
 * @param {(line: string) => boolean} accept which lines qualify
 * @returns {Array<{amount: number, line: string, lineIndex: number, source: 'same-line'|'next-line'}>}
 */
function findLabelledAmounts(ocrText, accept) {
	const lines = String(ocrText ?? '').split('\n')
	const found = []

	/** Right-most real amount on a line: receipt figures sit at the end. */
	const amountOn = (text) => {
		for (const match of [...text.matchAll(AMOUNT_CANDIDATE)].reverse()) {
			if (match[2]) continue // a percentage, not money
			const value = parseAmount(match[1])
			if (value !== null && value > 0) return value
		}
		return null
	}

	for (const [index, line] of lines.entries()) {
		if (!accept(line)) continue

		const onLine = amountOn(line)
		if (onLine !== null) {
			found.push({ amount: onLine, line: line.trim(), lineIndex: index, source: 'same-line' })
			continue
		}

		for (let ahead = 1; ahead <= AMOUNT_LOOKAHEAD; ahead++) {
			const next = lines[index + ahead]?.trim()
			if (!next) break
			const borrowed = amountOn(next)
			if (borrowed === null) continue
			found.push({
				amount: borrowed,
				line: `${line.trim()} ${next}`,
				lineIndex: index,
				source: 'next-line',
			})
			break
		}
	}
	return found
}

/**
 * Candidate totals, ignoring the subtotal.
 *
 * @returns {Array<{amount: number, line: string, lineIndex: number, source: string}>}
 */
export function findTotalsInText(ocrText) {
	return findLabelledAmounts(ocrText, (line) => !SUBTOTAL_LINE.test(line) && TOTAL_LINE.test(line))
}

/** Candidate subtotals. */
export function findSubtotalInText(ocrText) {
	return findLabelledAmounts(ocrText, (line) => SUBTOTAL_LINE.test(line))
}

/**
 * Candidate tax amounts, ignoring a "tax total" line so it is not mistaken for
 * the receipt total, and ignoring the rate.
 */
export function findTaxInText(ocrText) {
	return findLabelledAmounts(
		ocrText,
		(line) => TAX_LINE.test(line) && !SUBTOTAL_LINE.test(line) && !TOTAL_LINE.test(line),
	)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const PRINTED_DATE =
	/(?:\b(\d{4})-(\d{1,2})-(\d{1,2})\b)|(?:\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b)/g

/**
 * Best-effort ISO date.
 *
 * The model's own answer wins. Failing that we only accept a date we can read
 * out of the text *unambiguously* - a component above 12 can only be a day, so
 * 25/12 is safe. When both readings are possible, as in 12/03/2026, this returns
 * '' rather than guessing, and the UI shows the printed date instead. Silently
 * swapping day and month would put a wrong date in someone's expense log.
 *
 * The model's date string is scanned too, because small models often echo the
 * printed format back instead of the ISO one that was asked for.
 *
 * @returns {string} '' when the date is absent or ambiguous
 */
export function normaliseDate(isoCandidate, ocrText) {
	const iso = String(isoCandidate ?? '').trim().match(ISO_DATE)
	if (iso) return iso[0]

	for (const source of [isoCandidate, ocrText]) {
		for (const match of String(source ?? '').matchAll(PRINTED_DATE)) {
			const [whole, y1, m1, d1, a, b, y2] = match

			if (y1) {
				const year = Number(y1)
				const month = Number(m1)
				const day = Number(d1)
				if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return whole
				continue
			}

			const first = Number(a)
			const second = Number(b)
			let year = Number(y2)
			if (year < 100) year += 2000

			// Only commit when one component rules the other out.
			const day = first > 12 ? first : second > 12 ? second : null
			const month = first > 12 ? second : second > 12 ? first : null
			if (day === null || month === null) continue
			if (!(day >= 1 && day <= 31) || !(month >= 1 && month <= 12)) continue
			return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
		}
	}
	return ''
}

const CATEGORY_ALIASES = {
	food: 'food',
	restaurant: 'food',
	cafe: 'food',
	coffee: 'food',
	groceries: 'groceries',
	grocery: 'groceries',
	supermarket: 'groceries',
	market: 'groceries',
	transport: 'transport',
	taxi: 'transport',
	uber: 'transport',
	shopping: 'shopping',
	utilities: 'utilities',
	utility: 'utilities',
	health: 'health',
	pharmacy: 'health',
}

/** Coerces whatever the model produced into a valid category. */
export function normaliseCategory(value) {
	const key = String(value ?? '').trim().toLowerCase()
	if (CATEGORIES.includes(key)) return key
	return CATEGORY_ALIASES[key] ?? 'other'
}

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const asNumber = (value) => {
	const n = parseAmount(value)
	return n === null ? 0 : n
}

/** Pulls the first JSON object out of a model response, tolerating stray prose. */
export function extractJson(text) {
	const trimmed = String(text ?? '').trim()
	if (!trimmed) throw new Error('empty model response')
	try {
		return JSON.parse(trimmed)
	} catch {
		// Fall through to a brace-matching scan.
	}
	const start = trimmed.indexOf('{')
	if (start === -1) throw new Error('no JSON object in model response')
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < trimmed.length; i++) {
		const ch = trimmed[i]
		if (inString) {
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1))
		}
	}
	throw new Error('unterminated JSON object in model response')
}

/**
 * Reconciles the model's answer with the regex reading of the same text.
 *
 * @param {string} rawModelOutput raw text the model produced
 * @param {string} ocrText        reconstructed receipt text
 * @returns {object} a receipt, plus `provenance` describing who decided what
 */
export function buildReceipt(rawModelOutput, ocrText) {
	const model = extractJson(rawModelOutput)
	const candidates = findTotalsInText(ocrText)
	const modelTotal = asNumber(model.total)
	const regexTotal = candidates.length ? candidates[0].amount : null

	let total = modelTotal
	let totalSource = 'model'
	if (regexTotal !== null && (modelTotal === 0 || Math.abs(modelTotal - regexTotal) > 0.005)) {
		// The regex found a TOTAL line the model either missed or misread, so it
		// wins. A subtotal or a tax line is never a candidate by construction.
		total = regexTotal
		totalSource = 'regex'
	}

	// The model treats subtotal and tax as optional and often skips them even
	// when both are printed, so the printed lines fill the gaps.
	const modelSubtotal = asNumber(model.subtotal)
	const modelTax = asNumber(model.tax)
	const subtotals = findSubtotalInText(ocrText)
	const taxes = findTaxInText(ocrText)
	const subtotal = modelSubtotal || (subtotals.length ? subtotals[0].amount : 0)
	const tax = modelTax || (taxes.length ? taxes[0].amount : 0)

	const items = Array.isArray(model.items)
		? model.items
				.map((item) => ({
					qty: asNumber(item?.qty),
					name: asText(item?.name),
					amount: asNumber(item?.amount),
				}))
				.filter((item) => item.name || item.amount > 0)
		: []

	return {
		merchant: asText(model.merchant) || 'Unknown merchant',
		address: asText(model.address),
		date_raw: asText(model.date_raw),
		date: normaliseDate(model.date, ocrText),
		subtotal,
		tax,
		total,
		currency: detectCurrency(ocrText, model.currency),
		payment_method: asText(model.payment_method) || 'unknown',
		category: normaliseCategory(model.category),
		items,
		provenance: {
			totalSource,
			modelTotal,
			regexTotal,
			regexTotalLine: candidates[0]?.line ?? null,
			subtotalSource: modelSubtotal ? 'model' : subtotals.length ? 'regex' : 'none',
			taxSource: modelTax ? 'model' : taxes.length ? 'regex' : 'none',
			// Surfaced in the UI so a disagreement is visible instead of silent.
			disagreement:
				regexTotal !== null && modelTotal !== 0 && Math.abs(modelTotal - regexTotal) > 0.005,
		},
	}
}
