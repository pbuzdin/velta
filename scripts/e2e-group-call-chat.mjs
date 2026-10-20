#!/usr/bin/env node
// E2E for the group call card + in-call bar in the real Velta UI (mock core,
// 360x740 phone). docs/agents/group-calls.md. The demo "Weekend Crew" chat
// carries the trusted built-in group-call app (real bytes -> hash check):
//   - card: creator avatar, name "Saturday hike plan", "Started by Mara Voss",
//     2 in call + mini avatars, Join;
//   - Join -> consent modal -> joined: "You're in" + Leave, 3 in call;
//   - the in-call bar shows (the call screen is not open) as a strip that
//     does not overlap the chat header; in another chat and the chat list too;
//   - setCallScreen(msgId) (what webxdc-manager does when the call app opens)
//     hides the bar; closing shows it again;
//   - Leave from the bar; everyone gone -> the card shows "Call ended".
// Usage: node scripts/e2e-group-call-chat.mjs [--shots DIR]
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const args = process.argv.slice(2)
const shots = (() => { const i = args.indexOf('--shots'); return i >= 0 ? args[i + 1] : null })()
if (shots) mkdirSync(shots, { recursive: true })
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.xdc': 'application/zip', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const f = join(appRoot, p || 'index.html')
  if (!f.startsWith(appRoot) || !existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/index.html`

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const toBottom = async (page) => { for (let i = 0; i < 6; i++) { await page.evaluate(() => { for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight }); await page.waitForTimeout(300) } }
const shot = async (page, name) => { await page.evaluate(() => document.querySelectorAll('.toasts > *, .toast').forEach((t) => t.remove())).catch(() => {}); await page.locator('.msg-groupcall').first().evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {}); await page.waitForTimeout(200); if (shots) { await page.screenshot({ path: `${shots}/${name}.png` }); console.log(`  shot ${shots}/${name}.png`) } }
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] })
  await ctx.addInitScript(() => localStorage.setItem('velta-mock', '1'))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(base); await page.waitForSelector('.chat-item', { timeout: 15000 }); await page.waitForTimeout(500)
  await page.locator('.chat-item', { hasText: 'Weekend Crew' }).first().click()
  await page.waitForTimeout(800); await toBottom(page)
  const card = page.locator('.msg-groupcall').first()
  await card.waitFor({ timeout: 10000 })
  await page.waitForFunction(() => /in call/.test(document.querySelector('.msg-groupcall .gc-sub')?.textContent || ''), null, { timeout: 8000 })
  await card.scrollIntoViewIfNeeded()
  const txt = await card.innerText()
  check(/Saturday hike plan/.test(txt), 'card: call name from the starter\'s meta update')
  check(/2 in call/.test(txt) && /Started by/.test(txt), `card: creator + live count (${txt.replace(/\s+/g, ' ').slice(0, 90)})`)
  check(await card.locator('.gc-head velta-avatar').count() === 1, 'card: creator avatar (velta-avatar, photo or initial on profile color)')
  check(await card.locator('.gc-people velta-avatar').count() === 2, 'card: participant mini avatars')
  check(await card.locator('.gc-join').isVisible() && !(await card.locator('.gc-leave').isVisible()), 'card: Join shown, Leave hidden (not joined)')
  check(!(await page.locator('#group-call-bar').count()), 'no in-call bar before joining')
  await shot(page, 'card-360-not-joined')
  await card.locator('.gc-join').click()
  await page.locator('.modal .btn-text', { hasText: 'Join' }).click({ timeout: 5000 })
  await page.waitForFunction(() => document.querySelector('.msg-groupcall')?.classList.contains('gc-joined'), null, { timeout: 10000 })
  await page.waitForTimeout(800)
  const joined = await card.innerText()
  check(/You're in/.test(joined) && await card.locator('.gc-leave').isVisible() && !(await card.locator('.gc-join').isVisible()), 'card joined: "You\'re in" + Leave, no Join')
  check(/3 in call/.test(joined), `card joined: 3 in call (${joined.replace(/\s+/g, ' ').slice(0, 80)})`)
  // the call screen is not open (a plain browser cannot host webxdc) -> bar shows
  const geo = async () => page.evaluate(() => {
    const b = document.getElementById('group-call-bar')?.getBoundingClientRect()
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && r.right > 0 && r.left < innerWidth && getComputedStyle(e).visibility !== 'hidden' }
    const head = [...document.querySelectorAll('#chat-view > .chat-head')].find(vis) || [...document.querySelectorAll('.sidebar-head')].find(vis)
    const h = head?.getBoundingClientRect()
    return b && h ? { barBottom: b.bottom, headTop: h.top, headCls: head.className } : { b: !!b, h: !!h }
  })
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(300)
  let g = await geo()
  check(g.barBottom != null && g.barBottom <= g.headTop + 0.5, `bar does not cover the chat header (${JSON.stringify(g)})`)
  await shot(page, 'card-360-joined')
  // call screen visible -> no bar
  await page.evaluate(async () => (await import('./js/group-call-ui.js')).setCallScreen((await import('./js/group-call-host.js')).currentGroupCall().msgId))
  check(!(await page.locator('#group-call-bar').count()), 'call screen visible -> no duplicate bar')
  await page.evaluate(async () => (await import('./js/group-call-ui.js')).setCallScreen(null))
  check(await page.locator('#group-call-bar').count() === 1, 'call screen closed -> bar back')
  // another chat
  await page.goBack().catch(() => {}); await page.waitForTimeout(600)
  await page.locator('.chat-item', { hasText: 'Ada Byron' }).first().click(); await page.waitForTimeout(800)
  g = await geo()
  check(await page.locator('#group-call-bar').isVisible() && g.barBottom <= g.headTop + 0.5, `bar in another chat, header not covered (${JSON.stringify(g)})`)
  check(/Saturday hike plan · 3 in call/.test(await page.locator('#group-call-bar').innerText()), 'bar: call name + count')
  await shot(page, 'bar-in-another-chat-360')
  await page.goBack().catch(() => {}); await page.waitForTimeout(600)
  await shot(page, 'bar-on-chat-list-360')
  // leave from the bar, then everyone else leaves -> ended
  await page.locator('#group-call-bar .gcb-leave').click(); await page.waitForTimeout(500)
  check(!(await page.locator('#group-call-bar').count()), 'leave from the bar removes it')
  check(await page.evaluate(async () => (await import('./js/group-call-host.js')).currentGroupCall() === null), 'left: no current call')
  await page.locator('.chat-item', { hasText: 'Weekend Crew' }).first().click(); await page.waitForTimeout(800); await toBottom(page)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('velta-demo-end-call')))
  await page.waitForFunction(() => /Call ended/.test(document.querySelector('.msg-groupcall .gc-sub')?.textContent || ''), null, { timeout: 8000 }).catch(() => {})
  const ended = await page.locator('.msg-groupcall').first().innerText().catch(() => '')
  check(/Call ended/.test(ended) && /Start again/.test(ended), `card: ended state (${ended.replace(/\s+/g, ' ').slice(0, 80)})`)
  await page.locator('.msg-groupcall').first().scrollIntoViewIfNeeded().catch(() => {})
  await shot(page, 'card-360-ended')
} finally { await browser.close(); server.close() }
if (failed) { console.log(`group call chat e2e: ${failed} FAILED`); process.exit(1) }
console.log('group call chat e2e: all checks passed')
