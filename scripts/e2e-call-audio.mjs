#!/usr/bin/env node
// #141 call media check: two CallManagers (app/js/calls.js) in one headless
// Chromium page, signaling looped back through two in-page fake cores, fake
// microphone (--use-fake-device-for-media-stream: a beep). Passes when BOTH
// directions carry audio RTP (outbound packetsSent > 0 on each side, inbound
// packetsReceived > 0 on each side) and both SDPs are sendrecv. Before the
// #141 fix the mic was opened but never added to the peer connection: the
// offer was recvonly and no side sent a single packet.
// Also screenshots the call overlay with the Android speaker toggle at
// 320x640 and fails on horizontal overflow of the call buttons.
// Usage: node scripts/e2e-call-audio.mjs [--shots DIR]
//   (needs `npx playwright install chromium`, or CHROMIUM_PATH=/path/to/chrome)
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const args = process.argv.slice(2)
const shots = (() => { const i = args.indexOf('--shots'); return i >= 0 ? args[i + 1] : null })()
if (shots) mkdirSync(shots, { recursive: true })
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/__call.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/css/main.css"></head><body></body></html>')
  }
  const p = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '')
  const f = join(appRoot, p)
  if (!f.startsWith(appRoot) || !existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } })
  await page.goto(`${base}/__call.html`)
  const result = await page.evaluate(async () => {
    const { CallManager, sdpAudioDirection } = await import('/js/calls.js')
    const mkCore = () => {
      const t = new EventTarget()
      t.emit = (name, detail) => t.dispatchEvent(Object.assign(new Event(name), { detail }))
      t.iceServers = async () => []
      t.getChat = async () => ({ name: 'Peer' })
      return t
    }
    const A = mkCore(), B = mkCore()
    const sdp = {}
    A.placeOutgoingCall = async (chatId, offer) => { sdp.offer = offer; setTimeout(() => B.emit('incoming-call', { msgId: 1, chatId: 1 }), 0); return 1 }
    B.callInfo = async () => ({ sdpOffer: sdp.offer, hasVideo: false })
    B.acceptIncomingCall = async (msgId, answer) => { sdp.answer = answer; setTimeout(() => A.emit('outgoing-call-accepted', { msgId: 1, chatId: 1, acceptCallInfo: answer }), 0) }
    A.endCall = async () => B.emit('call-ended', { msgId: 1 })
    B.endCall = async () => A.emit('call-ended', { msgId: 1 })
    const logs = []
    const route = { supported: true, start: async (s) => (s ? 'speaker' : 'earpiece'), setSpeaker: async (s) => (s ? 'speaker' : 'earpiece'), stop: async () => {} }
    const a = new CallManager(A, null, null, (m) => logs.push('A! ' + m), route, (m) => logs.push('A ' + m))
    const b = new CallManager(B, null, null, (m) => logs.push('B! ' + m), route, (m) => logs.push('B ' + m))
    a.bind(); b.bind()
    await a.startOutgoing(1, 'Bob')
    for (let i = 0; i < 50 && b.state !== 'incoming'; i++) await new Promise(r => setTimeout(r, 100))
    await b.acceptIncoming()
    for (let i = 0; i < 100 && !(a.pc?.connectionState === 'connected' && b.pc?.connectionState === 'connected'); i++) await new Promise(r => setTimeout(r, 100))
    await new Promise(r => setTimeout(r, 2500)) // let RTP flow
    const rtp = async (pc) => {
      const out = { sent: 0, received: 0 }
      for (const s of (await pc.getStats()).values()) {
        if (s.kind !== 'audio') continue
        if (s.type === 'outbound-rtp') out.sent += s.packetsSent || 0
        if (s.type === 'inbound-rtp') out.received += s.packetsReceived || 0
      }
      return out
    }
    const res = {
      states: [a.state, b.state, a.pc?.connectionState, b.pc?.connectionState],
      offerDir: sdpAudioDirection(sdp.offer), answerDir: sdpAudioDirection(sdp.answer),
      a: await rtp(a.pc), b: await rtp(b.pc), logs,
    }
    // Overlay with the speaker toggle (caller side, active, loudspeaker on).
    await a.toggleSpeaker()
    a.render('Connected', a.controls())
    const box = document.querySelector('#call-overlay .call-actions')
    const btn = document.querySelector('[data-call="speaker"]')
    res.overlay = {
      buttons: [...box.querySelectorAll('button')].map(b => b.textContent.trim()),
      pressed: btn?.getAttribute('aria-pressed'),
      overflow: [...box.querySelectorAll('button')].some(el => el.getBoundingClientRect().right > innerWidth + 0.5 || el.getBoundingClientRect().left < -0.5),
    }
    return res
  })
  if (shots) await page.screenshot({ path: join(shots, 'call-overlay-320.png') })
  console.log(JSON.stringify({ ...result, logs: undefined }, null, 1))
  for (const l of result.logs) console.log('  log:', l)
  const ok = result.offerDir === 'sendrecv' && result.answerDir === 'sendrecv' &&
    result.a.sent > 0 && result.b.sent > 0 && result.a.received > 0 && result.b.received > 0 &&
    result.overlay.pressed === 'true' && !result.overlay.overflow
  console.log(ok ? 'PASS: audio flows both ways, speaker toggle renders' : 'FAIL')
  failed = !ok
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
