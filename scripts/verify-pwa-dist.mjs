#!/usr/bin/env node
// C4 verification: serve the built PWA dist, boot the REAL app on the wasm
// core in a browser, create an account through the splash UI, then reload and
// assert the OPFS snapshot + service worker deliver a working second boot.
//
// Prereq: scripts/build-pwa.mjs (needs a wasm dist; see script header).
// Usage:  node scripts/verify-pwa-dist.mjs [--dist build/dist-pwa] [--port 8799]
//         CHANNEL=msedge  picks a system browser channel (default: bundled
//         chromium, then msedge/chrome as fallbacks)
import { createServer } from 'node:http'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1] }
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const root = join(repoRoot, flag('dist') || 'build/dist-pwa')
const PORT = Number(flag('port') || 8799)
const BASE = `http://127.0.0.1:${PORT}`

const mimes = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.woff2': 'font/woff2', '.map': 'application/json',
}
// Serve the whole dist from memory: reading the 28 MB wasm off disk per
// request starved the SW-install burst and flaked connections (install then
// fails → registration goes redundant).
import { readdirSync, readFileSync } from 'node:fs'
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}
const files = new Map()
for (const p of walk(root)) {
  const rel = '/' + relative(root, p).replaceAll('\\', '/')
  files.set(rel, readFileSync(p))
}
console.log(`serving ${root} on ${BASE} (${files.size} files, in-memory)`)
const server = createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const body = files.get(pathname)
  if (body == null) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': mimes[extname(pathname)] ?? 'application/octet-stream' })
  res.end(body)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const channels = process.env.CHANNEL ? [process.env.CHANNEL] : [undefined, 'msedge', 'chrome']
let browser = null
for (const channel of channels) {
  try { browser = await chromium.launch({ channel, headless: true }); console.log(`browser: ${channel || 'bundled chromium'}`); break } catch {}
}
if (!browser) { console.error('FAIL: no browser available'); process.exit(2) }

const page = await browser.newPage()
const consoleLines = []
page.on('console', (m) => consoleLines.push(m.text()))
page.on('pageerror', (e) => consoleLines.push(`PAGEERROR: ${e.message}`))

async function waitBackendLine(who, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (consoleLines.some((l) => l.includes(`[velta] using backend: ${who}`))) return true
    if (consoleLines.some((l) => l.includes('[velta] using backend: mock'))) return false
    await page.waitForTimeout(500)
  }
  return false
}

let failed = ''
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`); if (!ok && !failed) failed = label }

// 1. First boot: real app on the worker-wasm core (no demo fallback).
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
const booted = await waitBackendLine('worker-wasm', 120_000)
if (!booted) {
  console.log('\nconsole on failed boot:')
  for (const l of consoleLines.slice(0, 40)) console.log('  ' + l.slice(0, 300))
}
check(booted, 'first boot uses worker-wasm core')
check(await page.locator('#splash').isVisible().catch(() => false), 'unconfigured splash shows')

// 2. The account JsonRpcCore.init() creates must reach the OPFS snapshot via
//    the 8s checkpoint. (The splash "Create an account" relay flow can't run
//    pre-C3: chatmail /new has no CORS, so the in-browser credential fetch is
//    refused — relay-side minting is exactly what C3/R1 add.)
await page.waitForTimeout(10_000)
const opfsFirst = await page.evaluate(async () => {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('accounts')
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    return { entries: names.length }
  } catch { return { entries: 0 } }
})
check(opfsFirst.entries > 0, `OPFS snapshot written on first boot (${opfsFirst.entries} entries)`)

// 3. Reload: snapshot restores, the core boots again, SW serves the shell.
await page.reload({ waitUntil: 'domcontentloaded' })
check(await waitBackendLine('worker-wasm', 120_000), 'second boot uses worker-wasm core')
await page.waitForTimeout(2_000) // give the core a moment to finish init

const opfs = await page.evaluate(async () => {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('accounts')
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    return { entries: names.length, persisted: await navigator.storage.persisted?.() ?? null }
  } catch (e) { return { entries: 0, error: String(e) } }
})
check(opfs.entries > 0, `OPFS snapshot survives reload (${opfs.entries} entries${opfs.persisted == null ? '' : `, persisted=${opfs.persisted}`})`)

const sw = await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations()
  const reg = regs[0]
  const state = reg ? { scope: reg.scope, active: !!reg.active, installing: !!reg.installing, waiting: !!reg.waiting, controller: !!navigator.serviceWorker.controller } : null
  const keys = await caches.keys()
  const hit = keys.length ? !!(await caches.open(keys[0]).then((c) => c.match(new URL('js/app.js', location.href)))) : false
  return { regs: regs.length, state, keys, hit }
})
check(sw.regs > 0 && sw.state?.active, `service worker registered + active (${JSON.stringify(sw.state ?? sw)})`)
check(sw.hit, 'app shell in the SW cache')

console.log('\nconsole tail:')
for (const l of consoleLines.slice(-8)) console.log('  ' + l.slice(0, 200))
await browser.close()
server.close()
process.exit(failed ? 1 : 0)
