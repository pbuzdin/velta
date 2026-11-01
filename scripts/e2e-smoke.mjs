#!/usr/bin/env node
// Real-browser smoke: demo boot, open a chat, send a message, no JS errors.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const file = join(appRoot, path || 'index.html')
  if (!file.startsWith(appRoot) || !existsSync(file)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    const url = message.location().url
    // Boot deliberately probes the native blob scheme and optional version.txt.
    const expectedProbe = url === 'blobfile://localhost/__velta-probe' || /\/version\.txt$/.test(url)
    if (message.type() === 'error' && !expectedProbe) errors.push(`${message.text()} (${url})`)
  })
  await page.addInitScript(() => localStorage.setItem('velta-mock', '1'))
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await page.locator('.chat-item', { hasText: 'Ada Byron' }).first().click({ timeout: 15000 })
  await page.locator('#chat-view').waitFor({ state: 'visible' })
  const text = `Browser smoke ${Date.now()}`
  await page.locator('#composer-input').fill(text)
  await page.locator('#btn-send').click()
  await page.locator('.msg-row .msg-text').filter({ hasText: text }).last().waitFor({ timeout: 5000 })
  assert.equal(await page.locator('#composer-input').inputValue(), '')
  assert.deepEqual(errors, [])
  console.log('OK: demo boot, chat open, message send, no unexpected browser errors')
} finally {
  await browser.close()
  server.close()
}
