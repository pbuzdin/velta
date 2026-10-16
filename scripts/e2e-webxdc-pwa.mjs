#!/usr/bin/env node
// E2E for webxdc in the PWA (Step A, docs/research/beam-pwa-research.md):
// builds a PWA dist with a STUB wasm core (the core is not needed: a tiny
// host page stands in for webxdc-manager's bridge), serves it, and drives
// Chromium through the real generated sw.js + webxdc-host/frame.js + the
// shared webxdc-shim.js:
//   - Velta Beam opens, runs in an opaque origin, shows the "direct transfer
//     not available in the web app" state, and lists a status-update offer;
//   - a vite-style ES-module app loads CSS/url()/static+dynamic imports/
//     fetch()/import.meta.url assets from the archive and sends a status
//     update; network (remote AND the PWA origin) is blocked;
//   - top-level navigation to an app URL and same-origin framing are refused.
// Usage: node scripts/e2e-webxdc-pwa.mjs   (needs `npx playwright install chromium`)
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { chromium } from 'playwright'
import { crc32 } from '../tools/build-builtin-xdc.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'velta-wxdc-e2e-'))
const wasmDist = join(work, 'wasm')
const out = join(work, 'dist')
mkdirSync(wasmDist)
writeFileSync(join(wasmDist, 'deltachat_wasm.js'), '// stub core for the webxdc e2e (sqlite_export)\n')
writeFileSync(join(wasmDist, 'deltachat_wasm_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
execFileSync(process.execPath, [join(repoRoot, 'scripts/build-pwa.mjs'), '--wasm-dist', wasmDist, '--out', out], { stdio: 'inherit' })

// Deflate zip (the builtin Beam archive is stored-only; cover both).
function zipDeflate(entries) {
  const locals = []; const central = []; let off = 0
  for (const [name, data] of entries) {
    const raw = Buffer.from(data); const comp = deflateRawSync(raw); const n = Buffer.from(name)
    const crc = crc32(raw)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42)
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}
const png = readFileSync(join(repoRoot, 'app/webxdc/send-direct/icon.png'))
const modApp = zipDeflate([
  ['index.html', `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'">
<link rel="stylesheet" href="./assets/s.css"><script type="module" src="./assets/main.js"></script></head>
<body><img id="logo" src="icon.png"><div id="bg"></div></body></html>`],
  ['manifest.toml', 'name = "Module test"\n'],
  ['icon.png', png],
  ['assets/s.css', '@import "./more.css";\n#bg { width: 4px; height: 4px; background: url("../icon.png"); }'],
  ['assets/more.css', 'body { margin: 0; }'],
  ['assets/dep.js', 'export const x = 41;'],
  ['assets/lazy.js', 'import { x } from "./dep.js"; export const y = x + 1;'],
  ['data.json', '{"hello":"vfs"}'],
  ['assets/main.js', `import { x } from "./dep.js";
const r = { x };
r.lazy = (await import("./lazy.js")).y;
r.json = (await (await fetch("data.json")).json()).hello;
const img = new Image(); img.src = new URL("../icon.png", import.meta.url).href;
r.img = await new Promise((ok) => { img.onload = () => ok(img.naturalWidth > 0); img.onerror = () => ok(false); });
r.logo = document.getElementById("logo").src.startsWith("blob:");
r.bg = getComputedStyle(document.getElementById("bg")).backgroundImage.includes("blob:");
r.remote = await fetch("https://example.com/").then(() => "LEAK", () => "blocked");
r.self = await fetch(location.origin + "/probe-fetch").then((x) => x.status, () => "blocked");
r.selfImg = await new Promise((ok) => { const i = new Image(); i.onload = () => ok("LEAK"); i.onerror = () => ok("blocked"); i.src = location.origin + "/probe-img"; });
r.xhr = await new Promise((ok) => { const x = new XMLHttpRequest(); x.onload = () => ok("LEAK"); x.onerror = () => ok("blocked"); x.open("GET", "https://example.com/probe-xhr"); x.send(); });
r.origin = self.origin;
r.ls = (() => { try { localStorage.setItem("a", "1"); return localStorage.getItem("a"); } catch (e) { return "throws"; } })();
await window.webxdc.sendUpdate({ payload: { from: "module-app", r } }, "");
document.title = "DONE " + JSON.stringify(r);`],
])
writeFileSync(join(out, 'e2e-mod.xdc'), modApp)
writeFileSync(join(out, 'e2e-host.html'), `<!doctype html><html><head><meta charset="utf-8">
<script src="pwa-config.js"></script><script type="module" src="e2e-host.js"></script></head><body></body></html>`)
writeFileSync(join(out, 'e2e-host.js'), `
const sent = []; window.__sent = sent;
const updates = { 10: [{ serial: 1, payload: { offer: { id: "0123456789abcdef", name: "demo.bin", size: 1234, sha256: "${'a'.repeat(64)}", chunk: 65536, n: 1 }, from: "alice@example.org" } }], 11: [] };
const archives = { 10: "builtin/send-direct.xdc", 11: "e2e-mod.xdc" };
let frame = null, msgId = 0;
function post(m) { frame.contentWindow.postMessage(m, "*"); }
addEventListener("message", async (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data || {}; if (d.type !== "velta-webxdc-call") return;
  let result, error;
  try {
    switch (d.method) {
      case "veltaBundle": result = { xdc: new Uint8Array(await (await fetch(archives[msgId])).arrayBuffer()) }; break;
      case "getInfo": result = { name: "x", selfAddr: "me@example.org", selfName: "Me", veltaRealtime: false, sendUpdateInterval: 1000, sendUpdateMaxSize: 0 }; break;
      case "getAllUpdates": result = { updates: updates[msgId] }; break;
      case "getStatusUpdates": { const s = Number(d.params.serial) || 0; const u = updates[msgId].filter((x) => x.serial > s);
        result = { updates: u, serial: u.length ? u[u.length - 1].serial : s };
        setTimeout(() => post({ type: "velta-webxdc-status-updates", updates: u, serial: result.serial, done: true }), 0); break; }
      case "sendUpdate": sent.push(d.params.update); result = {}; break;
      case "realtimeJoin": throw new Error("Direct transfer (realtime channels) is not available in the Velta web app yet");
      default: result = {};
    }
  } catch (err) { error = String(err.message || err); }
  post({ type: "velta-webxdc-response", id: d.id, result, error });
});
window.openApp = async (id) => {
  await navigator.serviceWorker.ready;
  frame?.remove(); msgId = id;
  frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads allow-forms allow-modals");
  frame.src = "webxdc-run/1/" + id + "/index.html?velta-theme=dark";
  document.body.appendChild(frame);
};
`)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.xdc': 'application/octet-stream' }
const files = new Map()
const walk = function* (d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p } }
for (const p of walk(out)) files.set('/' + relative(out, p).replaceAll('\\', '/'), readFileSync(p))
const hits = []
const server = createServer((req, res) => {
  hits.push(req.url)
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p.endsWith('/')) p += 'index.html'
  const body = files.get(p)
  if (!body) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(body)
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()) })
  await page.goto(`${BASE}/e2e-host.html`)
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(async () => {
    await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 })
  })

  // 1. Velta Beam
  await page.evaluate(() => window.openApp(10))
  const beamFrame = async () => page.frames().find((f) => f.url().includes('/webxdc-run/1/10/'))
  await page.waitForFunction(() => true)
  let fr = null
  for (let i = 0; i < 100 && !fr; i++) { fr = await beamFrame(); if (!fr) await page.waitForTimeout(100) }
  await fr.waitForSelector('#pick', { timeout: 15000 })
  await fr.waitForFunction(() => document.querySelector('#peers').textContent.includes('not available in the Velta web app'), null, { timeout: 15000 })
  check(true, 'Beam: shows the "direct transfer not available in the web app" state')
  check(await fr.evaluate(() => document.querySelector('#pick').disabled), 'Beam: send button disabled without realtime')
  check(await fr.evaluate(() => self.origin) === 'null', 'Beam: frame origin is opaque')
  check(await fr.evaluate(() => typeof window.webxdc.sendUpdate === 'function' && window.webxdc.veltaRealtimeAvailable === false), 'Beam: shim present, veltaRealtimeAvailable=false')
  await fr.waitForFunction(() => document.querySelector('#list').textContent.includes('demo.bin'), null, { timeout: 10000 })
  check(true, 'Beam: status-update offer listed')
  check(await fr.evaluate(() => { try { return !!parent.document } catch { return false } }) === false, 'Beam: cannot touch the host DOM')

  // 2. module app
  await page.evaluate(() => window.openApp(11))
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.waitForFunction(() => window.__sent.some((u) => u.payload && u.payload.from === 'module-app'), null, { timeout: 20000 }).catch(async (e) => { const f = page.frames().find((x) => x.url().includes('/1/11/')); const c = f && await f.content(); console.log('  frame tail:', c && c.slice(-900)); console.log('  import:', f && await f.evaluate(() => import(document.querySelector('script[type=module]').src).then(() => 'ok', (e) => String(e)))); throw e })
  const r = await page.evaluate(() => window.__sent.find((u) => u.payload.from === 'module-app').payload.r)
  console.log('  module app result:', JSON.stringify(r))
  check(r.x === 41 && r.lazy === 42, 'module app: static + dynamic relative imports')
  check(r.json === 'vfs', 'module app: fetch() of an archive file')
  check(r.img && r.logo && r.bg, 'module app: import.meta.url asset, <img src>, CSS url()')
  check(r.remote === 'blocked' && r.xhr === 'blocked', 'module app: remote fetch/XHR blocked by CSP')
  check((r.self === 404 || r.self === 'blocked') && r.selfImg === 'blocked' && !hits.some((h) => h.includes('/probe-')), 'module app: no request reaches the PWA origin')
  check(r.origin === 'null', 'module app: opaque origin')
  check(r.ls === '1', 'module app: localStorage shimmed in memory')

  // 3. refusals
  const top = await page.request.get(`${BASE}/webxdc-run/1/11/index.html`).catch(() => null)
  const nav = await ctx.newPage(); const resp = await nav.goto(`${BASE}/webxdc-run/1/11/index.html`)
  check(resp.status() === 403, 'top-level navigation to an app URL refused (403)')
  void top
  const framed = await page.evaluate(async () => {
    const f = document.createElement('iframe'); f.src = 'index.html'; document.body.appendChild(f)
    await new Promise((r) => f.onload = r)
    try { return f.contentDocument ? f.contentDocument.body.textContent : 'opaque' } catch { return 'opaque' }
  })
  check(framed === 'opaque' || /Framing is not allowed/.test(framed), `same-origin framing refused/sandboxed (${String(framed).slice(0, 40)})`)
} finally {
  await browser.close(); server.close()
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1) }
console.log('webxdc PWA e2e: all checks passed')
