/**
 * End-to-end check against a running server, over HTTP, exactly the way the
 * browser does it. This is the test that proves the whole thing works: upload,
 * OCR, classify, extraction, and the event stream the UI depends on.
 *
 *   npm start                       # in one terminal
 *   node scripts/e2e.mjs            # in another
 *   node scripts/e2e.mjs --enhance  # includes the slow upscale path
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.STRUKAI_URL ?? 'http://127.0.0.1:5173'
const enhance = process.argv.includes('--enhance')
const quality = process.argv.includes('--fast') ? 'fast' : 'accurate'
const sample = process.argv.find((a) => a.endsWith('.png')) ?? 'receipt-coffee.png'

const health = await fetch(`${base}/api/health`).then((r) => r.json())
if (!health.ok) throw new Error('server is not healthy')
console.log(`server ok, default quality ${health.defaultQuality}`)

const image = fs.readFileSync(path.join(root, 'samples', sample))
console.log(`scanning ${sample} (${(image.length / 1024) | 0} KB), quality=${quality}, enhance=${enhance}\n`)

const query = new URLSearchParams({ quality, enhance: enhance ? '1' : '0' })
const started = await fetch(`${base}/api/scan?${query}`, {
	method: 'POST',
	headers: { 'content-type': 'application/octet-stream' },
	body: image,
})

if (started.status !== 202) {
	throw new Error(`upload rejected (${started.status}): ${await started.text()}`)
}
const { jobId } = await started.json()
console.log(`job ${jobId}\n`)

const res = await fetch(`${base}/api/jobs/${jobId}/events`)
if (!res.ok) throw new Error(`event stream refused (${res.status})`)

let done = false
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (!done) {
	const { value, done: closed } = await reader.read()
	if (closed) break
	buffer += decoder.decode(value, { stream: true })

	let split
	while ((split = buffer.indexOf('\n\n')) !== -1) {
		const frame = buffer.slice(0, split)
		buffer = buffer.slice(split + 2)

		const event = frame.match(/^event: (.+)$/m)?.[1]
		const raw = frame.match(/^data: (.+)$/m)?.[1]
		if (!event || !raw) continue
		const data = JSON.parse(raw)

		if (event === 'progress') {
			process.stdout.write(`  [${String(data.pct).padStart(3)}%] ${data.message}\n`)
		} else if (event === 'result') {
			console.log('\n--- receipt ---')
			console.log(JSON.stringify(data.receipt, null, 2))
			console.log('\n--- diagnostics ---')
			console.log(
				JSON.stringify(
					{ ...data.diagnostics, labels: data.diagnostics.labels?.slice(0, 3) },
					null,
					2,
				),
			)
			if (data.parseError) console.log(`\nparse error: ${data.parseError}`)
		} else if (event === 'error') {
			throw new Error(`scan failed at "${data.stage}": ${data.error}`)
		} else if (event === 'end') {
			done = true
		}
	}
}

console.log('\ne2e ok')

// The QVAC native worker keeps handles open, so Node would sit there for
// minutes after the run had already succeeded. Exit deliberately instead.
process.exit(0)
