#!/usr/bin/env node
// Live one-tap verification with the real wasm core, a configured proxy and a
// short-lived /pwa invite. Requires INVITE_FILE, TLS_KEY, TLS_CERT,
// EXPECTED_PROXY_URL and EXPECTED_RELAY_HOST. Secrets are never printed.
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

for (const key of ['INVITE_FILE', 'TLS_KEY', 'TLS_CERT', 'EXPECTED_PROXY_URL', 'EXPECTED_RELAY_HOST']) {
  if (!process.env[key]) throw new Error(`${key} is required`)
}
const inviteText = readFileSync(process.env.INVITE_FILE, 'utf8')
const inviteUrl = inviteText.match(/https:\/\/velta\.cc\/web\?invite=[^\s]+/)?.[0]
if (!inviteUrl) throw new Error('No PWA invitation URL in INVITE_FILE')
const token = new URL(inviteUrl).searchParams.get('invite')
const expectedProxyUrl = process.env.EXPECTED_PROXY_URL
const expectedProxyHost = new URL(expectedProxyUrl).hostname
if (new URL(expectedProxyUrl).protocol !== 'wss:') throw new Error('EXPECTED_PROXY_URL must use wss:')
const expectedRelayHost = process.env.EXPECTED_RELAY_HOST.toLowerCase().replace(/\.$/, '')
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(repoRoot, 'build/dist-pwa')
const mimes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.woff2': 'font/woff2',
}
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}
const files = new Map()
for (const p of walk(root)) files.set('/' + relative(root, p).replaceAll('\\', '/'), readFileSync(p))
const server = createServer({ key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) }, (req, res) => {
  const url = new URL(req.url, 'https://velta.cc')
  if (url.pathname === '/web') {
    res.writeHead(308, { location: '/web/' + url.search })
    res.end()
    return
  }
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/web/') pathname = '/web/index.html'
  if (!pathname.startsWith('/web/')) { res.writeHead(404); res.end('not found'); return }
  const body = files.get(pathname.slice(4))
  if (body == null) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': mimes[extname(pathname)] ?? 'application/octet-stream' })
  res.end(body)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(443, '127.0.0.1', resolve)
})

const options = { headless: true, args: ['--host-resolver-rules=MAP velta.cc 127.0.0.1'] }
if (process.env.CHROMIUM_BIN) options.executablePath = process.env.CHROMIUM_BIN
const browser = await chromium.launch(options)
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const errors = []
const consoleTail = []
page.on('pageerror', e => errors.push(e.message.replaceAll(token, 'REDACTED')))
page.on('console', m => {
  if (m.type() === 'error' || m.type() === 'warning' || /configure|onboard|failed|error|relay|transport/i.test(m.text())) {
    consoleTail.push(`${m.type()}: ${m.text()}`.replaceAll(token, 'REDACTED'))
    if (consoleTail.length > 60) consoleTail.shift()
  }
})
try {
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForURL(url => !url.searchParams.has('invite') && !url.searchParams.has('r'), { timeout: 30_000 })
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('Account ready:') || text.includes('Automatic setup failed:')
  }, null, { timeout: 240_000 })
  if (await page.locator('body').innerText().then(text => text.includes('Automatic setup failed:'))) {
    const messages = await page.evaluate(() => window.__veltaDiagnostics?.messages?.map(m => `${m.level}: ${m.message}`) || [])
    throw new Error(`Automatic setup failed; diagnostics: ${messages.slice(-20).join(' | ')}`)
  }
  const result = await page.evaluate(({ proxyHost, relayHost }) => {
    const text = document.body.innerText
    const ready = text.match(/Account ready:\s*([^\s]+)/)?.[1] || ''
    return {
      readyOnExpectedRelay: ready.endsWith(`@${relayHost}`),
      active: localStorage.getItem('velta-ws-relay'),
      proxy: JSON.parse(localStorage.getItem('velta-ws-relay-urls') || '{}')[proxyHost],
      tokenInstalled: !!JSON.parse(localStorage.getItem('velta-ws-relay-tokens') || '{}')[proxyHost],
      pending: sessionStorage.getItem('velta-pwa-onboarding'),
      nickname: text.includes('How should we call you?'),
      splashVisible: !!document.querySelector('#splash')?.checkVisibility(),
    }
  }, { proxyHost: expectedProxyHost, relayHost: expectedRelayHost })
  assert.equal(result.readyOnExpectedRelay, true, 'configured account is on the expected relay')
  assert.equal(result.active, expectedProxyHost)
  assert.equal(result.proxy, expectedProxyUrl)
  assert.equal(result.tokenInstalled, true)
  assert.equal(result.pending, null)
  assert.equal(result.nickname, false)
  assert.equal(result.splashVisible, false)
  assert.deepEqual(errors, [])
  const configuredAfterReload = page.waitForEvent('console', {
    predicate: m => m.text().includes('[velta] boot: account ') && m.text().includes(`@${expectedRelayHost}`) && m.text().includes('configured=true'),
    timeout: 120_000,
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })
  await configuredAfterReload
  await page.waitForFunction(() => !document.querySelector('#splash')?.checkVisibility())
  assert.equal(await page.evaluate(() => sessionStorage.getItem('velta-pwa-onboarding')), null)
  assert.equal(await page.locator('body').innerText().then(text => text.includes('How should we call you?')), false)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/velta-live-onboarding.png', fullPage: true })
  console.log('PASS: live /pwa invite created a real Chatmail profile through the configured proxy')
  console.log('PASS: URL scrubbed, full-path token installed, one-tap UI reached without nickname or setup screens')
  console.log('PASS: configured profile restored from browser storage after reload')
} catch (e) {
  const clean = value => String(value).replaceAll(token, 'REDACTED').replace(/[\w.+-]+@[\w.-]+/g, 'REDACTED-ADDRESS')
  console.error('FAIL:', clean(e.message || e))
  if (errors.length) console.error('Browser errors:', errors.map(clean).join('; '))
  const state = await page.evaluate(() => ({
    href: location.href,
    pending: sessionStorage.getItem('velta-pwa-onboarding'),
    active: localStorage.getItem('velta-ws-relay'),
    urls: localStorage.getItem('velta-ws-relay-urls'),
    body: document.body.innerText.slice(-6000),
    diagnostics: window.__veltaDiagnostics?.messages?.map(m => `${m.level}: ${m.message}`).slice(-30) || [],
  })).catch(() => null)
  if (state) {
    state.pending = state.pending ? (state.pending.includes(token) ? 'token pending' : 'installed pending') : null
    state.href = clean(state.href)
    state.body = clean(state.body)
    console.error('Browser state:', JSON.stringify(state))
  }
  for (const line of consoleTail.slice(-30)) console.error('Console:', clean(line))
  await page.screenshot({ path: '/mnt/agents/.tmp/velta-live-onboarding-failure.png', fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
