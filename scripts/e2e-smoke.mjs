#!/usr/bin/env node
// Real-browser smoke: demo boot, open a chat, send a message, no JS errors.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const file = join(appRoot, path || 'index.html')
  if (!file.startsWith(appRoot) || !existsSync(file)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    const url = message.location().url
    // Boot deliberately probes the native blob scheme and optional version.txt.
    // The probe origin is the blobfile scheme as a protocol (packaged shell)
    // or as a hostname (browser/dev), depending on context.
    const expectedProbe = url === 'blobfile://localhost/__velta-probe' || url === 'http://blobfile.localhost/__velta-probe' || /\/version\.txt$/.test(url)
    if (message.type() === 'error' && !expectedProbe) errors.push(`${message.text()} (${url})`)
  })
  await page.addInitScript(() => localStorage.setItem('velta-mock', '1'))
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await page.locator('.chat-item', { hasText: 'Ada Byron' }).first().click({ timeout: 15000 })
  await page.locator('#chat-view').waitFor({ state: 'visible' })
  const text = `Browser smoke ${Date.now()}`
  await page.locator('#composer-input').fill(text)
  await page.locator('#btn-send').click()
  await page.locator('.msg-row .msg-text').filter({ hasText: text }).last().waitFor({ timeout: 5000 })
  assert.equal(await page.locator('#composer-input').inputValue(), '')
  assert.deepEqual(errors, [])
  console.log('OK: demo boot, chat open, message send, no unexpected browser errors')

  // One-row composer at every width: attach, field, send. Typing never
  // reflows the row; the arrow fills only while armed (text, staged file,
  // or voice); Apps/Commands/Send later/Stickers live in the attach menu.
  const bar = page.locator('#main-composer')
  const state = () => bar.evaluate(el => ({
    display: getComputedStyle(el).display,
    armed: el.classList.contains('armed'),
  }))
  assert.equal((await state()).display, 'flex', 'rest: single-row flex composer')
  assert.equal((await state()).armed, false, 'rest: send unarmed')
  const gutters = () => page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect()
    const a = r('#btn-attach'); const w = r('.composer-input-wrap'); const d = r('#btn-send')
    return [Math.round(w.left - a.right), Math.round(d.left - w.right)]
  })
  assert.deepEqual(await gutters(), [8, 8], 'rest: equal gutters around the field')
  await page.locator('#composer-input').fill('M '.repeat(80))
  assert.deepEqual(await state(), { display: 'flex', armed: true }, 'typing: same row, armed')
  assert.deepEqual(await gutters(), [8, 8], 'typing: gutters unchanged — no second row')
  const h = await page.locator('#composer-input').evaluate(el => el.clientHeight)
  assert.ok(h > 55 && h <= 95, `field capped at three lines, clientHeight ${h}`)
  await page.locator('#composer-input').fill('')
  assert.deepEqual(await state(), { display: 'flex', armed: false }, 'clear: same row, disarmed')
  for (const id of ['btn-apps', 'btn-commands', 'btn-send-later', 'btn-sticker']) {
    assert.equal(await page.evaluate(i => document.getElementById(i), id), null, `${id}: gone from the composer`)
  }

  // Touch: focus alone must not grow a second row (the old phone jump).
  const touch = await browser.newPage({ viewport: { width: 390, height: 800 } })
  const touchErrors = []
  touch.on('pageerror', e => touchErrors.push(e.message))
  await touch.addInitScript(() => localStorage.setItem('velta-mock', '1'))
  await touch.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await touch.locator('.chat-item', { hasText: 'Ada Byron' }).first().click({ timeout: 15000 })
  await touch.locator('#chat-view').waitFor({ state: 'visible' })
  await touch.locator('#composer-input').focus()
  assert.equal(await touch.evaluate(() => getComputedStyle(document.getElementById('main-composer')).display), 'flex', 'touch: focus does not reflow the row')
  assert.equal(await touch.evaluate(() => document.getElementById('main-composer').classList.contains('armed')), false, 'touch: focus alone does not arm')
  await touch.evaluate(() => document.activeElement?.blur())
  assert.equal(await touch.evaluate(() => getComputedStyle(document.getElementById('main-composer')).display), 'flex', 'touch: blur keeps the row')
  assert.deepEqual(touchErrors, [])
  await touch.close()
  console.log('OK: composer — one row at rest/typing/clear, focus does not reflow')

  // Desktop: the same one row. Send pinned through typing/clearing; fill
  // only while armed — including a staged file with an empty caption.
  const desk = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  desk.on('pageerror', e => errors.push(e.message))
  await desk.addInitScript(() => localStorage.setItem('velta-mock', '1'))
  await desk.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await desk.locator('.chat-item', { hasText: 'Ada Byron' }).first().click({ timeout: 15000 })
  await desk.locator('#chat-view').waitFor({ state: 'visible' })
  assert.equal(await desk.evaluate(() => getComputedStyle(document.getElementById('main-composer')).display), 'flex', 'desktop: flex at rest')
  const sendRect = () => desk.evaluate(() => { const r = document.getElementById('btn-send').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)] })
  const restPos = await sendRect()
  const restFill = await desk.evaluate(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor)
  assert.equal(restFill, 'rgba(0, 0, 0, 0)', 'desktop: unarmed send has no fill')
  await desk.locator('#composer-input').fill('desktop one row')
  assert.deepEqual(await sendRect(), restPos, 'desktop: send does not move while typing')
  // The .15s background transition stalls in an occluded pane — wait it out.
  await desk.waitForFunction(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor !== 'rgba(0, 0, 0, 0)', undefined, { timeout: 2000 })
  await desk.locator('#composer-input').fill('')
  assert.deepEqual(await sendRect(), restPos, 'desktop: send does not move on clear')
  await desk.waitForFunction(v => getComputedStyle(document.getElementById('btn-send')).backgroundColor === v, restFill, { timeout: 2000 })
  // A pasted image stages the strip and arms the fill with an empty caption
  // (a staged file already sends on tap — the fill says so).
  await desk.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'notes.png', { type: 'image/png' }))
    document.getElementById('composer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await desk.locator('#media-preview').waitFor({ state: 'visible', timeout: 2000 })
  assert.equal(await desk.evaluate(() => document.getElementById('composer-input').value), '', 'staged file: caption still empty')
  await desk.waitForFunction(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor !== 'rgba(0, 0, 0, 0)', undefined, { timeout: 2000 })
  assert.notEqual(await desk.evaluate(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor), restFill, 'staged file: send armed with an empty caption')
  await desk.locator('#btn-media-close').click()
  await desk.waitForFunction(v => getComputedStyle(document.getElementById('btn-send')).backgroundColor === v, restFill, { timeout: 2000 })
  // The attach menu is the only overflow: Apps/Commands details, plus the
  // Stickers and Send later rows. The [popover] base must not win overflow
  // back — with both details open the menu scrolls inside its box.
  await desk.locator('#btn-attach').click()
  await desk.locator('.attach-pop').waitFor({ state: 'visible', timeout: 2000 })
  const menuRows = await desk.evaluate(() => [...document.querySelectorAll('.attach-pop button')].map(b => b.textContent.trim()))
  assert.ok(menuRows.some(s => s.includes('Stickers')), 'attach menu: Stickers row present')
  assert.ok(menuRows.some(s => s.includes('Send later')), 'attach menu: Send later row present')
  await desk.evaluate(() => { for (const d of document.querySelectorAll('.attach-pop details')) d.open = true })
  const over = await desk.evaluate(() => {
    const m = document.querySelector('.attach-pop')
    const r = m.getBoundingClientRect()
    return { y: getComputedStyle(m).overflowY, fits: r.top >= 0 && r.bottom <= innerHeight, scrollable: m.scrollHeight >= m.clientHeight }
  })
  assert.equal(over.y, 'auto', 'attach menu: popup overflow owned by the menu')
  assert.ok(over.fits, 'attach menu: stays inside the viewport with details open')
  await desk.close()
  console.log('OK: composer — pinned send, armed fill (text + staged file), attach menu')
} finally {
  await browser.close()
  server.close()
}
