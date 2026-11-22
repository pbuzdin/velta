#!/usr/bin/env node
// E2E for PWA Loop over WebRTC (#468, app/js/webrtc-loop.js): two Velta
// pages in headless Chromium, real RTCPeerConnections, no ICE servers at all
// (no STUN, no TURN): host candidates only, like two PWAs on one Wi-Fi.
// Signaling is relayed by this script in place of the encrypted Velta
// channel (createXdcSignal has its own unit test).
// Checks: a direct connection with the DTLS fingerprint verified against the
// pin, a chat line + ack, a 3 MB file streamed to OPFS and SHA-256 checked,
// cancel of a file in flight, a tampered answer refused ("pin"), and a path
// with no usable candidates reported as "failed" / "network".
// Usage: node scripts/e2e-webrtc-loop.mjs
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const server = createServer((q, r) => {
  if (q.url.startsWith('/js/') && /^[\w./-]+\.js$/.test(q.url) && !q.url.includes('..')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(readFileSync(root + 'app' + q.url)) }
  r.writeHead(200, { 'content-type': 'text/html' })
  r.end(`<!doctype html><body><script type="module">
import { LoopLink } from '/js/webrtc-loop.js'
const q = new URLSearchParams(location.search)
window.log = { states: [], texts: [], acks: [], files: [], progress: [] }
window.make = (opts = {}) => {
  window.link = new LoopLink({ selfId: q.get('id'), peerId: q.get('peer'), RTCPeerConnection,
    sendSignal: (s) => window.sigOut(s), connectTimeout: opts.connectTimeout || 15000, gatherTimeout: 2000,
    onState: (s, r) => window.log.states.push([s, r]), onText: (m) => window.log.texts.push(m.text), onAck: (id) => window.log.acks.push(id),
    onFileProgress: (p) => window.log.progress.push(p),
    onFile: async (f) => { const d = await crypto.subtle.digest('SHA-256', await f.file.arrayBuffer()); window.log.files.push({ name: f.name, size: f.size, sink: f.sink, sha: [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('') }) } })
  window.log = { states: [], texts: [], acks: [], files: [], progress: [] }
}
window.blob = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return new File([b], 'f' + seed + '.bin', { type: 'application/octet-stream' }) }
window.sha = async (f) => { const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer()); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('') }
window.ready = true
</script></body>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const ctx = await browser.newContext()
const pages = {}
let tamper = null // (sig) => sig
for (const [id, peer] of [['alice', 'bob'], ['bob', 'alice']]) {
  const p = await ctx.newPage()
  await p.exposeFunction('sigOut', async (s) => {
    const out = tamper ? tamper(s) : s
    if (out) await pages[peer].evaluate((x) => window.link.handleSignal(x), out)
  })
  await p.goto(`${base}?id=${id}&peer=${peer}`)
  await p.waitForFunction(() => window.ready)
  pages[id] = p
}
const { alice, bob } = pages
const fails = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what) }
const st = (p) => p.evaluate(() => window.link.state)
const until = async (p, fn, arg, ms = 20000) => { try { await p.waitForFunction(fn, arg, { timeout: ms }); return true } catch { return false } }

// 1. Connect, chat, file, cancel.
await alice.evaluate(() => window.make()); await bob.evaluate(() => window.make())
await alice.evaluate(() => window.link.connect())
check(await until(alice, () => window.link.state === 'direct') && await until(bob, () => window.link.state === 'direct'), 'both sides direct, no ICE servers')
check(await alice.evaluate(() => window.link.verified) && await bob.evaluate(() => window.link.verified), 'presented DTLS certificate matches the encrypted pin on both sides')
const id = await alice.evaluate(() => window.link.sendText('hello over WebRTC'))
check(await until(bob, () => window.log.texts.includes('hello over WebRTC')), 'chat line arrives')
check(await until(alice, (i) => window.log.acks.includes(i), id), 'chat line acked')
const want = await alice.evaluate(async () => { window.f = window.blob(3 * 1024 * 1024 + 123, 7); return window.sha(window.f) })
await alice.evaluate(() => window.link.sendFile(window.f))
check(await until(bob, () => window.log.files.length === 1), '3 MB file received')
const got = await bob.evaluate(() => window.log.files[0])
check(got && got.sha === want && got.size === 3 * 1024 * 1024 + 123, 'file SHA-256 and size match')
check(got && got.sink === 'opfs', `Chromium streams to OPFS (sink=${got && got.sink})`)
check(await alice.evaluate(() => window.log.progress.some((p) => p.dir === 'out' && p.done === p.size)), 'sender progress reaches 100%')
const cancelled = await alice.evaluate(async () => {
  const f = window.blob(40 * 1024 * 1024, 9)
  const p = window.link.sendFile(f).then(() => 'sent', (e) => String(e.message))
  await new Promise((r) => { const t = setInterval(() => { if (window.log.progress.some((x) => x.dir === 'out' && x.size === f.size)) { clearInterval(t); r() } }, 5) })
  window.link.cancelFile(window.log.progress.find((x) => x.size === f.size).id)
  return p
})
check(cancelled === 'cancelled', `sender cancel stops the transfer (${cancelled})`)
check(await until(bob, () => window.log.progress.some((p) => p.error === 'cancelled')), 'receiver sees the cancel and drops the partial')
check(await bob.evaluate(() => window.log.files.length === 1), 'cancelled file never delivered')
await alice.evaluate(() => window.link.close())
check(await until(bob, () => window.link.state === 'closed'), 'bye closes the peer')

// 2. Tampered answer: SDP fingerprint swapped in transit -> refused.
await alice.evaluate(() => window.make()); await bob.evaluate(() => window.make())
tamper = (s) => s.t === 'answer' ? { ...s, sdp: s.sdp.replace(/a=fingerprint:sha-256 ([0-9A-F]{2})/, (_m, h) => `a=fingerprint:sha-256 ${h === '00' ? '11' : '00'}`) } : s
await alice.evaluate(() => window.link.connect())
check(await until(alice, () => window.link.state === 'failed' && window.link.reason === 'pin'), 'tampered SDP refused: failed / pin')

// 3. No usable path (all candidates stripped, as on an isolating network).
tamper = (s) => s.sdp ? { ...s, sdp: s.sdp.split('\r\n').filter((l) => !l.startsWith('a=candidate')).join('\r\n') } : s
await alice.evaluate(() => window.make({ connectTimeout: 6000 })); await bob.evaluate(() => window.make({ connectTimeout: 6000 }))
await alice.evaluate(() => window.link.connect())
check(await until(alice, () => window.link.state === 'failed' && window.link.reason === 'network', undefined, 15000), 'no path: failed / network (no silent relay)')
tamper = null

await browser.close(); server.close()
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1) }
console.log('\nall WebRTC Loop checks passed')
