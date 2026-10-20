#!/usr/bin/env node
// E2E for the trusted group-call app (Phase 3, docs/agents/group-calls.md).
// Three Velta "host" pages in headless Chromium, each with the REAL
// webxdc-shim.js app frame (cross-origin, sandbox without allow-same-origin,
// like the desktop/Android webxdc:// host), the real built-in app UI, a
// host bridge mirroring webxdc-manager's veltaCall gating (trust = SHA-256 of
// the bundle via xdc-trust.js), real GroupCallSession/WebRTC (relay-only
// through a local coturn when available), and the real in-call bar.
// A 4th page loads a tampered bundle: no veltaCall -> "needs Velta". A 5th
// shows the Delta Chat view (no Velta API) with the roster from status updates.
// Usage: node scripts/e2e-group-call-app.mjs [--shots DIR]
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const shots = arg('--shots'); if (shots) mkdirSync(shots, { recursive: true })
const SHIM = readFileSync(root + 'velta-app/src-tauri/src/webxdc-shim.js', 'utf8')
const APPDIR = root + 'app/webxdc/group-call/'

let turn = null
if (spawnSync('sh', ['-c', 'command -v turnserver']).status === 0) {
  turn = spawn('turnserver', ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', '--listening-port=3481', '--lt-cred-mech', '--user=velta:velta', '--realm=velta.test', '--no-tls', '--no-dtls', '--allow-loopback-peers', '--no-cli', '--min-port=49410', '--max-port=49600'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 800))
}
const ICE = turn ? [{ urls: ['turn:127.0.0.1:3481?transport=udp'], username: 'velta', credential: 'velta' }] : []

const hostHtml = (q) => `<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/css/main.css"><style>body{margin:0;background:#101815} iframe{border:0;width:100vw;height:100vh;display:block}</style></head><body>
<script type="module">
import { joinGroupCall, leaveGroupCall, setGroupCallMuted, currentGroupCall, onGroupCallChange } from '/js/group-call-host.js'
import { trustedAppName } from '/js/xdc-trust.js'
import { renderBar, setCallScreen } from '/js/group-call-ui.js'
const q = new URLSearchParams(location.search); const id = q.get('id'); const name = q.get('name')
const rt = q.get('rt') === '1'
const bundle = new Uint8Array(await (await fetch(q.get('tampered') ? '/tampered.xdc' : '/builtin/group-call.xdc')).arrayBuffer())
const trust = await trustedAppName(bundle)   // the same check webxdc-manager runs
const core = new Proxy({}, { get: (_t, m) => (...a) => window.coreCall(m, a) })
const f = document.createElement('iframe')
f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals')
f.setAttribute('allow', "autoplay; microphone 'none'; camera 'none'; display-capture 'none'; geolocation 'none'")
f.src = 'http://localhost:' + location.port + '/app/index.html'
document.body.append(f)
setCallScreen(7) // this page IS the call screen (webxdc-manager does this when the app opens)
const post = (m) => f.contentWindow.postMessage(m, '*')
let serial = 0
const state = () => { const s = currentGroupCall(); return s ? s.snapshot() : { state: 'idle', participants: [] } }
onGroupCallChange((s) => { renderBar(s); if (trust === 'group-call') post({ type: 'velta-call-state', state: s || state() }) })
window.pushUpdates = async () => { const rows = JSON.parse(await core.getWebxdcStatusUpdates(7, serial)); for (const r of rows) serial = Math.max(serial, r.serial); if (rows.length) post({ type: 'velta-webxdc-status-updates', updates: rows }) }
async function handle(d) {
  switch (d.method) {
    case 'getInfo': return { name: 'Velta Group Call', selfAddr: id, selfName: name, veltaRealtime: rt, veltaCall: trust === 'group-call' }
    case 'getAllUpdates': return { updates: JSON.parse(await core.getWebxdcStatusUpdates(7, 0)) }
    case 'getStatusUpdates': { const rows = JSON.parse(await core.getWebxdcStatusUpdates(7, d.params.serial || 0)); for (const r of rows) serial = Math.max(serial, r.serial); return { updates: rows } }
    case 'sendUpdate': await core.sendWebxdcStatusUpdate(7, JSON.stringify(d.params.update), ''); return {}
    case 'veltaCallJoin': case 'veltaCallLeave': case 'veltaCallMute': case 'veltaCallState': {
      if (trust !== 'group-call') throw new Error('not available for this app')
      if (d.method === 'veltaCallJoin') await joinGroupCall({ core, msgId: 7, chatId: 1, chatName: 'Family', selfId: id, selfName: name, realtime: rt, relayOnly: ${!!turn}, env: { iceServers: async () => ${JSON.stringify(ICE)}, releaseRealtime: (m) => core.leaveWebxdcRealtime(m) } })
      if (d.method === 'veltaCallLeave') await leaveGroupCall()
      if (d.method === 'veltaCallMute') setGroupCallMuted(!!d.params.muted)
      return state()
    }
    default: throw new Error('unknown ' + d.method)
  }
}
addEventListener('message', (e) => { if (e.source !== f.contentWindow) return; const d = e.data || {}; if (d.type !== 'velta-webxdc-call') return
  handle(d).then((result) => post({ type: 'velta-webxdc-response', id: d.id, result }), (err) => post({ type: 'velta-webxdc-response', id: d.id, error: String(err.message || err) })) })
window.appFrame = () => f
window.ready = true
</script></body></html>`

const tampered = (() => { const b = Buffer.from(readFileSync(root + 'app/builtin/group-call.xdc')); b[b.length - 30] ^= 1; return b })()
const server = createServer((req, r) => {
  const u = new URL(req.url, 'http://x'); const port = server.address().port
  const isAppOrigin = req.headers.host?.startsWith('localhost')
  if (isAppOrigin && u.pathname.startsWith('/app/')) {
    const f = u.pathname.slice(5) || 'index.html'
    if (!/^[\w.-]+$/.test(f)) { r.writeHead(404); return r.end() }
    let body = readFileSync(APPDIR + f)
    const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.png') ? 'image/png' : 'text/plain'
    if (f === 'index.html') {
      const dc = u.searchParams.get('dc')
      const inject = dc ? `<script>window.webxdc={selfAddr:'dc@x',selfName:'Dana',setUpdateListener:function(cb){var rows=${JSON.stringify(dcRows)};rows.forEach(function(x,i){x.serial=i+1;x.max_serial=rows.length;cb(x)});return Promise.resolve()},sendUpdate:function(){}}</script>` : `<script>${SHIM}</script>`
      body = Buffer.from(body.toString().replace('<head>', '<head>' + inject))
    }
    r.writeHead(200, { 'content-type': type, 'permissions-policy': 'camera=(), microphone=(), display-capture=(), geolocation=()', 'content-security-policy': `default-src 'self' http://localhost:${port}; script-src 'self' http://localhost:${port} 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:` })
    return r.end(body)
  }
  if (u.pathname.startsWith('/js/') || u.pathname.startsWith('/css/') || u.pathname.startsWith('/builtin/') || u.pathname.startsWith('/webxdc/') || u.pathname.startsWith('/vendor/')) {
    if (u.pathname.includes('..')) { r.writeHead(404); return r.end() }
    try { const b = readFileSync(root + 'app' + u.pathname); r.writeHead(200, { 'content-type': u.pathname.endsWith('.js') ? 'text/javascript' : u.pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); return r.end(b) } catch { r.writeHead(404); return r.end() }
  }
  if (u.pathname === '/tampered.xdc') { r.writeHead(200); return r.end(tampered) }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(hostHtml(u.searchParams))
}).listen(0)
await new Promise((ok) => server.on('listening', ok))
const PORT = server.address().port

const rows = []; const rtMembers = new Set(); const pages = new Map()
let dcRows = []
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
async function client(id, name, { rt = true, tampered = false } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 360, height: 720 }, colorScheme: 'dark' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  [${name} pageerror]`, e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${name} console]`, m.text()) })
  await page.exposeFunction('coreCall', async (m, a) => {
    if (m === 'getWebxdcStatusUpdates') return JSON.stringify(rows.filter((r) => r.serial > a[1]))
    if (m === 'sendWebxdcStatusUpdate') { const row = { ...JSON.parse(a[1]), serial: rows.length + 1 }; rows.push(row); for (const o of pages.values()) o.evaluate((n) => { window.pushUpdates(); import('/js/group-call-host.js').then((h) => h.routeStatusUpdate(7, n)) }, row.serial).catch(() => {}); return null }
    if (m === 'sendWebxdcRealtimeAdvertisement') { if (!rt) throw new Error('no realtime'); rtMembers.add(id); return null }
    if (m === 'sendWebxdcRealtimeData') { for (const [oid, o] of pages) if (oid !== id && rtMembers.has(oid)) o.evaluate((d) => import('/js/group-call-host.js').then((h) => h.routeRealtime(7, d)), a[1]).catch(() => {}); return null }
    if (m === 'leaveWebxdcRealtime') { rtMembers.delete(id); return null }
    if (m === 'iceServers') return []
    throw new Error('core ' + m)
  })
  await page.goto(`http://127.0.0.1:${PORT}/?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&rt=${rt ? 1 : 0}${tampered ? '&tampered=1' : ''}`)
  await page.waitForFunction(() => window.ready)
  pages.set(id, page)
  const frame = () => page.frames().find((f) => f.url().includes('/app/index.html'))
  for (let i = 0; i < 50 && !frame(); i++) await page.waitForTimeout(100)
  return { page, frame }
}
const shot = async (page, name) => { if (shots) { await page.screenshot({ path: `${shots}/${name}.png` }); console.log(`  shot ${shots}/${name}.png`) } }

try {
  console.log(`  mode: ${turn ? 'relay-only via local coturn' : 'host candidates (no turnserver)'}`)
  rows.push({ payload: { veltaCall: { vgc: 1, t: 'meta', from: 'anna@velta.test', sid: 'meta', ts: Date.now(), title: 'Saturday hike plan', creatorName: 'Anna' } }, document: 'Saturday hike plan', serial: rows.length + 1 })
  const A = await client('anna@velta.test', 'Anna'), B = await client('boris@velta.test', 'Boris'), P = await client('pavel@velta.test', 'Pavel', { rt: false })
  await A.frame().waitForSelector('#join:not([hidden])', { timeout: 10000 })
  check(await A.frame().evaluate(() => typeof window.RTCPeerConnection === 'function' && (() => { try { new RTCPeerConnection(); return false } catch { return true } })()), 'app frame: RTCPeerConnection is blocked')
  check(await A.frame().evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => false, () => true)), 'app frame: getUserMedia is denied')
  check(await A.frame().evaluate(() => window.webxdc.veltaCall.available()), 'trusted bundle: veltaCall.available() is true')
  await shot(A.page, 'call-screen-360-before-join')
  for (const c of [A, B, P]) { await c.frame().click('#join'); await c.page.waitForTimeout(300) }
  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    ok = true
    for (const c of [A, B, P]) { const n = await c.frame().evaluate(() => document.querySelectorAll('.tile').length); const st = await c.page.evaluate(async () => { const h = await import('/js/group-call-host.js'); const s = h.currentGroupCall(); return s ? [...s.call.peers.values()].filter((p) => p.state === 'connected').length : 0 }); if (n !== 3 || st !== 2) ok = false }
    if (!ok) await A.page.waitForTimeout(500)
  }
  check(ok, 'three clients joined from the app UI (desktop, Android, PWA-style without realtime): 3 tiles, 2 connected peers each')
  check(await A.page.evaluate(() => !document.getElementById('group-call-bar')), 'call screen open: no duplicate in-call bar')
  check(await A.page.evaluate(async () => { (await import('/js/group-call-ui.js')).setCallScreen(null); const shown = !!document.getElementById('group-call-bar'); (await import('/js/group-call-ui.js')).setCallScreen(7); return shown && !document.getElementById('group-call-bar') }), 'call screen closed -> bar; reopened -> hidden again')
  await B.frame().click('#mute')
  await A.page.waitForTimeout(800)
  check(await A.frame().evaluate(() => [...document.querySelectorAll('.tile')].some((t) => /Boris/.test(t.textContent) && t.querySelector('.mute-ic'))), 'Boris muted -> Anna sees the muted icon')
  await A.page.waitForTimeout(1200)
  check(await A.frame().evaluate(() => document.getElementById('title').textContent) === 'Saturday hike plan', 'call screen: call name')
  await shot(A.page, 'call-screen-360-in-call-no-bar')
  check(await A.frame().evaluate(() => getComputedStyle(document.querySelector('#leave')).display !== 'none'), 'Leave button visible in call')
  // tampered bundle: same file name, one byte off -> no call API
  const T = await client('eve@velta.test', 'Eve', { tampered: true })
  await T.frame().waitForSelector('#needs-velta:not([hidden])', { timeout: 10000 })
  check(await T.frame().evaluate(() => window.webxdc.veltaCall.available()) === false, 'tampered bundle: veltaCall.available() is false')
  check(await T.frame().evaluate(() => window.webxdc.veltaCall.join().then(() => 'joined', (e) => e.message)) === 'not available for this app', 'tampered bundle: join is refused by the host')
  await shot(T.page, 'untrusted-copy-360-needs-velta')
  // Delta Chat view (no Velta API): roster from the call's status updates
  dcRows = rows.filter((r) => r.payload?.veltaCall && ['meta', 'join', 'leave', 'hb'].includes(r.payload.veltaCall.t)).map((r) => ({ payload: r.payload }))
  const dc = await (await browser.newContext({ viewport: { width: 360, height: 720 }, colorScheme: 'light' })).newPage()
  await dc.goto(`http://localhost:${PORT}/app/index.html?dc=1`)
  await dc.waitForSelector('#needs-velta:not([hidden])')
  check(/Anna/.test(await dc.textContent('#dc-roster')), `Delta Chat view: "needs Velta" + roster (${await dc.textContent('#dc-roster')})`)
  check(await dc.textContent('#title') === 'Saturday hike plan' && /Started by Anna/.test(await dc.textContent('#creator')), 'Delta Chat view: call name + creator')
  await shot(dc, 'delta-chat-view-360-needs-velta')
  // leave from the bar (shown once the call screen is closed)
  await P.page.evaluate(async () => (await import('/js/group-call-ui.js')).setCallScreen(null))
  await P.page.click('#group-call-bar .gcb-leave')
  await A.page.waitForTimeout(1500)
  check(await P.page.evaluate(() => !document.getElementById('group-call-bar')), 'leave from the host bar removes it')
  await shot(P.page, 'call-screen-360-after-leave')
  for (const c of [A, B]) await c.page.evaluate(async () => (await import('/js/group-call-host.js')).leaveGroupCall())
  await A.page.waitForTimeout(300)
  check(rows.filter((r) => r.info).map((r) => r.info).join(' | ').includes('started a group call'), 'chat info line "started a group call"')
} finally {
  await browser.close(); server.close(); turn?.kill()
}
if (failed) { console.log(`group call app e2e: ${failed} FAILED`); process.exit(1) }
console.log('group call app e2e: all checks passed')
