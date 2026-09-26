/**
 * StrukAI's local web server.
 *
 * Deliberately dependency-free and bound to loopback: the point of the app is
 * that a receipt photo never leaves the machine, and a server that other
 * people on the network can reach would undo that promise.
 *
 * The browser posts the raw image bytes rather than multipart/form-data, which
 * means there is no multipart parser to write, get wrong, or audit.
 */

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { scanReceipt } from './pipeline.js'
import { releaseAll, residency, DEFAULT_LLM } from './engine.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'src', 'public')
const samplesDir = path.join(root, 'samples')
const PORT = Number(process.env.PORT ?? 5173)
const HOST = '127.0.0.1'
const MAX_UPLOAD = 25 * 1024 * 1024

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
}

/** @type {Map<string, {id: string, status: string, result?: object, error?: string, clients: Set<http.ServerResponse>, done: boolean}>} */
const jobs = new Map()
const JOB_TTL_MS = 30 * 60 * 1000

function send(res, status, body, headers = {}) {
	const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	})
	res.end(payload)
}

/** Rejects anything that escapes its directory. */
function safeJoin(base, requested) {
	const target = path.resolve(base, `.${path.posix.normalize(`/${requested}`)}`)
	if (target !== base && !target.startsWith(base + path.sep)) return null
	return target
}

async function serveStatic(res, urlPath) {
	const rel = urlPath === '/' ? '/index.html' : urlPath
	const file = safeJoin(publicDir, rel)
	if (!file) return send(res, 403, { error: 'forbidden' })

	try {
		const body = await fsp.readFile(file)
		res.writeHead(200, {
			'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
			'cache-control': 'no-store',
		})
		res.end(body)
	} catch {
		send(res, 404, { error: 'not found' })
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_UPLOAD) {
				reject(Object.assign(new Error('image too large'), { status: 413 }))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks)))
		req.on('error', reject)
	})
}

function emit(job, event, data) {
	const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
	for (const client of job.clients) client.write(frame)
}

function sweepJobs() {
	const cutoff = Date.now() - JOB_TTL_MS
	for (const [id, job] of jobs) {
		if (job.done && Date.parse(job.finishedAt ?? 0) < cutoff) jobs.delete(id)
	}
}

/** Only one scan at a time: two concurrent scans would fight over the GPU. */
let activeJob = null

/** Registers a job and returns it without starting any work yet. */
function createJob({ enhance, quality }) {
	const job = { id: randomUUID(), status: 'queued', clients: new Set(), done: false, enhance, quality }
	jobs.set(job.id, job)
	activeJob = job
	return job
}

/** Runs the scan in the background so the response can return a job id first. */
async function runJob(job, image) {
	try {
		const result = await scanReceipt({
			image,
			enhance: job.enhance,
			quality: job.quality,
			onProgress: (progress) => {
				job.status = progress.stage
				emit(job, 'progress', progress)
			},
		})
		job.result = result
		emit(job, 'result', result)
	} catch (err) {
		console.error(err)
		job.error = err.message ?? 'scan failed'
		emit(job, 'error', { error: job.error, stage: err.stage ?? null })
	} finally {
		job.done = true
		job.finishedAt = new Date().toISOString()
		emit(job, 'end', { id: job.id, ok: !job.error })
		if (activeJob === job) activeJob = null
	}
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${HOST}:${PORT}`)
	const { pathname } = url

	try {
		if (req.method === 'GET' && pathname === '/api/health') {
			return send(res, 200, {
				ok: true,
				defaultQuality: DEFAULT_LLM,
				resident: residency(),
				jobs: jobs.size,
			})
		}

		if (req.method === 'GET' && pathname === '/api/samples') {
			const files = await fsp.readdir(samplesDir)
			return send(res, 200, {
				samples: files
					.filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
					.map((name) => ({ name, url: `/samples/${name}` })),
			})
		}

		// Sample receipts are served from the repo so the demo is one click and
		// does not depend on the user having a photo to hand.
		if (req.method === 'GET' && pathname.startsWith('/samples/')) {
			const file = safeJoin(samplesDir, pathname.slice('/samples'.length))
			if (!file) return send(res, 403, { error: 'forbidden' })
			try {
				const body = await fsp.readFile(file)
				res.writeHead(200, {
					'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
					'cache-control': 'no-store',
				})
				return res.end(body)
			} catch {
				return send(res, 404, { error: 'not found' })
			}
		}

		if (req.method === 'POST' && pathname === '/api/scan') {
			if (activeJob && !activeJob.done) {
				return send(res, 409, { error: 'a scan is already running' })
			}

			const body = await readBody(req)
			if (!body.length) return send(res, 400, { error: 'empty body' })

			const enhance = url.searchParams.get('enhance') === '1'
			const quality = url.searchParams.get('quality') === 'fast' ? 'fast' : DEFAULT_LLM

			// The id comes back before the scan starts so the browser can open the
			// event stream and watch progress instead of staring at a spinner.
			const job = createJob({ enhance, quality })
			runJob(job, body)

			return send(res, 202, { jobId: job.id })
		}

		const events = pathname.match(/^\/api\/jobs\/([\w-]+)\/events$/)
		if (req.method === 'GET' && events) {
			const job = jobs.get(events[1])
			if (!job) return send(res, 404, { error: 'unknown job' })

			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
			})
			res.write('retry: 2000\n\n')
			job.clients.add(res)
			req.on('close', () => job.clients.delete(res))

			// A client that connects after the scan finished still needs the
			// result, otherwise a fast scan looks like an empty one.
			if (job.done) {
				if (job.error) {
					res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`)
				} else {
					res.write(`event: result\ndata: ${JSON.stringify(job.result ?? null)}\n\n`)
				}
				res.write(`event: end\ndata: ${JSON.stringify({ id: job.id, ok: !job.error })}\n\n`)
				res.end()
			}
			return
		}

		if (req.method === 'POST' && pathname === '/api/release') {
			await releaseAll()
			return send(res, 200, { released: true })
		}

		if (req.method === 'GET') return serveStatic(res, pathname)

		return send(res, 405, { error: 'method not allowed' })
	} catch (err) {
		const status = err.status ?? 500
		if (status >= 500) console.error(err)
		send(res, status, { error: err.message ?? 'internal error' })
	}
})

sweepJobs()
setInterval(sweepJobs, JOB_TTL_MS).unref()

server.listen(PORT, HOST, () => {
	console.log(`StrukAI on http://${HOST}:${PORT}`)
	console.log(`  samples: ${fs.existsSync(samplesDir) ? samplesDir : 'none'}`)
})

let closing = false
async function shutdown() {
	if (closing) return
	closing = true
	console.log('\nreleasing models...')
	server.close()
	await releaseAll()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
