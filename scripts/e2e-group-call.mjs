#!/usr/bin/env node
// E2E for group audio calls (app/js/group-call.js): N Velta host pages in
// headless Chromium with fake mics, real WebRTC, full mesh. Signaling is
// relayed by this script (the transport layer has its own tests); the
// roster is set the way group-call-signal.js would.
// With coturn installed (`turnserver` on PATH) the calls run RELAY-ONLY
// through a local TURN server — the production default. Without it they
// fall back to host candidates (iceTransportPolicy "all") and say so.
// Checks: everyone connects to everyone, audio packets flow both ways on
// every pair, mute reaches the peers, a leaver is dropped, a 7th joiner
// gets "full".
// Usage: node scripts/e2e-group-call.mjs [--n 4]
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const N = Number(arg('--n', 4))

let turn = null
const TURN_PORT = 3479
if (spawnSync('sh', ['-c', 'command -v turnserver']).status === 0) {
  turn = spawn('turnserver', ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', `--listening-port=${TURN_PORT}`, '--lt-cred-mech', '--user=velta:velta', '--realm=velta.test', '--no-tls', '--no-dtls', '--allow-loopback-peers', '--no-cli', '--min-port=49160', '--max-port=49400', '--log-file=stdout', '--simple-log'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 800))
}
const relayOnly = !!turn
const iceServers = turn ? [{ urls: [`turn:127.0.0.1:${TURN_PORT}?transport=udp`], username: 'velta', credential: 'velta' }] : []

const server = createServer((q, r) => {
  if (q.url.startsWith('/js/') && /^[\w./-]+\.js$/.test(q.url) && !q.url.includes('..')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(readFileSync(root + 'app' + q.url)) }
  if (q.url.startsWith('/session')) {
    r.writeHead(200, { 'content-type': 'text/html' })
    return r.end(`<!doctype html><body><script type="module">
import { GroupCallSession } from '/js/group-call-host.js'
const q = new URLSearchParams(location.search); const id = q.get('id')
const core = new Proxy({}, { get: (_t, m) => (...a) => window.coreCall(m, a) })
window.session = new GroupCallSession({ core, msgId: 7, chatId: 1, selfId: id, selfName: id, realtime: q.get('rt') === '1', relayOnly: ${relayOnly},
  env: { iceServers: async () => ${JSON.stringify(iceServers)} } })
window.ready = true
</script></body>`)
  }
  r.writeHead(200, { 'content-type': 'text/html' })
  r.end(`<!doctype html><body><script type="module">
import { GroupCall } from '/js/group-call.js'
const id = new URLSearchParams(location.search).get('id')
window.call = new GroupCall({ selfId: id, selfName: id, RTCPeerConnection, getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  iceServers: async () => ${JSON.stringify(iceServers)}, relayOnly: ${relayOnly}, gatherTimeout: 3000,
  send: (m) => window.sig(m),
  attachAudio: (pid, s) => { let a = document.getElementById('a-' + pid); if (!a) { a = document.createElement('audio'); a.id = 'a-' + pid; a.autoplay = true; document.body.append(a) } a.srcObject = s },
  detachAudio: (pid) => document.getElementById('a-' + pid)?.remove(),
  onState: (s) => { window.last = s } })
window.rx = async () => { const out = {}; for (const [pid, p] of window.call.peers) { let b = 0, sent = 0, relay = null; (await p.pc.getStats()).forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'audio') b = x.bytesReceived; if (x.type === 'outbound-rtp' && x.kind === 'audio') sent = x.bytesSent; if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') relay = x.localCandidateId }); let ct = null; if (relay) (await p.pc.getStats()).forEach((x) => { if (x.id === relay) ct = x.candidateType }); out[pid] = { b, sent, state: p.state, ct } } return out }
window.ready = true
</script></body>`)
}).listen(0)
await new Promise((ok) => server.on('listening', ok))
const BASE = `http://127.0.0.1:${server.address().port}`

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
const pages = new Map()
const roster = []
const pushRoster = async () => { for (const p of pages.values()) await p.evaluate((r) => window.call.setRoster(r), roster).catch(() => {}) }
async function joinOne(id) {
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  [${id} pageerror]`, e.message))
  await page.exposeFunction('sig', (m) => { const to = pages.get(m.to); if (to) to.evaluate((x) => window.call.handleSignal(x), m).catch(() => {}) })
  await page.goto(`${BASE}/?id=${id}`)
  await page.waitForFunction(() => window.ready)
  pages.set(id, page)
  await page.evaluate(() => window.call.join())
  roster.push({ id, name: id, sid: await page.evaluate(() => window.call.sid), at: roster.length + 1 })
  await pushRoster()
  return page
}
const allConnected = async (ids) => {
  for (let i = 0; i < 60; i++) {
    let ok = true
    for (const id of ids) { const rx = await pages.get(id).evaluate(() => window.rx()); if (Object.keys(rx).length !== ids.length - 1 || !Object.values(rx).every((x) => x.state === 'connected' && x.b > 2000 && x.sent > 2000)) ok = false }
    if (ok) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

try {
  console.log(`  mode: ${relayOnly ? 'RELAY-ONLY via local coturn' : 'host candidates (no turnserver on PATH)'}; N=${N}`)
  const ids = Array.from({ length: N }, (_, i) => `u${i}@velta.test`)
  for (const id of ids) await joinOne(id)
  check(await allConnected(ids), `${N} participants: full mesh connected, audio bytes flowing on every pair (both directions)`)
  if (relayOnly) {
    const rx = await pages.get(ids[0]).evaluate(() => window.rx())
    check(Object.values(rx).every((x) => x.ct === 'relay'), `relay-only: every selected local candidate is "relay" (${Object.values(rx).map((x) => x.ct).join(',')})`)
  }
  await pages.get(ids[1]).evaluate(() => window.call.setMuted(true))
  await new Promise((r) => setTimeout(r, 400))
  const seen = await pages.get(ids[0]).evaluate((id) => window.call.snapshot().participants.find((p) => p.id === id).muted, ids[1])
  check(seen === true, 'mute reaches peers over the state data channel')
  const levels = await pages.get(ids[0]).evaluate(() => window.call.snapshot().participants.filter((p) => !p.self).map((p) => p.level))
  check(levels.some((l) => l > 0), `audio levels reported for active-speaker detection (${levels.map((l) => l.toFixed(3)).join(',')})`)
  // leave
  const leaver = ids[N - 1]
  await pages.get(leaver).evaluate(() => window.call.leave())
  roster.splice(roster.findIndex((m) => m.id === leaver), 1); pages.get(leaver).context().close(); pages.delete(leaver)
  await pushRoster()
  const sizes = await Promise.all([...pages.values()].map((p) => p.evaluate(() => window.call.peers.size)))
  check(sizes.every((s) => s === N - 2), `leaver dropped by everyone (peers: ${sizes.join(',')})`)
  // fill to 6 then a 7th
  const more = []
  for (let i = N; pages.size < 6; i++) { const id = `v${i}@velta.test`; more.push(id); await joinOne(id) }
  const six = [...pages.keys()]
  check(await allConnected(six), '6 participants (the cap): full mesh connected')
  await joinOne('z9@velta.test')
  const st = await pages.get('z9@velta.test').evaluate(() => window.call.snapshot())
  check(st.state === 'full' && (await pages.get('z9@velta.test').evaluate(() => window.call.peers.size)) === 0, '7th joiner: state "full", no connections')
  // --- Phase 2: GroupCallSession over a shared fake chat (status updates to
  // everyone, realtime only between realtime clients; "pwa" has none).
  for (const p of pages.values()) await p.context().close()
  pages.clear()
  const rows = []; const rtMembers = new Set(); const sp = new Map(); const stats = { rt: 0, upd: 0 }
  async function sessionClient(id, rt) {
    const ctx = await browser.newContext({ permissions: ['microphone'] })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.log(`  [${id} pageerror]`, e.message))
    await page.exposeFunction('coreCall', async (m, a) => {
      if (m === 'getWebxdcStatusUpdates') return JSON.stringify(rows.filter((r) => r.serial > a[1]))
      if (m === 'sendWebxdcStatusUpdate') { stats.upd++; const row = { ...JSON.parse(a[1]), serial: rows.length + 1 }; rows.push(row); for (const o of sp.values()) o.evaluate((n) => window.session.onStatusUpdate(n), row.serial).catch(() => {}); return null }
      if (m === 'sendWebxdcRealtimeAdvertisement') { if (!rt) throw new Error('no realtime'); rtMembers.add(id); return null }
      if (m === 'sendWebxdcRealtimeData') { stats.rt++; for (const [oid, o] of sp) if (oid !== id && rtMembers.has(oid)) o.evaluate((d) => window.session.onRealtime(d), a[1]).catch(() => {}); return null }
      if (m === 'leaveWebxdcRealtime') { rtMembers.delete(id); return null }
      if (m === 'iceServers') return []
      throw new Error('unexpected core call ' + m)
    })
    await page.goto(`${BASE}/session?id=${id}&rt=${rt ? 1 : 0}`)
    await page.waitForFunction(() => window.ready)
    sp.set(id, page)
    await page.evaluate(() => window.session.start())
    return page
  }
  const sids = ['desk@velta.test', 'droid@velta.test', 'pwa@velta.test']
  await sessionClient(sids[0], true); await sessionClient(sids[1], true); await sessionClient(sids[2], false)
  let meshOk = false
  for (let i = 0; i < 60 && !meshOk; i++) {
    meshOk = true
    for (const p of sp.values()) { const n = await p.evaluate(async () => { let c = 0; for (const x of window.session.call.peers.values()) { let b = 0; (await x.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') b = r.bytesReceived }); if (x.state === 'connected' && b > 2000) c++ } return c }); if (n !== 2) meshOk = false }
    if (!meshOk) await new Promise((r) => setTimeout(r, 500))
  }
  check(meshOk, 'sessions: desktop + Android (realtime) + PWA (status updates only) all hear each other')
  check(stats.rt > 0, `sessions: realtime carried the realtime pair (${stats.rt} frames)`)
  const sdpRows = rows.filter((r) => ['offer', 'answer'].includes(r.payload?.veltaCall?.t))
  check(sdpRows.length > 0 && sdpRows.every((r) => [r.payload.veltaCall.from, r.payload.veltaCall.to].includes(sids[2]) || r.payload.veltaCall.try >= 2), `sessions: SDP in status updates only for the PWA pairs (${sdpRows.length} rows)`)
  check(rows.filter((r) => r.info).length === 1 && /started a group call/.test(rows.find((r) => r.info).info), 'sessions: one "started a group call" info line')
  for (const p of sp.values()) { await p.evaluate(() => window.session.leave()); await new Promise((r) => setTimeout(r, 200)) }
  check(rows.at(-1).info === 'Group call ended', 'sessions: last leaver posts "Group call ended"')
} finally {
  await browser.close(); server.close(); turn?.kill()
}
if (failed) { console.log(`group call e2e: ${failed} FAILED`); process.exit(1) }
console.log('group call e2e: all checks passed')
