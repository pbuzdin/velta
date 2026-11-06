#!/usr/bin/env node
// Browser-level one-tap onboarding verification against the built PWA shell.
// The demo core is used only to observe the final dcaccount QR; DNS probes and
// registry responses are mocked, so this test creates no Chatmail accounts.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1] }
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(repoRoot, flag('dist') || 'build/dist-pwa')
const TOKEN = 'eyJ2IjoxLCJpIjoiYnJvd3Nlci1vbmJvYXJkaW5nIn0.' + 'A'.repeat(42) + 'w'
const PROXY = 'wss://proxy.example.org/vp-test'
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
const server = createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const body = files.get(pathname)
  if (body == null) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': mimes[extname(pathname)] ?? 'application/octet-stream' })
  res.end(body)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let browser
for (const options of [
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN, headless: true } : null,
  { headless: true }, { channel: 'chrome', headless: true },
].filter(Boolean)) {
  try { browser = await chromium.launch(options); break } catch {}
}
if (!browser) throw new Error('No Chromium browser available')

async function scenario(requested) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors = []
  const documents = []
  const probes = []
  const protocolSets = []
  let registryCalls = 0
  let releaseFirstRegistry
  const firstRegistryGate = new Promise(r => { releaseFirstRegistry = r })
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', r => { if (r.resourceType() === 'document') documents.push(r.url()) })
  await page.addInitScript(() => {
    localStorage.setItem('velta-mock', '1')
    localStorage.setItem('velta-mock-fresh', '1')
  })
  await page.route('**/onboarding.json', async route => {
    registryCalls++
    if (registryCalls === 1) await firstRegistryGate
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        v: 1,
        proxy: PROXY,
        relays: requested ? { alpha: 'mail.example.org' } : { alpha: 'mail.example.org', fast: 'fast.example.org' },
      }),
    })
  })
  await page.route('**/js/mock-core.js', async route => {
    const body = files.get('/js/mock-core.js').toString() + `\n
const onboardingConfigure = MockCore.prototype.configureWithQr;
MockCore.prototype.configureWithQr = async function(link) {
  window.__onboardingQr = link;
  return onboardingConfigure.call(this, link);
};
const onboardingAutopick = MockCore.prototype.initTransports;
MockCore.prototype.initTransports = async function(...args) {
  window.__onboardingAutopick = (window.__onboardingAutopick || 0) + 1;
  return onboardingAutopick.apply(this, args);
};
`
    await route.fulfill({ contentType: 'text/javascript', body })
  })
  await page.routeWebSocket(/^wss:\/\/proxy\.example\.org\//, ws => {
    const url = new URL(ws.url())
    const host = decodeURIComponent(url.pathname.split('/').pop())
    probes.push({ url: ws.url(), host })
    protocolSets.push(ws.protocols())
    setTimeout(() => ws.send(JSON.stringify(['192.0.2.13'])), host === 'fast.example.org' ? 5 : 25)
  })

  try {
    const suffix = requested ? '&r=alpha' : ''
    await page.goto(`${base}/?invite=${encodeURIComponent(TOKEN)}${suffix}`, { waitUntil: 'commit' })
    await page.waitForURL(url => !url.searchParams.has('invite') && !url.searchParams.has('r'))
    const captured = await page.evaluate(() => ({
      href: location.href,
      pending: sessionStorage.getItem('velta-pwa-onboarding'),
      secureJoinVisible: document.body.innerText.includes('Secure join'),
    }))
    assert.ok(!captured.href.includes('invite=') && !captured.href.includes('r=alpha'))
    assert.ok(captured.pending.includes(TOKEN), 'invite remains retryable until the registry is validated')
    assert.equal(captured.secureJoinVisible, false)

    releaseFirstRegistry()
    await page.waitForFunction(() => window.__onboardingQr, null, { timeout: 30_000 })
    const expectedHost = requested ? 'mail.example.org' : 'fast.example.org'
    assert.equal(await page.evaluate(() => window.__onboardingQr), `dcaccount:https://${expectedHost}/new`)
    await page.waitForFunction(() => !document.querySelector('#splash') || !document.querySelector('#splash').checkVisibility())
    await page.waitForTimeout(750)

    const state = await page.evaluate(() => ({
      active: localStorage.getItem('velta-ws-relay'),
      urls: JSON.parse(localStorage.getItem('velta-ws-relay-urls') || '{}'),
      tokens: JSON.parse(localStorage.getItem('velta-ws-relay-tokens') || '{}'),
      pending: sessionStorage.getItem('velta-pwa-onboarding'),
      autopick: window.__onboardingAutopick || 0,
      nickname: document.body.innerText.includes('How should we call you?'),
      splashVisible: !!document.querySelector('#splash')?.checkVisibility(),
      body: document.body.innerText,
    }))
    assert.equal(state.active, 'proxy.example.org')
    assert.equal(state.urls['proxy.example.org'], PROXY)
    assert.equal(state.tokens['proxy.example.org'], TOKEN)
    assert.equal(state.pending, null)
    assert.equal(state.autopick, 0, 'core candidate-pool autopick must not run')
    assert.equal(state.nickname, false)
    assert.equal(state.splashVisible, false)
    assert.match(state.body, /Account ready:/)
    assert.equal(documents.length, 2, 'exactly one worker-switch reload follows the initial navigation')
    assert.ok(registryCalls >= 1)
    assert.ok(probes.length > 0)
    if (requested) assert.deepEqual(probes.map(p => p.host), ['mail.example.org'])
    else assert.deepEqual(probes.map(p => p.host).sort(), ['fast.example.org', 'mail.example.org'])
    for (const p of probes) assert.ok(p.url.startsWith(`${PROXY}/dns/`), 'DNS probe preserves the full proxy path')
    for (const protocols of protocolSets) {
      assert.ok(protocols.includes('velta.v1'))
      assert.ok(protocols.includes(`tok.${TOKEN}`))
      assert.ok(protocols.some(p => p.startsWith('dev.')))
    }
    assert.deepEqual(errors, [])
    console.log(`PASS: ${requested ? 'requested alpha' : 'automatic registry-only selection'}, one reload, full-path token install, no setup screens`)
  } finally {
    releaseFirstRegistry()
    await context.close()
  }
}

try {
  await scenario(true)
  await scenario(false)
} finally {
  await browser.close()
  server.close()
}
