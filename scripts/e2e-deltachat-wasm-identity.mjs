// Day-17 V2.5 identity round-trip e2e (same harness as
// e2e-deltachat-wasm-network.mjs): one real throwaway account on the public
// chatmail relay, then:
//   configure → export_self_keys (passphrase) → grab tar via memfs side
//   channel → fresh account → same addr/password → import_self_keys →
//   configure → configured_addr must equal the original address.
// Proves the V2.5 identity-bundle plumbing (keys tar + passphrase + config
// restore) end-to-end. Client-side AES-GCM wrapping and the OPFS eviction
// path are covered by the local worker rig (spike log Day 16/17).
//
// Env: WS_TCP_PROXY (required), PACKAGE_ROOT, CHATMAIL_NEW, PROXY_PORT.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { chromium } from 'playwright'

const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'
const PROXY_PORT = process.env.PROXY_PORT ?? '8642'
const PROXY_SCRIPT = process.env.WS_TCP_PROXY
if (!PROXY_SCRIPT) {
  console.error('FAIL: set WS_TCP_PROXY=/path/to/ws-tcp-proxy.mjs (not vendored in Velta)')
  process.exit(2)
}

const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
const { email, password } = await resp.json()
console.log(`created throwaway account on ${new URL(CHATMAIL_NEW).host}`)

const proxy = fork(PROXY_SCRIPT, [], {
  env: { ...process.env, PORT: PROXY_PORT },
  stdio: 'inherit',
})
await new Promise((r) => setTimeout(r, 800))

const root = process.env.PACKAGE_ROOT
  ? process.env.PACKAGE_ROOT
  : fileURLToPath(new URL('../packages/deltachat-wasm', import.meta.url))
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
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
page.on('console', (m) => {
  const t = m.text()
  if (/error|warn|panic|failed|Failed|step/i.test(t)) console.log('[page]', t.slice(0, 500))
})
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

let failed = false
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min)')
  proxy.kill()
  process.exit(1)
}, 360_000)

try {
  const proxyUrl = `ws://127.0.0.1:${PROXY_PORT}`
  await page.goto(`http://127.0.0.1:${port}/example/index.html?proxy=${encodeURIComponent(proxyUrl)}`)
  await page.waitForFunction(() => window.__systemInfo || window.__bootError, null, { timeout: 120_000 })
  const bootErr = await page.evaluate(() => window.__bootError)
  if (bootErr) throw new Error(`boot failed: ${bootErr}`)
  console.log('core booted; configuring the throwaway account over IMAP/SMTP…')

  const result = await page.evaluate(async ({ email, password }) => {
    const rpc = window.rpc.request.bind(window.rpc)
    const PASS = 'v25-identity-pass'

    const id1 = await rpc('add_account')
    await rpc('batch_set_config', [id1, { addr: email, mail_pw: password }])
    await rpc('configure', [id1])
    await rpc('start_io', [id1])

    // imex treats the path as a DIRECTORY of armored key files.
    const exportDir = '/identity/export'
    await rpc('export_self_keys', [id1, exportDir, PASS])
    const entries = await window.core.fs_list(exportDir)
    const keysFiles = {}
    for (const entry of entries) {
      if (!entry.endsWith('/')) {
        const bytes = window.core.fs_read(entry)
        let b64 = ''
        const u8 = new Uint8Array(bytes)
        for (let i = 0; i < u8.length; i += 0x8000) {
          b64 += String.fromCharCode(...u8.subarray(i, i + 0x8000))
        }
        keysFiles[entry.split('/').pop()] = b64
      }
    }
    if (Object.keys(keysFiles).length === 0) throw new Error('self-keys export produced no files')

    const id2 = await rpc('add_account')
    await rpc('batch_set_config', [id2, { addr: email, mail_pw: password }])
    // configure FIRST: import_self_keys marks the account configured, which
    // would short-circuit a later configure() (configured_addr stays null).
    await rpc('configure', [id2])
    for (const [name, b64] of Object.entries(keysFiles)) {
      window.core.fs_write(`/identity/import/${name}`, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    }
    await rpc('import_self_keys', [id2, '/identity/import', PASS])
    const configuredAddr = await rpc('get_config', [id2, 'configured_addr'])
    return { configuredAddr }
  }, { email, password })

  if (result.configuredAddr !== email) {
    throw new Error(`configure after restore failed: configured_addr=${JSON.stringify(result.configuredAddr)}`)
  }
  console.log(`OK: identity round-trip — restored account re-configured as ${result.configuredAddr}`)
} catch (e) {
  console.error('FAIL:', e.message)
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  server.close()
  proxy.kill()
}
process.exit(failed ? 1 : 0)
