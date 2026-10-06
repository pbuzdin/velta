// Day-9 alice→bob networking e2e against the IN-REPO MPL wrapper
// (packages/deltachat-wasm built from an apply-on-copy workspace).
//
// Two transports:
//   classic (default) — browser wasm core → local ws-tcp-proxy (generic
//     design-G bridge, Unlicense, NOT vendored into Velta) → public chatmail
//     relay (default nine.testrun.org). No relay changes required.
//   relay-native (RELAY_WS_URL set) — the core dials the relay's own
//     websockify endpoints directly (wss://relay + /tcp/{host}/{port} +
//     /dns/{host}, the C3 branch on pbuzdin/relay); TLS stays in wasm, so
//     the relay bridges to imaps/smtps. No local proxy involved.
// Two throwaway accounts from CHATMAIL_NEW; addresses and passwords are
// never printed.
//
// Env:
//   PACKAGE_ROOT   built wrapper dir containing example/ + wasm-dist/
//                  (default: ../packages/deltachat-wasm)
//   WS_TCP_PROXY   path to ws-tcp-proxy.mjs (classic mode)
//   RELAY_WS_URL   wss://relay origin running the C3 websockify scheme
//                  (relay-native mode; wins over WS_TCP_PROXY)
//   CHATMAIL_NEW   account factory (default https://nine.testrun.org/new)
//   PROXY_PORT     default 8641
//   CHROMIUM_BIN   optional system Chrome/Chromium
//   VERBOSE=1      dump all page console lines
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { chromium } from 'playwright'

const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'
const PROXY_PORT = process.env.PROXY_PORT ?? '8641'
const RELAY_WS_URL = (process.env.RELAY_WS_URL ?? '').replace(/\/+$/, '')
const PROXY_SCRIPT = process.env.WS_TCP_PROXY
if (!RELAY_WS_URL && !PROXY_SCRIPT) {
  console.error('FAIL: set WS_TCP_PROXY=/path/to/ws-tcp-proxy.mjs (classic bridge) or RELAY_WS_URL=wss://relay (relay-native, C3)')
  process.exit(2)
}

async function newAccount() {
  const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
  if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
  return resp.json()
}
const alice = await newAccount()
const bob = await newAccount()
console.log(`created 2 throwaway accounts on ${new URL(CHATMAIL_NEW).host}`)

let proxy = null
if (PROXY_SCRIPT && !RELAY_WS_URL) {
  proxy = fork(PROXY_SCRIPT, [], {
    env: { ...process.env, PORT: PROXY_PORT },
    stdio: 'inherit',
  })
  await new Promise((r) => setTimeout(r, 800))
}

const root = process.env.PACKAGE_ROOT
  ? process.env.PACKAGE_ROOT
  : fileURLToPath(new URL('../packages/deltachat-wasm', import.meta.url))
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
}
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
    if (!p.startsWith(root)) throw new Error('traversal')
    res.setHeader('content-type', types[extname(p)] ?? 'application/octet-stream')
    res.end(await readFile(p))
  } catch {
    res.statusCode = 404
    res.end('nf')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {},
)
const page = await browser.newPage()
const verbose = !!process.env.VERBOSE
page.on('console', (m) => {
  const t = m.text()
  if (verbose || /error|warn|panic|failed|Failed|step/i.test(t)) console.log('[page]', t.slice(0, 500))
})
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

let failed = false
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min)')
  proxy?.kill()
  process.exit(1)
}, 360_000)

const t0 = Date.now()
try {
  const proxyUrl = RELAY_WS_URL || `ws://127.0.0.1:${PROXY_PORT}`
  await page.goto(
    `http://127.0.0.1:${port}/example/index.html?proxy=${encodeURIComponent(proxyUrl)}`,
  )
  await page.waitForFunction(() => window.__systemInfo || window.__bootError, null, { timeout: 120_000 })
  const bootErr = await page.evaluate(() => window.__bootError)
  if (bootErr) throw new Error(`boot failed: ${bootErr}`)
  console.log('core booted, configuring alice+bob over IMAP/SMTP through the proxy…')

  const result = await page.evaluate(
    async ({ alice, bob }) => {
      const rpc = window.rpc.request.bind(window.rpc)

      const listeners = []
      ;(async () => {
        for (;;) {
          try {
            const ev = await rpc('get_next_event')
            for (const l of listeners) {
              try { await l(ev) } catch (e) { console.error('[listener]', e) }
            }
          } catch (e) {
            console.error('[events]', JSON.stringify(e))
            await new Promise((r) => setTimeout(r, 500))
          }
        }
      })()

      const setup = async ({ email, password }) => {
        console.log('[step] add_account')
        const id = await rpc('add_account')
        console.log('[step] batch_set_config', id)
        await rpc('batch_set_config', [
          id,
          { addr: email, mail_pw: password },
        ])
        console.log('[step] configure', id)
        try {
          await rpc('configure', [id])
        } catch (err) {
          throw new Error(`configure failed: ${JSON.stringify(err)}`)
        }
        await rpc('start_io', [id])
        return id
      }

      const aliceId = await setup(alice)
      const bobId = await setup(bob)

      const marker = 'wasm-roundtrip-' + Math.random().toString(36).slice(2)
      const arrived = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for message delivery')),
          120_000,
        )
        listeners.push(async (ev) => {
          if (ev.contextId !== bobId) return
          if (!ev.event || ev.event.kind !== 'IncomingMsg') return
          const msgId = ev.event.msgId ?? ev.event.msg_id
          if (msgId == null) return
          const msg = await rpc('get_message', [bobId, msgId])
          if (msg.text && msg.text.includes(marker)) {
            clearTimeout(timer)
            resolve(msg.text)
          }
        })
      })

      const vcard = await rpc('make_vcard', [bobId, [1]])
      const contactIds = await rpc('import_vcard_contents', [aliceId, vcard])
      const chatId = await rpc('create_chat_by_contact_id', [aliceId, contactIds[0]])
      await rpc('misc_send_text_message', [aliceId, chatId, marker])

      const text = await arrived
      return { ok: true, text, marker }
    },
    { alice, bob },
  )

  if (!result?.ok) {
    console.error('FAIL:', result)
    failed = true
  } else {
    const t1 = Date.now()
    console.log(
      `OK: two accounts configured over the WS tunnel; alice→bob message delivered:\n  ${result.text}`,
    )
    console.log(`elapsed: ${((t1 - t0) / 1000).toFixed(1)} s (boot+configure×2+send+receive)`)
  }
} catch (e) {
  console.error('FAIL:', e.message)
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  server.close()
  proxy?.kill()
}
process.exit(failed ? 1 : 0)
