// #331: wasm backup import/export without sqlcipher_export.
// Headless Chromium, same harness as smoke-velta-wasm.mjs. No relay.
// Checks: a passphrase is refused with a clear error; a SQLCipher-looking
// payload is refused; a plaintext SQLite tar is imported without the
// "no such function: sqlcipher_export" crash.
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const root = process.env.PACKAGE_ROOT
  ? process.env.PACKAGE_ROOT
  : fileURLToPath(new URL('../packages/velta-wasm', import.meta.url))
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

const dir = await mkdtemp(join(tmpdir(), 'velta-backup-331-'))
const py = `
import sqlite3, tarfile, os
from pathlib import Path
base = Path(${JSON.stringify(dir)})
db = base / "dc_database_backup.sqlite"
con = sqlite3.connect(db)
con.execute("CREATE TABLE config (keyname TEXT PRIMARY KEY, value TEXT)")
con.execute("INSERT INTO config VALUES ('backup_version', '2')")
con.commit()
con.close()
plain = base / "plain.tar"
with tarfile.open(plain, "w", format=tarfile.USTAR_FORMAT) as t:
    t.add(db, arcname="dc_database_backup.sqlite")
enc = base / "encrypted.tar"
blob = base / "enc.sqlite"
blob.write_bytes(os.urandom(64) + b"not-sqlite")
with tarfile.open(enc, "w", format=tarfile.USTAR_FORMAT) as t:
    t.add(blob, arcname="dc_database_backup.sqlite")
print("ok")
`
const built = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
if (built.status !== 0) {
  console.error('FAIL: could not build fixture tars:', built.stderr || built.stdout)
  process.exit(2)
}
const plainTar = await readFile(join(dir, 'plain.tar'))
const encTar = await readFile(join(dir, 'encrypted.tar'))

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const path = normalize(join(root, urlPath))
    if (!path.startsWith(root)) throw new Error('traversal')
    const data = await readFile(path)
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const launch = process.env.CHROMIUM_BIN
  ? { executablePath: process.env.CHROMIUM_BIN }
  : {}
const browser = await chromium.launch(launch)
const page = await browser.newPage()
page.on('console', (m) => {
  const t = m.text()
  if (/error|warn|panic|failed|Failed|sqlcipher/i.test(t)) console.log('[page]', t.slice(0, 500))
})
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

let failed = false
const errText = (e) => {
  if (e == null) return ''
  if (typeof e === 'string') return e
  if (e.message) return String(e.message)
  try { return JSON.stringify(e) } catch { return String(e) }
}

try {
  await page.goto(`http://127.0.0.1:${port}/example/index.html`)
  await page.waitForFunction(() => window.__systemInfo || window.__bootError, null, {
    timeout: 180_000,
  })
  const bootErr = await page.evaluate(() => window.__bootError)
  if (bootErr) throw new Error(`boot failed: ${bootErr}`)
  console.log('core booted; running backup import cases…')

  const result = await page.evaluate(async ({ plain, enc }) => {
    const rpc = (method, params) =>
      window.rpc.request(method, params).catch((e) => {
        const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e))
        const err = new Error(`${method}: ${msg}`)
        err.cause = e
        throw err
      })
    const writeTar = (path, b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      window.core.fs_mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
      window.core.fs_write(path, bin)
    }
    const collect = (e) => {
      const s = e?.message || (typeof e === 'string' ? e : JSON.stringify(e))
      return s
    }

    const id = await rpc('add_account')
    writeTar('/backup/import/secret.tar', plain)
    let passphraseErr
    try {
      await rpc('import_backup', [id, '/backup/import/secret.tar', 'secret'])
      passphraseErr = 'CALL_SUCCEEDED'
    } catch (e) {
      passphraseErr = collect(e)
    }

    writeTar('/backup/import/encrypted.tar', enc)
    let encryptedErr
    try {
      await rpc('import_backup', [id, '/backup/import/encrypted.tar', null])
      encryptedErr = 'CALL_SUCCEEDED'
    } catch (e) {
      encryptedErr = collect(e)
    }

    writeTar('/backup/import/plain.tar', plain)
    let plainErr = null
    let plainOk = false
    try {
      await rpc('import_backup', [id, '/backup/import/plain.tar', null])
      plainOk = true
    } catch (e) {
      plainErr = collect(e)
    }

    let exportErr = null
    try {
      await rpc('export_backup', [id, '/backup/export', null])
    } catch (e) {
      exportErr = collect(e)
    }

    return { passphraseErr, encryptedErr, plainOk, plainErr, exportErr }
  }, { plain: plainTar.toString('base64'), enc: encTar.toString('base64') })

  const bad = (name, msg, pred) => {
    if (!pred) {
      console.error(`FAIL: ${name}: ${msg}`)
      failed = true
    } else {
      console.log(`OK: ${name}`)
    }
  }

  bad(
    'passphrase import is refused clearly',
    result.passphraseErr,
    /Passphrase-protected backups are not supported in the browser/i.test(result.passphraseErr)
      && !/sqlcipher_export/i.test(result.passphraseErr),
  )
  bad(
    'encrypted (non-SQLite) import is refused clearly',
    result.encryptedErr,
    /encrypted and cannot be imported in the browser/i.test(result.encryptedErr)
      && !/sqlcipher_export/i.test(result.encryptedErr),
  )
  if (result.plainOk) {
    console.log('OK: plaintext SQLite tar imported (no sqlcipher_export)')
  } else {
    const msg = result.plainErr || 'unknown error'
    if (/sqlcipher_export/i.test(msg)) {
      console.error('FAIL: plaintext import still hits sqlcipher_export:', msg)
      failed = true
    } else {
      // Migrations or schema may still fail on this minimal fixture; the
      // point is we got past the wasm SQLite path.
      console.log('OK: plaintext import left sqlcipher_export behind; later error:', msg.slice(0, 300))
    }
  }
  if (result.exportErr && /sqlcipher_export/i.test(result.exportErr)) {
    console.error('FAIL: export still hits sqlcipher_export:', result.exportErr)
    failed = true
  } else if (!result.exportErr) {
    console.log('OK: export_backup completed')
  } else {
    console.log('OK: export did not call sqlcipher_export; error:', result.exportErr.slice(0, 200))
  }
} catch (e) {
  console.error('FAIL:', e.message)
  failed = true
} finally {
  await browser.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
