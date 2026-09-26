import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildReceipt,
	detectCurrency,
	extractJson,
	findSubtotalInText,
	findTaxInText,
	findTotalsInText,
	normaliseCategory,
	normaliseDate,
	parseAmount,
} from '../src/receipt.js'
import { blocksToLines, linesToText, meanConfidence } from '../src/ocr-lines.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const samples = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'samples',
)

test('parseAmount handles the separators real receipts use', () => {
	assert.equal(parseAmount('29.92'), 29.92)
	assert.equal(parseAmount('$1,234.56'), 1234.56)
	assert.equal(parseAmount('1.234,56'), 1234.56)
	assert.equal(parseAmount('29 .92'), 29.92, 'OCR splits the decimal point')
	assert.equal(parseAmount('90.200'), 90200, 'Indonesian thousands separator')
	assert.equal(parseAmount('1 234.56'), 1234.56)
	assert.equal(parseAmount('2.42'), 2.42)
	assert.equal(parseAmount('8 . 8%'), 8.8, 'percentages fall out as 8.8')
	assert.equal(parseAmount('****4412'), 4412, 'symbols around the digits are ignored')
	assert.equal(parseAmount('no digits here'), null)
	assert.equal(parseAmount(''), null)
	assert.equal(parseAmount(undefined), null)
})

test('findTotalsInText prefers a real TOTAL and never a subtotal', () => {
	const text = [
		'Subtotal   27.50',
		'Tax 8.8%   2.42',
		'TOTAL   29.92',
	].join('\n')
	const found = findTotalsInText(text)
	assert.equal(found.length, 1)
	assert.equal(found[0].amount, 29.92)
	assert.equal(found[0].line, 'TOTAL   29.92')
})

test('findTotalsInText survives OCR mangling the word TOTAL', () => {
	// The OCR stage reads a capital T as a pipe or a capital I often enough that
	// an exact-match parser would silently return nothing.
	for (const mangled of ['IOTAL   58.25', '|OTAL   58.25', '1OTAL  58.25', 'LOTAL 58.25']) {
		const found = findTotalsInText(mangled)
		assert.equal(found.length, 1, `no total found in ${JSON.stringify(mangled)}`)
		assert.equal(found[0].amount, 58.25)
	}
})

test('findTotalsInText picks the right-most number on the line', () => {
	const found = findTotalsInText('TOTAL  2 items  58.25')
	assert.equal(found[0].amount, 58.25)
})

test('findTotalsInText returns nothing when there is no total line', () => {
	assert.deepEqual(findTotalsInText('Thanks for shopping!\nCall us at 555-0142'), [])
})

test('findSubtotalInText and findTaxInText read the printed lines', () => {
	const text = [
		'Subtotal   27.50',
		'Tax 8 . 8%   2.42',
		'TOTAL   29.92',
	].join('\n')
	assert.equal(findSubtotalInText(text)[0].amount, 27.5)
	assert.equal(findTaxInText(text)[0].amount, 2.42)
	// A subtotal is never a candidate for the total.
	assert.equal(findTotalsInText(text).length, 1)
})

test('findTaxInText takes the amount and not the rate', () => {
	// "Tax 8.8%" with no amount on the line must not be read as a 8.8 tax.
	assert.deepEqual(findTaxInText('Tax 8.8%'), [])
	assert.deepEqual(findTaxInText('Sales tax 8.8%'), [])
	assert.equal(findTaxInText('Tax 8 . 8%   2.42')[0].amount, 2.42)
	assert.equal(findTaxInText('VAT 20%   1,200.00')[0].amount, 1200)
})

test('findTaxInText recognises tax when OCR drops the crossbar', () => {
	assert.equal(findTaxInText('ax 58.25')[0].amount, 58.25)
})

test('buildReceipt fills a subtotal and tax the model skipped', () => {
	const ocrText = 'BREW & CO.\nSubtotal   27.50\nTax 8 . 8%   2.42\nTOTAL   29.92'
	const raw = JSON.stringify({
		merchant: 'BREW & CO.',
		total: 29.92,
		currency: 'USD',
		category: 'food',
		items: [],
	})
	const receipt = buildReceipt(raw, ocrText)
	assert.equal(receipt.subtotal, 27.5)
	assert.equal(receipt.tax, 2.42)
	assert.equal(receipt.provenance.subtotalSource, 'regex')
	assert.equal(receipt.provenance.taxSource, 'regex')
})

test('buildReceipt prefers a subtotal the model did read', () => {
	const ocrText = 'Subtotal   27.50\nTOTAL   29.92'
	const raw = JSON.stringify({ subtotal: 27.5, tax: 2.42, total: 29.92, items: [] })
	const receipt = buildReceipt(raw, ocrText)
	assert.equal(receipt.subtotal, 27.5)
	assert.equal(receipt.tax, 2.42)
	assert.equal(receipt.provenance.taxSource, 'model')
})

test('findTotalsInText recovers a total that OCR split across two lines', () => {
	// Thermal-print columns routinely get separated by the recogniser, leaving
	// the label alone on one line and the figure on the next.
	const text = ['Subtotal   0.ee', 'IOTAL', '58 .25', 'VISA 0688.'].join('\n')
	const found = findTotalsInText(text)
	assert.equal(found.length, 1)
	assert.equal(found[0].amount, 58.25)
	assert.equal(found[0].source, 'next-line')
})

test('findTotalsInText does not reach past a blank line for a stray number', () => {
	const found = findTotalsInText('TOTAL\n\n555-0142')
	assert.deepEqual(found, [])
})

test('normaliseDate accepts the model answer and unambiguous text', () => {
	assert.equal(normaliseDate('2026-12-03', ''), '2026-12-03')
	assert.equal(normaliseDate('', '25/12/2026'), '2026-12-25')
	assert.equal(normaliseDate('', '03/25/2026'), '2026-03-25')
	assert.equal(normaliseDate('', '2026-03-12'), '2026-03-12')
	assert.equal(normaliseDate('', 'no date here'), '')
	assert.equal(normaliseDate('not-a-date', ''), '')
})

test('normaliseDate salvages a model that echoed the printed format back', () => {
	// Small models routinely ignore the "YYYY-MM-DD" instruction, so an
	// unambiguous printed date from the model is still worth keeping.
	assert.equal(normaliseDate('25/12/2026', 'Order A-2291  25/12/2026'), '2026-12-25')
	assert.equal(normaliseDate('03/25/2026', ''), '2026-03-25')
})

test('normaliseDate refuses to guess an ambiguous day/month order', () => {
	// 12/03/2026 is 3 December in the US and 12 March in most of the world.
	// Rather than coin-flip it into an expense log we return nothing and let the
	// UI show the printed date.
	assert.equal(normaliseDate('', 'Order A-2291   12/03/2026 09:41'), '')
})

test('normaliseCategory clamps anything unexpected to other', () => {
	assert.equal(normaliseCategory('groceries'), 'groceries')
	assert.equal(normaliseCategory('Supermarket'), 'groceries')
	assert.equal(normaliseCategory('coffee'), 'food')
	assert.equal(normaliseCategory('interpretive dance'), 'other')
	assert.equal(normaliseCategory(undefined), 'other')
})

test('detectCurrency reads symbols and codes out of the raw text', () => {
	assert.equal(detectCurrency('TOTAL 29.92'), 'USD', 'no symbol defaults to USD')
	assert.equal(detectCurrency('TOTAL 29.92', 'eur'), 'EUR')
	assert.equal(detectCurrency('TOTAL Rp 90.200'), 'IDR')
	assert.equal(detectCurrency('TOTAL 1.234,56 EUR'), 'EUR')
})

test('extractJson tolerates prose around the object', () => {
	assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
	assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps!'), { a: 1 })
	assert.deepEqual(extractJson('{"note":"a } brace","a":2}'), { note: 'a } brace', a: 2 })
	assert.throws(() => extractJson(''), /empty/)
	assert.throws(() => extractJson('no braces here'), /no JSON object/)
})

test('buildReceipt lets the regex overrule a model that missed the total', () => {
	const ocrText = 'BREW & CO.\nSubtotal   27.50\nTOTAL   29.92'
	const raw = JSON.stringify({
		merchant: 'BREW & CO.',
		date_raw: '12/03/2026',
		total: 27.5, // the model grabbed the subtotal
		currency: 'USD',
		payment_method: 'VISA',
		category: 'food',
		items: [{ qty: 2, name: 'Iced Vanilla Latte', amount: 13 }],
	})
	const receipt = buildReceipt(raw, ocrText)
	assert.equal(receipt.total, 29.92)
	assert.equal(receipt.provenance.totalSource, 'regex')
	assert.equal(receipt.provenance.disagreement, true)
	assert.equal(receipt.provenance.modelTotal, 27.5)
	assert.equal(receipt.provenance.regexTotal, 29.92)
})

test('buildReceipt keeps the model total when OCR has no total line at all', () => {
	const raw = JSON.stringify({
		merchant: 'Corner Store',
		total: 8.25,
		currency: 'USD',
		payment_method: 'cash',
		category: 'other',
		items: [],
	})
	const receipt = buildReceipt(raw, 'Corner Store\nThanks!')
	assert.equal(receipt.total, 8.25)
	assert.equal(receipt.provenance.totalSource, 'model')
	assert.equal(receipt.provenance.disagreement, false)
})

test('blocksToLines restores reading order and keeps column gaps', () => {
	// Two words on the left and one far to the right, on the same visual line.
	const blocks = [
		{ text: '29.92', bbox: [700, 100, 780, 130] },
		{ text: 'TOTAL', bbox: [30, 102, 120, 132] },
		{ text: 'ONLY', bbox: [135, 101, 200, 131] },
	]
	const lines = blocksToLines(blocks)
	assert.equal(lines.length, 1)
	assert.match(lines[0].text, /^TOTAL ONLY {3,}29\.92$/)
})

test('blocksToLines separates rows and averages confidence', () => {
	const blocks = [
		{ text: 'one', bbox: [0, 0, 40, 20], confidence: 1 },
		{ text: 'two', bbox: [50, 2, 90, 22], confidence: 0.5 },
		{ text: 'three', bbox: [0, 100, 60, 120], confidence: 0.8 },
	]
	const lines = blocksToLines(blocks)
	assert.equal(lines.length, 2)
	assert.equal(lines[0].text, 'one two')
	assert.equal(lines[0].confidence, 0.75)
	assert.equal(lines[1].text, 'three')
})

test('blocksToLines is defensive about junk input', () => {
	assert.deepEqual(blocksToLines([]), [])
	assert.deepEqual(blocksToLines(null), [])
	assert.deepEqual(blocksToLines([{ text: 'no bbox' }]), [])
	assert.deepEqual(blocksToLines([{ text: 'bad', bbox: [1, 2] }]), [])
	assert.ok(Math.abs(meanConfidence([{ confidence: 0.4 }, { confidence: 0.8 }]) - 0.6) < 1e-9)
	assert.equal(meanConfidence([{}]), null)
})

test('the checked-in OCR fixtures reconstruct into parseable text', () => {
	const text = fs.readFileSync(path.join(samples, 'ocr-coffee.txt'), 'utf8')
	assert.equal(linesToText(blocksToLines([])), '')
	// The two facts the parser depends on most must survive verbatim.
	assert.match(text, /TOTAL\s+29\.92/)
	assert.match(text, /VISA\s+\*\*\*\*4412/)
	assert.ok(findTotalsInText(text).length > 0, 'a total must be findable in the fixture')
})
