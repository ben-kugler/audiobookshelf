const fs = require('fs')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const Logger = require('../Logger')

function extractToken(resp) {
  if (typeof resp === 'string' && resp.length) return resp
  if (resp && typeof resp === 'object') {
    if (resp.token) return resp.token
    if (resp.access_token) return resp.access_token
  }
  throw new Error('Storyteller: could not parse auth token from response')
}

function extractBookUuid(resp) {
  if (resp && resp.epub2Detected) {
    throw new Error('Storyteller: EPUB2 detected and not auto-converted; pass epub2Strategy')
  }
  if (resp && typeof resp === 'object') {
    if (resp.bookUuid) return resp.bookUuid
    if (resp.uuid) return resp.uuid
    if (Array.isArray(resp.books) && resp.books[0]?.uuid) return resp.books[0].uuid
  }
  throw new Error(`Storyteller: could not parse book uuid from create response: ${JSON.stringify(resp)}`)
}

class StorytellerClient {
  constructor({ url, username, password }) {
    if (!url) throw new Error('Storyteller: url is required')
    this.baseUrl = url.replace(/\/$/, '')
    this.username = username
    this.password = password
    this.token = null
  }

  authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  async authenticate() {
    const body = new URLSearchParams({ username: this.username || '', password: this.password || '' })
    const res = await fetch(`${this.baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!res.ok) throw new Error(`Storyteller auth failed: ${res.status}`)
    const data = await res.json().catch(() => null)
    this.token = extractToken(data)
  }

  async createBookByPaths(paths) {
    const res = await fetch(`${this.baseUrl}/api/v2/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ paths, importMode: 'reference', epub2Strategy: 'backup-and-convert' })
    })
    if (!res.ok) throw new Error(`Storyteller create failed: ${res.status}`)
    return extractBookUuid(await res.json())
  }

  async startProcessing(bookUuid) {
    const res = await fetch(`${this.baseUrl}/api/v2/books/${bookUuid}/process`, {
      method: 'POST',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new Error(`Storyteller process start failed: ${res.status}`)
  }

  async getBook(bookUuid) {
    const res = await fetch(`${this.baseUrl}/api/v2/books/${bookUuid}`, { headers: this.authHeaders() })
    if (!res.ok) throw new Error(`Storyteller get book failed: ${res.status}`)
    return res.json()
  }

  async waitForAligned(bookUuid, { timeoutMs = 1000 * 60 * 60 * 24, intervalMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs
    // ponytail: poll readaloud.filepath with a timeout; upgrade to SSE /api/v2/books/events for live progress
    while (Date.now() < deadline) {
      const book = await this.getBook(bookUuid).catch((e) => { Logger.warn(`[Storyteller] poll error: ${e.message}`); return null })
      if (book?.readaloud?.filepath) return
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error('Storyteller: alignment timed out')
  }

  async downloadSynced(bookUuid, destPath) {
    const res = await fetch(`${this.baseUrl}/api/books/${bookUuid}/synced`, { headers: this.authHeaders() })
    if (!res.ok || !res.body) throw new Error(`Storyteller download failed: ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath))
  }
}

module.exports = StorytellerClient
module.exports.StorytellerClient = StorytellerClient
module.exports.extractToken = extractToken
module.exports.extractBookUuid = extractBookUuid
