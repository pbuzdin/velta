// Headless Chromium smoke: get_system_info + memfs roundtrip on 2.62 side-tree artifact.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = process.env.PACKAGE_ROOT
  ? process.env.PACKAGE_ROOT
  : fileURLToPath(new URL('../packages/deltachat-wasm', import.meta.url))
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const path = normalize(join(root, urlPath))
    if (!path.startsWith(root)) throw new Error('traversal')
    const data = await readFile(path)
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    // SharedArrayBuffer / OPFS not required for ephemeral smoke
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {},
)
const page = await browser.newPage()
page.on('console', (m) => console.log('[page]', m.text().slice(0, 400)))
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

let failed = false
try {
  const proxy = process.env.WS_PROXY_URL
  const q = proxy ? `?proxy=${encodeURIComponent(proxy)}` : ''
  await page.goto(`http://127.0.0.1:${port}/example/index.html${q}`)
  await page.waitForFunction(() => window.__systemInfo || window.__bootError, null, {
    timeout: 180_000,
  })
  const err = await page.evaluate(() => window.__bootError)
  if (err) {
    console.error('FAIL: boot error:', err)
    failed = true
  } else {
    const info = await page.evaluate(() => window.__systemInfo)
    if (!info || !info.deltachat_core_version) {
      console.error('FAIL: unexpected get_system_info:', JSON.stringify(info))
      failed = true
    } else {
      console.log(
        `OK: core ${info.deltachat_core_version} answered get_system_info (sqlite ${info.sqlite_version ?? '?'}, arch ${info.arch ?? '?'})`,
      )
      const fsOk = await page.evaluate(() => window.__fsOk === true)
      if (!fsOk) {
        console.error('FAIL: memfs roundtrip marker missing')
        failed = true
      } else {
        console.log('OK: memfs side channel roundtrip')
      }
    }
  }
} catch (e) {
  console.error('FAIL:', e.message)
  failed = true
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
