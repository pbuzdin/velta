#!/usr/bin/env node
// PWA call e2e: two Chromium contexts, each running the REAL PWA backend
// path (WorkerWasmTransport → worker-wasm.js → wasm core → JsonRpcCore) and
// the real calls.js CallManager. Signaling goes through the core over IMAP/
// SMTP (no node relay): place_outgoing_call → IncomingCall → call_info →
// accept_incoming_call → OutgoingCallAccepted. Checks ice_servers reach the
// RTCPeerConnection, video frames flow both ways, mid-call camera off/on,
// and that the speaker button is hidden (no shell audio route in a browser).
//
// Env: WASM_DIST (dir with velta_wasm.js + velta_wasm_bg.wasm, required),
//      WS_TCP_PROXY (ws-tcp-proxy.mjs, classic bridge), PROXY_PORT (8642),
//      or RELAY_WS_URL=wss://relay (C3 websockify on the relay itself),
//      CHATMAIL_NEW (default https://nine.testrun.org/new).
// Throwaway accounts; addresses and passwords are never printed.
import { createServer } from 'node:http'
import { execFileSync, fork } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const WASM_DIST = process.env.WASM_DIST
const PROXY_SCRIPT = process.env.WS_TCP_PROXY
const PROXY_PORT = process.env.PROXY_PORT ?? '8642'
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'
const RELAY_WS_URL = (process.env.RELAY_WS_URL ?? '').replace(/\/+$/, '')
if (!WASM_DIST || (!PROXY_SCRIPT && !RELAY_WS_URL)) { console.error('FAIL: set WASM_DIST and WS_TCP_PROXY or RELAY_WS_URL'); process.exit(2) }

const out = join(mkdtempSync(join(tmpdir(), 'velta-call-wasm-')), 'dist')
execFileSync(process.execPath, [join(repoRoot, 'scripts/build-pwa.mjs'), '--wasm-dist', WASM_DIST, '--out', out], { stdio: 'inherit' })
writeFileSync(join(out, 'call-harness.html'), `<!doctype html><meta charset="utf-8"><body><script type="module">
import { JsonRpcCore } from './js/rpc-core.js'
import { WorkerWasmTransport } from './js/transport-worker-wasm.js'
import { initCalls } from './js/calls.js'
const proxy = new URL(location.href).searchParams.get('proxy')
try {
  const core = new JsonRpcCore(new WorkerWasmTransport({ glueUrl: new URL('wasm/velta_wasm.js', location.href).href, wsProxyUrl: proxy }))
  await core.init()
  window.core = core
  window.toasts = []
  window.mgr = initCalls(core, { notify: (t) => window.toasts.push(String(t)) })
  window.__ready = true
} catch (e) { window.__bootError = String(e?.message || e); console.error(e) }
</script>`)

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' }
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
    if (!p.startsWith(out)) throw new Error('traversal')
    res.setHeader('content-type', types[extname(p)] ?? 'application/octet-stream')
    res.end(await readFile(p))
  } catch { res.statusCode = 404; res.end('nf') }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const proxy = RELAY_WS_URL ? null : fork(PROXY_SCRIPT, [], { env: { ...process.env, PORT: PROXY_PORT }, stdio: 'inherit' })
await new Promise((r) => setTimeout(r, 800))

const newAccount = async () => { const r = await fetch(CHATMAIL_NEW, { method: 'POST' }); if (!r.ok) throw new Error('account ' + r.status); return r.json() }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
const watchdog = setTimeout(() => { console.error('FAIL: watchdog (8 min)'); process.exit(1) }, 480_000)
let failed = false
const check = (ok, msg) => { console.log(`${ok ? 'ok' : 'FAIL'}: ${msg}`); if (!ok) failed = true }
try {
  const pages = []
  for (const who of ['A', 'B']) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, permissions: ['microphone', 'camera'] })
    const page = await ctx.newPage()
    page.on('console', (m) => { const t = m.text(); if (process.env.VERBOSE || /\[call\]|error|panic/i.test(t)) console.log(`[${who}]`, t.slice(0, 300)) })
    page.on('pageerror', (e) => console.error(`[${who} pageerror]`, e.message))
    await page.goto(`${base}/call-harness.html?proxy=${encodeURIComponent(RELAY_WS_URL || 'ws://127.0.0.1:' + PROXY_PORT)}`)
    await page.waitForFunction(() => window.__ready || window.__bootError, null, { timeout: 120_000 })
    const err = await page.evaluate(() => window.__bootError)
    if (err) throw new Error(`${who} boot: ${err}`)
    const acct = await newAccount()
    await page.evaluate(async ({ email, password }) => {
      const c = window.core
      await c._call('batch_set_config', c.accountId, { addr: email, mail_pw: password })
      await c._callWithTimeout(180000, 'configure', c.accountId)
      await c._call('start_io', c.accountId)
    }, acct)
    pages.push(page)
  }
  const [A, B] = pages
  console.log('two wasm cores configured')
  const vcard = await B.evaluate(() => window.core._call('make_vcard', window.core.accountId, [1]))
  const chatId = await A.evaluate(async (v) => {
    const c = window.core
    const ids = await c._call('import_vcard_contents', c.accountId, v)
    const chat = await c._call('create_chat_by_contact_id', c.accountId, ids[0])
    await c._call('misc_send_text_message', c.accountId, chat, 'hi before the call') // establishes keys/chat on B
    return chat
  }, vcard)
  // B must accept the chat or it is a contact request; the call still rings.
  const ice = await A.evaluate(() => window.core.iceServers())
  check(Array.isArray(ice), `ice_servers through the wasm core: ${JSON.stringify(ice.map((s) => ({ urls: s.urls, user: !!s.username })))}`)

  await A.evaluate((id) => window.mgr.startOutgoing(id, 'Bob', { video: true }), chatId)
  await B.waitForFunction(() => window.mgr.state === 'incoming', null, { timeout: 180_000 })
  const hasVideo = await B.evaluate(() => window.mgr.hasVideo ?? null)
  console.log('B rings (IncomingCall via the core), hasVideo =', hasVideo)
  await B.evaluate(() => window.mgr.acceptIncoming(true))
  await A.waitForFunction(() => window.mgr.state === 'active', null, { timeout: 180_000 })
  for (const P of [A, B]) await P.waitForFunction(() => window.mgr.pc?.connectionState === 'connected', null, { timeout: 60_000 })
  check(true, 'both peers connected (signaling through the wasm core)')
  const cfgIce = await A.evaluate(() => window.mgr.pc.getConfiguration().iceServers)
  check(JSON.stringify(cfgIce.map((s) => s.urls)) === JSON.stringify(ice.map((s) => s.urls)) || ice.length === 0, `RTCPeerConnection iceServers = core ice_servers (${cfgIce.length})`)
  const stats = (P) => P.evaluate(async () => {
    const o = { aIn: 0, vDec: 0, cand: '' }
    const st = await window.mgr.pc.getStats()
    for (const s of st.values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') o.aIn += s.packetsReceived || 0
      if (s.type === 'inbound-rtp' && s.kind === 'video') o.vDec += s.framesDecoded || 0
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        const l = st.get(s.localCandidateId); o.cand = l?.candidateType || ''
      }
    }
    return o
  })
  await A.waitForTimeout(4000)
  const a1 = await stats(A), b1 = await stats(B)
  check(a1.vDec > 20 && b1.vDec > 20 && a1.aIn > 50 && b1.aIn > 50, `media both ways: A ${JSON.stringify(a1)} B ${JSON.stringify(b1)}`)
  await A.evaluate(() => window.mgr.toggleVideo())
  await A.waitForTimeout(2500); const bOff = await stats(B); await A.waitForTimeout(2000); const bOff2 = await stats(B)
  check(bOff2.vDec - bOff.vDec < 5, `A camera off mid-call: B frames ${bOff.vDec}→${bOff2.vDec}`)
  await A.evaluate(() => window.mgr.toggleVideo())
  await A.waitForTimeout(3000); const bOn = await stats(B)
  check(bOn.vDec - bOff2.vDec > 20, `A camera back on: B frames ${bOff2.vDec}→${bOn.vDec}`)
  const ctl = await A.evaluate(() => window.mgr.controls().map((c) => c.id ?? c.action ?? c))
  check(!JSON.stringify(ctl).includes('speaker'), `no speaker button in the browser: ${JSON.stringify(ctl)}`)
  await A.evaluate(() => window.mgr.hangUp())
  await B.waitForFunction(() => ['ended', 'idle'].includes(window.mgr.state), null, { timeout: 120_000 })
  check(true, 'hangup reached B through the core (CallEnded)')
} catch (e) { console.error('FAIL:', e.message); failed = true } finally {
  clearTimeout(watchdog); await browser.close(); server.close(); proxy?.kill()
}
console.log(failed ? 'FAIL' : 'PASS: PWA (wasm core) video call both ways')
process.exit(failed ? 1 : 0)
