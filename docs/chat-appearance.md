# Chat appearance (drawer → Chat appearance)

Per-device chat look: message text size, bubble corners, accent color and
hyphenation. Reference: Telegram's Chat Settings (text size slider, preview,
corner slider). Added 2026-10-18.

## Files

- `app/js/chat-appearance.js` — classic (non-module) script, loaded blocking
  in `<head>` right after `ui-scale.js` (the CSP forbids inline scripts). It
  pins `data-theme` + `meta[name=theme-color]` from `dw-theme` before first
  paint (app.js `applyTheme` repeats it later), then applies the stored
  appearance. API on `globalThis.VeltaChatAppearance` (ui.js, tests).
- `app/js/ui.js` — `chatAppearanceHtml()` / `wireChatAppearance()`: the
  native `<details class="drawer-details" data-chat-appearance>` section
  after Theme. Inputs apply live; never `rebuildDrawer()` on them.
- `app/js/text-lang.js` — `detectTextLang(text, fallback)` (Cyrillic vs
  Latin letter count over the first 400 characters, links/addresses/domains
  stripped first) and `uiLang()`. chat-view sets `lang` on every `.msg-text`.
- `app/css/main.css` — the tokens below; the section's `.ca-*` rules.
- Tests: `tests/chat-appearance.test.mjs`, `tests/hyphenation.test.mjs`;
  `scripts/e2e-narrow-overflow.mjs` re-runs the chats and the drawer section
  at 10 px and 22 px text with 0 px corners (320 and 360 px wide).

## Storage (localStorage, absent = default)

| Key | Values | Default |
|---|---|---|
| `velta-msg-font-size` | 10–22, 0.5 steps | 15.5 (the stock `.msg-text` size) |
| `velta-bubble-radius` | 0–14 | unset = the theme's `--radius-bubble` (14, brutal 6) |
| `velta-accent` | `#rrggbb` | unset = the theme's own accent (#5aa2e6 dark, #3390ec light) |
| `velta-hyphens` | `"0"` = off | on |

The text-size slider uses `step="0.5"` because the stock size is 15.5 px; a
whole-pixel step would snap the default to 16.

## CSS wiring

Inline on `<html>`: `--msg-font-size` (sender, quote and forward labels
scale by their stock ratio: `calc(var(--msg-font-size) * .871)` etc.;
reaction chips under bubbles use `* 16 / 15.5` with em spacing and wrap),
`--radius-bubble`, `--radius-tail` = min(6, r), `--radius-quote` = min(6, r),
`--radius-media` = max(0, r − 4) (photos, videos, link cards, invite cards).

A custom accent writes one `<style id="velta-chat-accent">` with a block per
theme (`:root:not([data-theme=light]):not([data-theme=brutal])` and
`:root[data-theme=light]`; brutal is untouched): `--accent`,
`--accent-hover`, `--accent-active`, `--on-accent`, `--on-accent-chip`,
`--accent-tint` (translucent fills via `color-mix`), `--bg-bubble-out`,
`--bg-active`, `--text-meta-out`, `--out-link`, `--ticks-read`,
`--accent-text-in`, `--quote-name`. Each has a stylesheet default equal to
the old hard-coded color, so the stock look is unchanged.

`deriveAccent(base, theme)` keeps, for any input color: accent ≥ 4.5 : 1 on
the incoming bubble and the chat surface; body text ≥ 7 : 1 on the own
bubble (dark) and ≥ 4.5 everywhere; meta, links ≥ 4.5 : 1 on the own bubble;
ink on accent fills picked by contrast (`#f4f4f4` or `#10131a`). Lightness
searches stay in the soft range (no pure black or white, AGENTS.md 6.4). The
meta theme-color stays the background color; the accent is not used there.

## Hyphenation

`.msg-text { hyphens: auto }` (+ `-webkit-`); `html.no-hyphens` (drawer
switch) sets `manual`. Links, `code`/`pre`/`kbd`/`samp`, hashtags, bot
commands and bare e-mail addresses (markdown.js wraps them in
`span.msg-nohyph`) are `hyphens: manual`. `overflow-wrap: anywhere` on
`.bubble` still breaks unknown long strings.

Platform support (Russian needs a `ru` dictionary):

- Android WebView / Chrome Android: yes (Android's system hyphenation
  data, which includes `ru` and `en`).
- Windows WebView2: Chromium's Minikin hyphenator with dictionaries
  delivered by the component updater after startup — expected to work on a
  current runtime, not verified on a device here; the first launch after an
  install may show no hyphens until the dictionaries arrive.
- macOS WKWebView: yes, CoreFoundation dictionaries include `ru` and `en`.
- Linux desktop (WebKitGTK): depends on the distro's hyphen dictionaries
  (`hyphen-ru`, `hyphen-en-us`); may not hyphenate.
- PWA in Chromium: yes; verified in headless Chromium 156 (Linux) for both
  `en` and `ru` (bubble heights drop with `hyphens: auto`).
Where a dictionary is missing the text simply wraps as before.
