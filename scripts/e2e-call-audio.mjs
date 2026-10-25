#!/usr/bin/env node
// Call media check (#141): two Velta clients, each a CallManager
// (app/js/calls.js) in its own headless Chromium page, signaling relayed
// through this script (the core's role: offer -> incoming-call, answer ->
// outgoing-call-accepted). Fake mic + camera (--use-fake-device-for-media-
// stream: a beep and a test pattern).
//
// 1. Audio call: audio RTP both ways, SDP audio sendrecv, the offer carries
//    a video m-line (camera can be turned on later), no video frames sent.
// 2. Video call: video frames decoded on both sides, remote video shown,
//    local preview shown.
// 3. Mid-call toggle: B turns its camera off -> A hides B's video (data
//    channel mutedState) and B's video stops; on again -> frames flow again.
// Also fails when the call buttons overflow at 320px.
// Before the #141 fix the mic was never added to the peer connection: the
// offer was recvonly and no side sent a single packet.
// Usage: node scripts/e2e-call-audio.mjs [--shots DIR]
//   --shots writes 360x740 screens: call-audio-photo.png, call-audio-initial.png,
//   call-video-pip.png (+ call-buttons-320.png)
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
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }

// A canvas "profile photo" for the avatar screenshot.
const PHOTO = `(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, '#f6b26b'); gr.addColorStop(1, '#8e4fc9'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#ffe0c2'; g.beginPath(); g.arc(128, 104, 52, 0, 7); g.fill(); g.beginPath(); g.ellipse(128, 250, 92, 78, 0, 0, 7); g.fill();
  g.fillStyle = '#4a2c1a'; g.beginPath(); g.arc(128, 86, 54, Math.PI, 0); g.fill(); return c.toDataURL('image/png') })()`

// One client page. peer = { name, color, photo }.
async function client(name, peer) {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } })
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message))
  await page.goto(`${base}/__call.html`)
  await page.evaluate(async ({ name, peer, PHOTO }) => {
    const { CallManager } = await import('/js/calls.js')
    const core = new EventTarget()
    core.emit = (n, detail) => core.dispatchEvent(Object.assign(new Event(n), { detail }))
    core.iceServers = async () => []
    core.placeOutgoingCall = async (chatId, sdp, hasVideo) => { window.__out({ t: 'offer', sdp, hasVideo }); return 1 }
    core.callInfo = async () => ({ sdpOffer: window.__offer, hasVideo: window.__hasVideo })
    core.acceptIncomingCall = async (msgId, sdp) => { window.__out({ t: 'answer', sdp }) }
    core.endCall = async () => window.__out({ t: 'end' })
    window.__core = core
    window.__logs = []
    const route = { supported: true, start: async (s) => (s ? 'speaker' : 'earpiece'), setSpeaker: async (s) => (s ? 'speaker' : 'earpiece'), stop: async () => {} }
    const photo = peer.photo ? eval(PHOTO) : ''
    window.mgr = new CallManager(core, null, null, (m) => window.__logs.push('! ' + m), route, (m) => window.__logs.push(m), {
      peerInfo: async () => ({ name: peer.name, addr: peer.addr, color: peer.color, avatarUrl: photo }),
    })
    window.mgr.bind()
  }, { name, peer, PHOTO })
  return page
}

async function connect(A, B, { video }) {
  const box = {}
  await A.exposeFunction('__out', (m) => { if (m.t === 'offer') box.offer = m; if (m.t === 'end') B.evaluate(() => window.__core.emit('call-ended', { msgId: 1 })) })
  await B.exposeFunction('__out', (m) => { if (m.t === 'answer') box.answer = m; if (m.t === 'end') A.evaluate(() => window.__core.emit('call-ended', { msgId: 1 })) })
  await A.evaluate((video) => window.mgr.startOutgoing(1, 'Bob', { video }), video)
  for (let i = 0; i < 50 && !box.offer; i++) await sleep(100)
  await B.evaluate(({ sdp, hasVideo }) => { window.__offer = sdp; window.__hasVideo = hasVideo; window.__core.emit('incoming-call', { msgId: 1, chatId: 1, hasVideo }) }, box.offer)
  await sleep(200)
  await B.evaluate(() => window.mgr.acceptIncoming())
  for (let i = 0; i < 50 && !box.answer; i++) await sleep(100)
  await A.evaluate((sdp) => window.__core.emit('outgoing-call-accepted', { msgId: 1, chatId: 1, acceptCallInfo: sdp }), box.answer.sdp)
  for (let i = 0; i < 100; i++) {
    const ok = await Promise.all([A, B].map(p => p.evaluate(() => window.mgr.pc?.connectionState === 'connected')))
    if (ok.every(Boolean)) break
    await sleep(100)
  }
  return box
}

const stats = (page) => page.evaluate(async () => {
  const out = { aSent: 0, aRecv: 0, vSent: 0, vDecoded: 0 }
  if (!window.mgr.pc) return out
  for (const s of (await window.mgr.pc.getStats()).values()) {
    if (s.type === 'outbound-rtp' && s.kind === 'audio') out.aSent += s.packetsSent || 0
    if (s.type === 'inbound-rtp' && s.kind === 'audio') out.aRecv += s.packetsReceived || 0
    if (s.type === 'outbound-rtp' && s.kind === 'video') out.vSent += s.framesEncoded || 0
    if (s.type === 'inbound-rtp' && s.kind === 'video') out.vDecoded += s.framesDecoded || 0
  }
  return out
})
const ui = (page) => page.evaluate(() => {
  const box = document.getElementById('call-overlay')
  const rv = box?.querySelector('.call-remote-video'), lv = box?.querySelector('.call-local-video')
  const btns = [...(box?.querySelectorAll('.call-actions button') || [])]
  return {
    remoteShown: !!rv && !rv.hidden && rv.videoWidth > 0,
    localShown: !!lv && !lv.hidden,
    avatarShown: !!box && !box.querySelector('.call-avatar').hidden,
    buttons: btns.map(b => b.getAttribute('aria-label')),
    overflow: btns.some(el => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5 }),
    status: box?.querySelector('.call-status')?.textContent,
    sdpVideo: window.mgr.videoTx ? 'yes' : 'no',
  }
})
const hangup = async (A, B) => { await A.evaluate(() => window.mgr.hangUp()); await sleep(300); await Promise.all([A, B].map(p => p.close())) }

try {
  // 1. Audio call (B has a profile photo; A shows Bob with an initial).
  {
    const A = await client('A', { name: 'Bob', addr: 'bob@example.org', color: '#2a7fba' })
    const B = await client('B', { name: 'Alice Doe', addr: 'alice@example.org', color: '#c0392b', photo: true })
    const box = await connect(A, B, { video: false })
    await sleep(2500)
    const [sa, sb] = [await stats(A), await stats(B)]
    console.log('audio call stats', JSON.stringify({ A: sa, B: sb }))
    check(/a=sendrecv/.test(box.offer.sdp.split('m=audio')[1] || '') && /m=video [1-9]/.test(box.offer.sdp), 'audio call offer: audio sendrecv + video m-line')
    check(/m=application/.test(box.offer.sdp), 'offer carries the data channels (iceTrickling/mutedState)')
    check(box.offer.hasVideo === false, 'audio call placed with hasVideo=false')
    check(sa.aSent > 0 && sb.aSent > 0 && sa.aRecv > 0 && sb.aRecv > 0, 'audio RTP flows both ways')
    check(sa.vSent === 0 && sb.vSent === 0, 'no video frames in an audio call')
    const ua = await ui(A)
    check(ua.avatarShown && !ua.remoteShown && !ua.localShown, 'audio call: avatar, no video')
    check(!ua.overflow, `buttons fit 360px: ${ua.buttons.join(', ')}`)
    if (shots) {
      await A.screenshot({ path: join(shots, 'call-audio-initial.png') })
      await B.screenshot({ path: join(shots, 'call-audio-photo.png') })
    }
    // 3. Mid-call toggle in an audio call: B turns its camera on, then off.
    await B.evaluate(() => window.mgr.toggleVideo())
    await sleep(2500)
    const on1 = await stats(A), uaOn = await ui(A), ubOn = await ui(B)
    check(on1.vDecoded > 0 && uaOn.remoteShown, `camera on mid-call: A decodes B's video (${on1.vDecoded} frames)`)
    check(ubOn.localShown && ubOn.buttons.includes('Switch camera') === false || ubOn.localShown, 'B shows its local preview')
    await B.evaluate(() => window.mgr.toggleVideo())
    await sleep(1500)
    const off1 = await stats(A), uaOff = await ui(A), ubOff = await ui(B)
    await sleep(1000)
    const off2 = await stats(A)
    check(!uaOff.remoteShown && uaOff.avatarShown, 'camera off mid-call: A hides B\'s video (mutedState), avatar back')
    check(off2.vDecoded - off1.vDecoded <= 2, `camera off: no new frames (${off1.vDecoded} -> ${off2.vDecoded})`)
    check(!ubOff.localShown, 'B hides its local preview')
    await B.evaluate(() => window.mgr.toggleVideo())
    await sleep(2000)
    const on2 = await stats(A)
    check(on2.vDecoded > off2.vDecoded + 5 && (await ui(A)).remoteShown, `camera on again: frames flow (${off2.vDecoded} -> ${on2.vDecoded})`)
    await hangup(A, B)
  }
  // 2. Video call both ways.
  {
    const A = await client('A', { name: 'Bob', addr: 'bob@example.org', color: '#2a7fba' })
    const B = await client('B', { name: 'Alice Doe', addr: 'alice@example.org', color: '#c0392b', photo: true })
    const box = await connect(A, B, { video: true })
    await sleep(3000)
    const [sa, sb] = [await stats(A), await stats(B)]
    console.log('video call stats', JSON.stringify({ A: sa, B: sb }))
    check(box.offer.hasVideo === true, 'video call placed with hasVideo=true')
    check(sa.vDecoded > 10 && sb.vDecoded > 10, 'video frames decoded on both sides')
    check(sa.aSent > 0 && sb.aSent > 0, 'audio flows in the video call')
    const [ua, ub] = [await ui(A), await ui(B)]
    check(ua.remoteShown && ua.localShown && !ua.avatarShown, 'A: remote video full screen + local PiP')
    check(ub.remoteShown && ub.localShown, 'B: remote video full screen + local PiP')
    const speakerA = await A.evaluate(() => window.mgr.speaker)
    check(speakerA === true, 'video call defaults to the loudspeaker')
    if (shots) await A.screenshot({ path: join(shots, 'call-video-pip.png') })
    // A turns its camera off: B hides A's video.
    await A.evaluate(() => window.mgr.toggleVideo())
    await sleep(1500)
    check(!(await ui(B)).remoteShown && (await A.evaluate(() => window.mgr.speaker)) === false, 'A camera off: B shows the avatar, A back to earpiece')
    // 320px buttons.
    await A.evaluate(() => window.mgr.toggleVideo())
    await sleep(500)
    await A.setViewportSize({ width: 320, height: 640 })
    // Fake devices expose one camera; pretend two so the full row (with
    // Switch camera) is measured.
    await A.evaluate(() => { window.mgr.cameraCount = 2; window.mgr.render() })
    await sleep(200)
    const u320 = await ui(A)
    check(!u320.overflow && u320.buttons.length === 6, `buttons fit 320px: ${u320.buttons.join(', ')}`)
    if (shots) await A.screenshot({ path: join(shots, 'call-buttons-320.png') })
    for (const l of await A.evaluate(() => window.__logs.slice(0, 40))) console.log('  A log:', l)
    await hangup(A, B)
  }
} finally {
  await browser.close()
  server.close()
}
console.log(failures.length ? `FAIL: ${failures.length} check(s)` : 'PASS: audio + video calls, mid-call camera toggle, buttons fit')
process.exit(failures.length ? 1 : 0)
