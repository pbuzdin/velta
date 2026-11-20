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

  // Expanding composer: typing expands the field to a full-width column with
  // the buttons on a row below, hides the sticker trigger (a sticker send is
  // a message of its own), caps the field at three lines; clearing collapses.
  const bar = page.locator('#main-composer')
  const state = () => bar.evaluate(el => ({
    display: getComputedStyle(el).display,
    expanded: el.classList.contains('expanded'),
    hasText: el.classList.contains('has-text'),
  }))
  assert.equal((await state()).display, 'flex', 'rest: single-row flex composer')
  await page.waitForFunction(() => document.getElementById('btn-sticker').offsetWidth > 0, undefined, { timeout: 2000 })
    .catch(() => { throw new Error('rest: sticker did not return after send') })
  const restGut = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect()
    const a = r('#btn-attach'); const w = r('.composer-input-wrap'); const d = r('#btn-send')
    return [Math.round(w.left - a.right), Math.round(d.left - w.right)]
  })
  assert.deepEqual(restGut, [8, 8], 'rest: equal gutters around the field')
  await page.locator('#composer-input').fill('M '.repeat(80))
  assert.deepEqual(await state(), { display: 'grid', expanded: true, hasText: true }, 'typing: expanded grid')
  await page.waitForFunction(() => document.getElementById('btn-sticker').offsetWidth === 0, { timeout: 2000 })
  // Wait out the 180ms composer-drop animation before measuring geometry.
  const below = await page.waitForFunction(() => {
    const r = s => document.querySelector(s).getBoundingClientRect()
    const a = r('#btn-attach'); const w = r('.composer-input-wrap'); const d = r('#btn-send')
    const v = [a.top - w.bottom, a.left - w.left, w.right - d.right].map(Math.round)
    return v[0] === 8 && v[1] === 0 && v[2] === 0 ? v : null
  }, undefined, { timeout: 2000 }).then(h => h.jsonValue())
  assert.deepEqual(below, [8, 0, 0], 'expanded: buttons row below, flush with the field edges')
  const h = await page.locator('#composer-input').evaluate(el => el.clientHeight)
  assert.ok(h > 55 && h <= 95, `field capped at three lines, clientHeight ${h}`)
  await page.locator('#composer-input').fill('')
  assert.deepEqual(await state(), { display: 'flex', expanded: false, hasText: false }, 'clear: collapsed again')
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('btn-apps')).display), 'none', 'phone: quick tools stay in the attach menu')
  await page.waitForFunction(() => document.getElementById('btn-sticker').offsetWidth > 0, { timeout: 2000 })

  // Touch: focus alone expands, blur collapses (no text needed either way).
  const touch = await browser.newPage({ viewport: { width: 390, height: 800 } })
  const touchErrors = []
  touch.on('pageerror', e => touchErrors.push(e.message))
  await touch.addInitScript(() => {
    localStorage.setItem('velta-mock', '1')
    const real = window.matchMedia.bind(window)
    window.matchMedia = q => q.includes('pointer: coarse')
      ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }
      : real(q)
  })
  await touch.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await touch.locator('.chat-item', { hasText: 'Ada Byron' }).first().click({ timeout: 15000 })
  await touch.locator('#chat-view').waitFor({ state: 'visible' })
  await touch.locator('#composer-input').focus()
  assert.equal(await touch.evaluate(() => getComputedStyle(document.getElementById('main-composer')).display), 'grid', 'touch: focus alone expands')
  await touch.evaluate(() => document.activeElement?.blur())
  assert.equal(await touch.evaluate(() => getComputedStyle(document.getElementById('main-composer')).display), 'flex', 'touch: blur collapses')
  assert.deepEqual(touchErrors, [])
  await touch.close()
  console.log('OK: expanding composer — rest/typing/clear + touch focus/blur')

  // Desktop (≥600px): always expanded — grid at rest, send pinned to one
  // spot through typing/clearing; send fills accent only while armed.
  const desk = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  desk.on('pageerror', e => errors.push(e.message))
  await desk.addInitScript(() => localStorage.setItem('velta-mock', '1'))
  await desk.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  await desk.locator('.chat-item', { hasText: 'Ada Byron' }).first().click({ timeout: 15000 })
  await desk.locator('#chat-view').waitFor({ state: 'visible' })
  assert.equal(await desk.evaluate(() => getComputedStyle(document.getElementById('main-composer')).display), 'grid', 'desktop: expanded at rest')
  const sendRect = () => desk.evaluate(() => { const r = document.getElementById('btn-send').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)] })
  const restPos = await sendRect()
  const restFill = await desk.evaluate(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor)
  await desk.locator('#composer-input').fill('desktop always expanded')
  assert.deepEqual(await sendRect(), restPos, 'desktop: send does not move while typing')
  // The .15s background transition stalls in an occluded pane — wait it out.
  await desk.waitForFunction(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor !== 'rgba(0, 0, 0, 0)', undefined, { timeout: 2000 })
  const armedFill = await desk.evaluate(() => getComputedStyle(document.getElementById('btn-send')).backgroundColor)
  assert.notEqual(armedFill, restFill, 'desktop: send fills accent while there is text')
  await desk.locator('#composer-input').fill('')
  assert.deepEqual(await sendRect(), restPos, 'desktop: send does not move on clear')
  await desk.waitForFunction(v => getComputedStyle(document.getElementById('btn-send')).backgroundColor === v, restFill, { timeout: 2000 })
  // Quick tools: Apps/Commands beside Attach, Send later beside Send.
  assert.equal(await desk.evaluate(() => getComputedStyle(document.getElementById('btn-apps')).display), 'grid', 'desktop: quick tools visible')
  assert.equal(await desk.evaluate(() => document.getElementById('btn-send-later').hidden), false, 'desktop: Send later shown in a normal chat')
  await desk.locator('#btn-apps').click()
  await desk.locator('.ctx-menu').waitFor({ state: 'visible', timeout: 2000 })
  await desk.close()
  console.log('OK: desktop composer — always expanded, pinned send, armed fill, quick tools')
  await desk.close()
  console.log('OK: desktop composer — always expanded, pinned send, armed fill')
} finally {
  await browser.close()
  server.close()
}
