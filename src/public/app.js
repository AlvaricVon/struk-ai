const $ = (id) => document.getElementById(id)
const els = {
	dropzone: $('dropzone'),
	preview: $('preview'),
	enhance: $('enhance'),
	quality: $('quality'),
	samples: $('sample-buttons'),
	scan: $('scan'),
	progressWrap: $('progress-wrap'),
	bar: $('bar-fill'),
	progressText: $('progress-text'),
	error: $('error'),
	result: $('result'),
	merchant: $('merchant'),
	address: $('address'),
	total: $('total'),
	currency: $('currency'),
	date: $('date'),
	category: $('category'),
	payment: $('payment'),
	confidence: $('confidence'),
	provenance: $('provenance'),
	items: $('items'),
	itemSum: $('item-sum'),
	rawWrap: $('raw-wrap'),
	rawText: $('raw-text'),
	rawModel: $('raw-model'),
	timings: $('timings'),
	resident: $('resident'),
	devicePill: $('device-pill'),
}

let picked = null
let stream = null

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const pct = (n) => (n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`)

function showError(message) {
	els.error.textContent = message
	els.error.hidden = !message
}

function setBusy(busy) {
	els.scan.disabled = busy || !picked
	els.scan.textContent = busy ? 'Scanning…' : 'Scan receipt'
	els.progressWrap.hidden = !busy
	if (busy) {
		els.result.hidden = true
		showError('')
		els.bar.style.width = '2%'
		els.progressText.textContent = 'Starting…'
	}
}

/** Sniffs the container rather than trusting the file extension or MIME type. */
function looksLikeImage(bytes) {
	if (bytes.length < 12) return false
	const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end))
	return (
		(bytes[0] === 0x89 && ascii(1, 4) === 'PNG') ||
		(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
		(ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
	)
}

/** One place to accept a file, so every entry point behaves the same. */
async function accept(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	if (!looksLikeImage(bytes)) {
		showError('That does not look like a PNG, JPEG or WebP image.')
		return
	}
	picked = blob
	els.preview.src = URL.createObjectURL(blob)
	els.preview.hidden = false
	els.scan.disabled = false
	els.result.hidden = true
	els.provenance.hidden = true
	showError('')
}

els.dropzone.addEventListener('click', () => {
	const input = document.createElement('input')
	input.type = 'file'
	input.accept = 'image/*'
	input.addEventListener('change', () => {
		const file = input.files?.[0]
		if (file) accept(file)
	})
	input.click()
})

els.dropzone.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' || e.key === ' ') {
		e.preventDefault()
		els.dropzone.click()
	}
})

for (const type of ['dragenter', 'dragover']) {
	els.dropzone.addEventListener(type, (e) => {
		e.preventDefault()
		els.dropzone.classList.add('over')
	})
}
for (const type of ['dragleave', 'drop']) {
	els.dropzone.addEventListener(type, () => els.dropzone.classList.remove('over'))
}
els.dropzone.addEventListener('drop', (e) => {
	e.preventDefault()
	const file = e.dataTransfer?.files?.[0]
	if (file) accept(file)
})

function money(value, currency) {
	if (value === null || value === undefined) return '—'
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(value)
	} catch {
		return `${value.toFixed(2)} ${currency ?? ''}`.trim()
	}
}

function renderReceipt(payload) {
	const { receipt, diagnostics, rawText, rawModelOutput, parseError } = payload
	if (!receipt) {
		showError(parseError ?? 'The model did not return a usable record.')
		els.rawText.textContent = rawText ?? ''
		els.rawModel.textContent = rawModelOutput ?? ''
		els.result.hidden = false
		return
	}

	els.merchant.textContent = receipt.merchant || 'Unknown merchant'
	els.address.textContent = receipt.address || ''
	els.total.textContent = money(receipt.total, receipt.currency)
	els.currency.textContent = receipt.currency || ''
	els.date.textContent = receipt.date || receipt.date_raw || 'Not legible'
	els.category.textContent = receipt.category
	els.payment.textContent = receipt.payment_method || 'Unknown'

	const ocr = diagnostics.ocrConfidence
	els.confidence.textContent = diagnostics.shaky ? `${pct(ocr)} · low` : pct(ocr)

	const p = receipt.provenance
	if (p?.disagreement) {
		els.provenance.hidden = false
		els.provenance.textContent = `The model read the total as ${p.modelTotal}, but the receipt line "${p.regexTotalLine}" says ${p.regexTotal}. Showing the printed figure.`
	} else if (p?.totalSource) {
		els.provenance.hidden = false
		els.provenance.textContent = `Total taken from the ${p.totalSource === 'regex' ? 'printed receipt line' : 'model'}.`
	}

	const body = els.items.querySelector('tbody')
	body.replaceChildren()
	let sum = 0
	for (const item of receipt.items ?? []) {
		const row = document.createElement('tr')
		for (const value of [item.qty ?? '', item.name ?? '', money(item.amount, receipt.currency)]) {
			const cell = document.createElement('td')
			cell.textContent = String(value)
			row.append(cell)
		}
		row.lastElementChild.classList.add('right')
		body.append(row)
		if (typeof item.amount === 'number') sum += item.amount
	}
	els.items.hidden = (receipt.items ?? []).length === 0
	els.itemSum.textContent = (receipt.items ?? []).length ? money(sum, receipt.currency) : ''

	els.rawText.textContent = rawText ?? ''
	els.rawModel.textContent = rawModelOutput ?? ''
	els.timings.textContent = JSON.stringify(diagnostics.timings, null, 2)
	els.result.hidden = false
}

els.scan.addEventListener('click', async () => {
	if (!picked) return
	setBusy(true)
	els.provenance.hidden = true

	const query = new URLSearchParams({
		quality: els.quality.value,
		enhance: els.enhance.checked ? '1' : '0',
	})

	let started
	try {
		started = await fetch(`/api/scan?${query}`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: picked,
		})
	} catch (err) {
		setBusy(false)
		return showError(`Could not reach the local server: ${err.message}`)
	}

	if (!started.ok) {
		const body = await started.json().catch(() => ({}))
		setBusy(false)
		return showError(body.error ?? `Upload failed (${started.status})`)
	}

	const { jobId } = await started.json()
	stream?.close()
	stream = new EventSource(`/api/jobs/${jobId}/events`)

	stream.addEventListener('progress', (e) => {
		const { message, pct: value } = JSON.parse(e.data)
		els.bar.style.width = `${Math.max(2, value)}%`
		// Downloads and cached loads report the same step several times; only the
		// bar needs to move, not the label.
		if (els.progressText.textContent !== message) els.progressText.textContent = message
	})
	stream.addEventListener('result', (e) => {
		renderReceipt(JSON.parse(e.data))
		els.bar.style.width = '100%'
	})
	stream.addEventListener('error', (e) => {
		try {
			showError(JSON.parse(e.data).error)
		} catch {
			showError('The scan failed.')
		}
	})
	stream.addEventListener('end', () => {
		stream?.close()
		stream = null
		setBusy(false)
		refreshHealth()
	})
	stream.onerror = () => {
		// EventSource retries forever on its own; a dead scan would hang the
		// button, so report it once and let the user decide.
		if (stream?.readyState === EventSource.CLOSED) {
			stream = null
			setBusy(false)
			showError('Lost connection to the local server.')
		}
	}
})

async function refreshHealth() {
	try {
		const health = await (await fetch('/api/health')).json()
		els.devicePill.textContent = 'running fully on-device'
		els.resident.textContent = health.resident.length
			? `Models in memory: ${health.resident.map((m) => m.key).join(', ')}`
			: 'No models loaded yet.'
	} catch {
		els.devicePill.textContent = 'server not reachable'
	}
}

async function loadSamples() {
	try {
		const { samples } = await (await fetch('/api/samples')).json()
		for (const sample of samples) {
			const chip = document.createElement('button')
			chip.className = 'chip'
			chip.textContent = sample.name.replace(/\.\w+$/, '').replace(/[-_]/g, ' ')
			chip.addEventListener('click', async () => {
				const blob = await (await fetch(sample.url)).blob()
				picked = blob
				els.preview.src = sample.url
				els.preview.hidden = false
				els.scan.disabled = false
				els.result.hidden = true
				els.provenance.hidden = true
				showError('')
			})
			els.samples.append(chip)
		}
	} catch {
		// Samples are a convenience; the upload path still works without them.
	}
}

/**
 * `?scan=receipt-coffee.png` loads one of the bundled samples and starts it,
 * so the app can be demoed or recorded without anyone touching the mouse.
 */
async function autoScan() {
	const wanted = new URLSearchParams(location.search).get('scan')
	if (!wanted) return

	try {
		const blob = await (await fetch(`/samples/${encodeURIComponent(wanted)}`)).blob()
		await accept(blob)
		els.scan.click()
	} catch {
		showError(`Could not load the sample "${wanted}".`)
	}
}

refreshHealth()
loadSamples()
autoScan()
