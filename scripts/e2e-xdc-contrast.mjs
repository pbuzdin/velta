#!/usr/bin/env node
// WCAG AA contrast audit + screenshots for the built-in webxdc apps
// (Velta Beam = app/webxdc/send-direct, Velta Circle = app/webxdc/group-call)
// in dark and light (prefers-color-scheme) × in Velta / not in Velta (mock
// webxdc with and without the shim's veltaCall). Normal text needs 4.5:1,
// large text (>= 24px, or >= 18.66px bold) 3:1. Disabled controls exempt.
// Usage: node scripts/e2e-xdc-contrast.mjs [--shots DIR]   (needs playwright)
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../app/webxdc/', import.meta.url))
const args = process.argv.slice(2)
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null
if (shots) mkdirSync(shots, { recursive: true })
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' }
const { classicTransfer } = await import('../tools/build-builtin-xdc.mjs')
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  if (p === 'send-direct/main.js') {   // the bundled main.js (transfer.js + ui.js)
    res.writeHead(200, { 'content-type': MIME['.js'] })
    return res.end(classicTransfer(readFileSync(root + 'send-direct/transfer.js', 'utf8')) + readFileSync(root + 'send-direct/ui.js', 'utf8'))
  }
  const f = join(root, p)
  if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

// mock webxdc: in Velta = the shim's extra properties (veltaCall, veltaRealtimeAvailable)
function mock({ velta, app }) {
  const offer = { id: '0123456789abcdef', name: 'holiday-photos.zip', size: 4200000, chunk: 60000, n: 70, sha256: 'a'.repeat(64) }
  const updates = app === 'send-direct' ? [{ serial: 1, max_serial: 1, payload: { offer, from: 'anna@example.org' } }]
    : [{ serial: 1, max_serial: 2, payload: { veltaCall: { t: 'meta', title: 'Team sync', creatorName: 'Anna' } } },
       { serial: 2, max_serial: 3, payload: { veltaCall: { t: 'join', from: 'a', name: 'Anna', ts: Date.now() } } },
       { serial: 3, max_serial: 3, payload: { veltaCall: { t: 'join', from: 'f'.repeat(64), ts: Date.now() } } }]
  window.webxdc = {
    selfAddr: 'me@example.org', selfName: 'Me', sendUpdateInterval: 1000, sendUpdateMaxSize: 128000,
    getSelfInfo: async () => ({ addr: 'me@example.org' }),
    setUpdateListener: (cb) => { updates.forEach(u => cb(u)); return Promise.resolve() },
    sendUpdate() {}, importFiles: async () => [], sendToChat: async () => ({}),
    joinRealtimeChannel: () => ({ setListener() {}, send() {}, leave() {} }),
  }
  if (velta) {
    const st = { state: 'active', inCall: 3, max: 6, relayOnly: true, muted: false, activeSpeaker: 'b',
      participants: [{ id: 'me', name: 'Me', self: true, state: 'connected' }, { id: 'a', name: 'Anna', state: 'connected', muted: true },
        { id: 'b', name: 'Boris', state: 'connected', speaking: true }] }
    window.webxdc.veltaRealtimeAvailable = true
    window.webxdc.veltaCall = { available: async () => app === 'group-call', getTheme: async () => null, getState: async () => st,
      onState: (cb) => cb(st), join: async () => {}, leave() {}, setMuted() {} }
  }
}
function audit() {
  const parse = s => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) { const c = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(s || ''); return c ? [c[1] * 255, c[2] * 255, c[3] * 255, c[4] == null ? 1 : +c[4]] : null }
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] }
  const over = (t, u) => { const a = t[3] + u[3] * (1 - t[3]); return [0, 1, 2].map(i => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / (a || 1)).concat(a) }
  const lum = c => c.slice(0, 3).map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0)
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const out = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set()
  for (let n; (n = walker.nextNode());) {
    const el = n.parentElement
    if (!n.textContent.trim() || seen.has(el)) continue
    seen.add(el)
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue
    let hidden = false, op = 1
    for (let a = el; a; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.display === 'none' || cs.visibility === 'hidden') hidden = true; op *= +cs.opacity }
    if (hidden || el.closest(':disabled')) continue
    const chain = []; for (let a = el; a; a = a.parentElement) chain.push(parse(getComputedStyle(a).backgroundColor) || [0, 0, 0, 0])
    let bg = [255, 255, 255, 1]; const cv = getComputedStyle(document.documentElement).colorScheme
    if (cv === 'dark' || matchMedia('(prefers-color-scheme: dark)').matches) bg = [18, 18, 18, 1]
    for (const c of chain.reverse()) bg = over(c, bg)
    const cs = getComputedStyle(el); let fg = parse(cs.color); fg = [fg[0], fg[1], fg[2], fg[3] * op]
    const fs = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700
    const need = fs >= 24 || (bold && fs >= 18.66) || el.classList.contains('av') ? 3 : 4.5
    const ratioV = ratio(over(fg, bg), bg)
    out.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className : ''), text: n.textContent.trim().slice(0, 40), ratio: +ratioV.toFixed(2), need, ok: ratioV >= need })
  }
  return out
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
let fail = 0, checked = 0
const report = []
for (const app of ['send-direct', 'group-call']) for (const scheme of ['dark', 'light']) for (const velta of [true, false]) {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, colorScheme: scheme })
  await page.addInitScript(mock, { velta, app })
  await page.goto(`${origin}/${app}/index.html`); await page.waitForTimeout(400)
  const cta = await page.locator('#velta-cta').isVisible()
  const res = await page.evaluate(audit)
  const bad = res.filter(r => !r.ok); checked += res.length; fail += bad.length
  const min = Math.min(...res.map(r => r.ratio / r.need * (r.need)))
  const label = (process.env.SHOT_PREFIX || '') + `${app === 'send-direct' ? 'beam' : 'circle'}-${scheme}-${velta ? 'in-velta' : 'not-in-velta'}`
  report.push(`${label}: ${res.length} text nodes, min ${Math.min(...res.map(r => r.ratio))}:1, cta ${cta ? 'shown' : 'hidden'}, ${bad.length} violations`)
  for (const b of bad) report.push(`  FAIL ${b.el} "${b.text}" ${b.ratio} < ${b.need}`)
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || /[0-9a-f]{32}/.test(document.body.innerText))) { fail++; report.push('  FAIL horizontal overflow or raw id in text') }
  if (cta === velta) { fail++; report.push(`  FAIL cta visibility wrong (in Velta: ${velta})`) }
  if (shots) await page.screenshot({ path: join(shots, label + '.png'), fullPage: true })
  await page.close()
}
await browser.close(); server.close()
console.log(report.join('\n'))
console.log(fail ? `xdc contrast: ${fail} FAILED` : `xdc contrast: all ${checked} checks passed`)
process.exit(fail ? 1 : 0)
