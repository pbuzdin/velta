# Web components plan: accessibility, progressive shell, state-in-attributes

Companion to [`web-components-audit.md`](web-components-audit.md). Finding IDs
(A1…D4) refer to that report. Baseline is `master` @ `02d5e78` (2026-10-06).
Estimates are engineer-days for someone who knows the codebase, and they include
the manual demo-mode check (`AGENTS.md` §4.2/§7.2).

**Total: about 16.5 days** across 5 phases. Phases 0, 2 and 3 help every shell
(Tauri desktop, Android, PWA). Phase 1 pays off mainly on the **PWA**
(Architecture C, wasm core ~4.4 MiB brotli, slow startup). Tauri and Android load
`app/` from local disk, where the measured first-row time is about 0.3 s, so phase 1
is low-value there, though harmless.

> **Update (2026-10-06):** modals, overlays and popups now have their own audit
> and conversion plan in [`modals-audit-and-plan.md`](modals-audit-and-plan.md)
> (7 phases, 11.5 days). It **supersedes items 0.4 and 2.4** below, and folds
> in 0.1. Native-element replacements (popover, forms, `<progress>`, `<time>`,
> composer hints, …) are surveyed in [`native-elements.md`](native-elements.md).
>
> **Update (2026-10-06, keyboard/a11y):** keyboard shortcuts (with a Delta Chat
> Desktop reference), the Esc chain, roving tabindex, reduced motion, forced
> colors, Android text scaling and touch targets are planned in
> [`accessibility-and-keybindings.md`](accessibility-and-keybindings.md)
> (phases P0–P5, 21 days). Its P2.1 roving engine covers the focus parts of
> items **2.1/2.2/2.6** below, and its announcer (P2.5) should be the same
> module as the 2.6 announcer. **Key conflict:** 2.6's "Alt+Up from the
> composer" clashes with Alt+↑/↓ chat switching (Delta Chat parity). Use
> Shift+Tab or F6 instead. Contrast item **3.4** is shared with its P3.3, and
> the phase 4 test harness with its P5.

Ground rules for every phase:
- No bundler, no npm runtime deps in `app/` (`AGENTS.md` §6.2). Test-only deps
  stay outside `app/`, for example in `scripts/package.json` or a new
  `tests/a11y/package.json`.
- Keep Elena for leaf components only (VENDOR-REVIEW §1). Message rows stay
  hand-rendered.
- Keep the Android BACK/history contract of modals, the drawer and lightboxes
  (`ui.js:99-152`, `1033-1045`), and "settle BEFORE close" (`AGENTS.md` §6.2).
- Run `node --test tests/*.test.mjs` after every phase. Today: 357/357 green.
  `tests/app-source-integrity.test.mjs` may pin source strings, so update pins
  in the same commit.

---

## Phase 0: Quick wins (2 days)

Small, local edits with no architecture change. Each one can ship on its own.

| # | Task | Files | Fixes |
|---|---|---|---|
| 0.1 | Add `aria-label="Close"` + `title` to the modal close button | `app/js/ui.js:116-118` | A11 |
| 0.2 | `#toasts` → `role="status" aria-live="polite" aria-atomic="false"`; danger toasts go into a second `role="alert"` container (or set `role="alert"` on the toast element); `#boot-error` → `role="alert"` | `app/index.html:27,182`, `app/js/ui.js:166-248` | A14 |
| 0.3 | Drawer: set `inert` while closed and remove it on open; give `#bar-menu` `aria-expanded` + `aria-controls="drawer"`; on open, focus the first drawer control; on close, return focus to `#bar-menu` | `app/js/ui.js:524-528,788-802`, `app/index.html:71` | A12 |
| 0.4 | Interim modal semantics: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` → `.modal-title` id; on open, focus the first focusable element (callers that already focus an input keep winning); on close, restore focus to the previously focused element | `app/js/ui.js:99-152` | A10 (part). **Superseded** by [`modals-audit-and-plan.md`](modals-audit-and-plan.md) M1; ship only as a stopgap if M1 slips |
| 0.5 | `div role="button"` attachment cards → `<button type="button">` (keep classes); webxdc card: outer div loses `role`, the app name becomes the open button next to Start | `app/js/chat-view.js:1435,1456,1466,1475-1479,1482` + CSS reset for `button.msg-file` in `app/css/main.css` | A5 |
| 0.6 | `<velta-video>`: render the play overlay as `<button type="button" class="velta-video-play" aria-label="${this.ariaLabel()}">` and move the click handler onto it | `app/js/components.js:163-179,239-260` | A4 |
| 0.7 | Message image: wrap `img` in `<button type="button" class="img-open" aria-label="Open photo">`; set `alt` from the caption or "Photo from <sender>"; lightbox `alt` = caption | `app/js/chat-view.js:1432,1715`, `app/js/ui.js:1053-1057` | A6, A20 (part) |
| 0.8 | `title` on iframes (webxdc app name, "HTML message", page domain) | `app/js/webxdc-manager.js:219`, `app/js/chat-view.js:2970`, `app/js/inapp-browser.js:89` | A18 |
| 0.9 | Labels: splash relay input, sticker tiles, `#btn-search` `aria-label` kept in sync, selection-bar `aria-label`s, `aria-label` on the identity-tile SVG | `app/js/app.js:3863,1281-1289,2612`, `app/js/ui.js:80-86`, `app/index.html:108-113`, `app/js/avatar.js:202` | A19, A25, A26, A27, A30 |
| 0.10 | `aria-hidden="true"` on decorative inline SVGs inside labelled buttons (bulk edit of `index.html` + icon constants) | `app/index.html`, `app/js/components.js`, `app/js/chat-view.js` ICO | hygiene |

**Risks.**
- 0.5 and 0.7 change the element type, so author CSS on `div.msg-file`, the
  touch/long-press handlers and the selection-mode tap routing
  (`chat-view.js:1863`) need checking. `<button>` swallows text selection, but
  bubbles already use `user-select:none` on touch.
- 0.3: `inert` is supported on Android WebView/WebView2 (Chromium 102+) and
  Safari 15.5+.
- 0.4: initial focus can raise the Android soft keyboard. Never auto-focus a text
  input on touch except where callers already do (`AGENTS.md` §6.2, camera rule).

**Acceptance.**
- axe on list, chat, drawer and modal shows no `button-name`,
  `nested-interactive` or `frame-title` violations.
- A Tab walk from `#btn-search` never enters the closed drawer.
- Opening a modal focuses inside it, and Esc/close returns focus to the opener.
- VoiceOver/TalkBack (or the Chromium a11y tree) reads toasts and errors.
- 357/357 node tests green, and demo-mode manual smoke done.

---

## Phase 1: Progressive app shell (3 days)

Goal: the static HTML+CSS shows a meaningful, correctly themed shell (a list
skeleton and a boot status) before any module runs, and nothing shifts when JS
replaces it. This is mainly a **PWA** win; on Tauri and Android it is cosmetic.

| # | Task | Files | Est. |
|---|---|---|---|
| 1.1 | **Pre-paint theme.** Move `dw-theme` → `data-theme` and the `theme-color` resolution into a parser-blocking classic script (extend `ui-scale.js` or add `boot-theme.js`; CSP needs an external script, no inline). Keep `applyTheme()` in `app.js` for live changes. | `app/js/ui-scale.js` (or new), `app/index.html:19`, `app/js/app.js:866-876` | 0.5 |
| 1.2 | **Chat-list skeleton.** Static `<li class="chat-skel" aria-hidden="true">` ×8 inside `#chat-list`, plus `aria-busy="true"` on the list, using CSS-only rows (avatar circle + two bars, `prefers-reduced-motion` aware) at the same height as a real row (fix the 66/68 px drift in `AGENTS.md` §7.2). `renderChatList()` already removes non-row children (`app.js:1580`); it should also clear `aria-busy`. | `app/index.html:54`, `app/css/main.css` (~1184-1202), `app/js/app.js:1553-1625` | 1 |
| 1.3 | **Boot status line.** A static visually-hidden `role="status"` boot message ("Starting Velta…") plus a visible one-line hint under the skeleton. `app.js` updates it on each boot stage it already logs (`appLog("boot: …")`): for the PWA, "Loading secure core…", then "Opening profile…". It is removed at `boot: done`. On first run, the splash replaces it. | `app/index.html`, `app/js/app.js:4466-4766` | 0.5 |
| 1.4 | **Pre-hydration CSS for the Elena elements.** `velta-chat-item:not([hydrated])` gets min-height = row height. `velta-avatar:not([hydrated])` gets the size from a `--size` custom property (set as an attribute-driven inline var, or default 46 px) and a neutral tile background. `velta-chat-head:not([hydrated])` gets min-height 42 px. Add the Elena-recommended `:not(:defined)` self-destructing hide (2 s animation) only if any element ever lands in static HTML. | `app/css/main.css:1137-1233` | 0.5 |
| 1.5 | **Static empty and splash templates.** Move the chat-list empty-state copy and the splash skeleton (logo, `<h1>`, tagline) into `<template>`s in `index.html`, so the JS clones markup instead of building strings with inline styles. The splash can then be shown immediately on PWA first run, before the wasm core answers `getAccount`, with buttons disabled (`aria-disabled`) until the core is live. | `app/index.html`, `app/js/app.js:1612-1621,3843-3880` | 0.5 |

**Risks.**
- 1.1: a wrong theme pre-paint is worse than a late one. Keep exactly the same
  resolution logic (auto → `prefers-color-scheme`) and add a unit test that pins
  the two code paths to the same output.
- 1.2: the headless test harness (no IntersectionObserver) and
  `tests/chatlist-incremental.test.mjs` count list children, so skeleton rows
  must not be counted as rows (class-gated, `aria-hidden`).
- 1.5: on Tauri the splash must not flash for returning users. Gate the
  pre-core splash on "no configured account known", using a localStorage hint
  written after the first successful configure.

**Acceptance.**
- No-JS screenshots (desktop + 412 px) show the skeleton list, the boot status
  text and the correct theme for `dw-theme=light`.
- Slow-4G run: the skeleton is visible at FCP (~1.0 s today), and CLS from
  skeleton → real rows is under 0.05 (today 0.028).
- Light-theme users see no dark → light flash. Check with a
  `prefers-color-scheme: light` emulated screenshot at FCP.
- With the wasm transport (`worker-wasm`, Architecture C) the list area is never
  blank between FCP and the first row.

---

## Phase 2: Semantics and ARIA for lists, dialogs and live regions (6 days)

The structural accessibility work: the core chat loop becomes keyboard- and
screen-reader-operable.

| # | Task | Files | Est. |
|---|---|---|---|
| 2.1 | **Chat list as a list of buttons/links.** `#chat-list` → `<nav aria-label="Chats"><ul role="list">` with an `<li>` per row. `<velta-chat-item>` renders a `<button type="button" class="chat-item">` (or `<a href="#chat/ID">`) as its `element` with `aria-current="true"` when open. Drop `role="listbox"`/`"option"`. Context menu via the `contextmenu` event on the focused button (Shift+F10 / Menu key) plus a visible "More" affordance on focus. This aligns with the existing contact and call rows (`app.js:1316,1353,1376`). | `app/index.html:54`, `app/js/components.js:301-362`, `app/js/app.js:1553-1672`, `app/css/main.css:1184-1233` | 1.5 |
| 2.2 | **Focus survives row recreation (D3).** Rows are recreated on data change (VENDORISSUES #8). Before `replaceWith`, remember whether the row (or a descendant) had focus, and re-focus the new row's button after. The same goes for the chat head. Optional upstream fix of E2 removes the need. | `app/js/app.js:1557-1600,1904-1929,2001,2070,2089,2499` | 0.5 |
| 2.3 | **Chat header and avatars as controls.** `<velta-chat-head>` renders the name/status block inside a `<button type="button" class="chat-head-btn" aria-haspopup="dialog">`; the name becomes `<h2>`. Clickable avatars (drawer head, group sender) get wrapped in a `<button aria-label="Profile of …">`, while the decorative tile stays `aria-hidden`. | `app/js/components.js:365-412`, `app/js/ui.js:531`, `app/js/chat-view.js:1379-1381,1558-1565` | 0.5 |
| 2.4 | **Dialogs on native `<dialog>`.** `showModal()` builds `<dialog class="modal" aria-labelledby>`, opened with `dialog.showModal()` (top layer, inert background, Esc → `cancel`) and closed via `close()`. Map `cancel` → `doClose` so the history contract and "settle before close" keep working. Apply the same pattern to the lightboxes (A20), the webxdc, HTML-viewer and in-app-browser overlays, and the call overlay (as `role="alertdialog"` with focus on Accept, A15). Toasts must keep rendering *above* modals, so move `#toasts` to `popover="manual"` (top layer, shown after dialogs) or render toasts into the open dialog. | `app/js/ui.js:99-152,1033-1174`, `app/js/calls.js:280-310`, `app/js/webxdc-manager.js:215-250`, `app/js/inapp-browser.js:70-95`, `app/js/chat-view.js:2954-2990`, `app/css/main.css` (`.pop-overlay`, `.modal`, `.lightbox`, `#call-overlay`) | 1.5 → see note |
| 2.5 | **Menus.** `showContextMenu()` → `role="menu"` with `role="menuitem"` buttons, separators as `role="separator"`, focus on the first item, Arrow/Home/End/Esc, focus returned to the invoking element. The account switcher popover in the drawer gets the same treatment. | `app/js/ui.js:28-55,536-539,860-875` | 0.5 |
| 2.6 | **Message history semantics + live announcer.** `#history` → `role="list"` (or `feed`) with rows as `role="listitem"`/`<article aria-labelledby>`, each carrying a hidden "sender, time" prefix. Day chips become `<h3>`/`role="separator"`, and times become `<time datetime>`. Rows are focusable (`tabindex="-1"` + roving, with ArrowUp/Down from the composer via Alt+Up) so the context menu and Shift+F10 work. Add **one** visually-hidden `aria-live="polite"` announcer, fed from the incoming-message path (where `notifyIncoming` already decides "new message in the open chat"), rate-limited (coalesce bursts: "3 new messages from Ada"). Typing and failed sends go through the same announcer. The virtual scroller's row churn stays out of it. | `app/js/chat-view.js:1334-1900` (row build), `1374`, `1549`, `app/index.html:118-119`, `app/js/ui.js:1176-1246` (notify path) | 1.5 |
| 2.7 | **Tabs, toggles and status icons.** Proper `tablist`/`tab`/`tabpanel` with `aria-selected` for the QR and search tabs and the profile-management tabs. `aria-pressed` on category chips. `aria-current="page"` on the active bottom-bar view. Ticks, pin, mute and lock get `<title>`/`aria-label` text ("Read", "Delivered", "Sending", "Failed", "Pinned", "Muted", "Unencrypted"). Unread badge: "14 unread". Relay line: real text in a visually-hidden span instead of `aria-label` only. | `app/js/app.js:1268,1407-1409,1550,2948-2955,3103,680-752`, `app/js/components.js:268-298,334`, `app/index.html:43-53` | 0.5 |

**Risks.**
- 2.1/2.6 touch the hottest render paths. Re-run `chatlist-incremental`,
  `scroll-restore`, `chat-msg-update-hardening` and `read-tracking`. Row
  signatures (`_rowSigCache`) must include any new attributes, or event storms
  come back (`AGENTS.md` §11, "Event-storm hardening").
- 2.4 is **superseded** by [`modals-audit-and-plan.md`](modals-audit-and-plan.md)
  (phases M0–M6, 11.5 days, including the history stack, forms, popover
  fallbacks and device QA that the 1.5-day estimate left out). The notes
  below are kept for context.
- 2.4: the `<dialog>` top layer changes stacking. Stickers, toasts, lightbox
  over modal, and "confirm before lightbox" (`chat-view.js:1718-1735`) all
  depend on the current z-order. WebView2 and Android WebView support
  `<dialog>` and `popover`. WKWebView needs Safari 15.4 for `<dialog>` and 17 for
  `popover`, so keep the z-index fallback for older macOS.
- 2.6: over-announcing is worse than silence. Coalesce, skip own messages, and
  respect the notification mute settings.
- Long-press/touch behaviour (`chat-view.js:1786-1880`) must not change for
  touch users. Keyboard paths are additive.

**Acceptance.**
- Keyboard only (no pointer), a user can: open any chat from the list, read
  messages, open the chat-info sheet, reply/copy/forward/delete a message via
  the context menu, open a photo and close it, open the drawer, change a
  setting and close it, accept or decline an incoming call.
- With a screen reader (NVDA or VoiceOver against `python tools/serve-dev.py`
  demo mode, or TalkBack on the APK): a new incoming message in the open chat
  is announced once, and a toast is announced.
- axe: no `aria-allowed-role`, `scrollable-region-focusable`,
  `page-has-heading-one` or `region` violations for the dialogs (dialogs are
  exempt once they're `<dialog>`).
- No regression in the node suites, and no new virtual-scroller "height
  changed unexpectedly" warnings in a 2400-message demo chat scroll.

---

## Phase 3: State-in-attributes CSS cleanup (3 days)

Make state machine-readable: ARIA where it carries meaning, `data-*` or host
attributes for visual-only state, custom properties for geometry. This also
removes most JS inline styles.

| # | Task | Files | Est. |
|---|---|---|---|
| 3.1 | Replace state classes with the attributes from audit table C1: `.active` → `aria-current`/`aria-pressed`/`aria-selected` (these already exist after phase 2, so CSS just switches selectors); `.open` → drawer `[data-open]` + trigger `aria-expanded`; `.selectable`/`.selected` → `#history[data-selecting]` + row `aria-selected`; `.playing` → host `[playing]`; `.loaded`/`.ready` → `[data-loaded]`/`[data-ready]`; `.online` → `[data-presence]`; `.update` → `[data-update]` | `app/js/components.js`, `app/js/app.js`, `app/js/ui.js`, `app/js/chat-view.js`, `app/css/main.css` (selectors incl. the brutal-theme block `2158-2300`) | 1.5 |
| 3.2 | Inline styles → classes/custom properties: avatar `--size`/`--avatar-color` (`components.js:92-93`), SVG size constants → CSS, `.btn-danger` for confirm buttons (`ui.js:257,280`), "Show Full Message" button class (`chat-view.js:1517`), P2P/invite/qr-scan layout styles; geometry → `--w`/`--ar` custom properties (`chat-view.js:1429,1452,1681-1689`, `components.js:229-232`) | same files + `app/js/p2p.js`, `app/js/invites.js`, `app/js/qr-scan.js` | 1 |
| 3.3 | `hidden` everywhere instead of `style.display` toggles (`ui.js:649,790,799,899,914`, `chat-view.js:1633`), plus a `[hidden]{display:none}` audit of every styled container (`AGENTS.md` §6.2 rule) | `app/js/ui.js`, `app/js/chat-view.js`, `app/css/main.css` | 0.25 |
| 3.4 | Focus styles: one `:focus-visible` ring token per theme (dark, light, brutal), replacing `outline: 0` on the composer and text fields with a visible focus treatment (`main.css:1087,1446-1449`); fix the axe `color-contrast` nodes (category chips, meta text) in all three themes | `app/css/main.css` | 0.25 |

Optional, not estimated: once host attributes carry state, drop `D4` (the `.active`
class computed in `render()`), and consider `:state()` through ElementInternals for
`<velta-video>` failed/playing if macOS WKWebView ≥ 17.4 becomes the floor.

**Risks.** Purely visual regressions, especially in the brutal theme's many
`.active` overrides. Take before/after screenshots per theme (phase 4 automates
this). Inline-style removal on media boxes must keep the Safari px-only width
rule (#27 comments in `chat-view.js:1421-1427`).

**Acceptance.**
- `rg "classList\.(add|remove|toggle)\(\"(active|open|selected|selectable|playing|loaded|ready|online|update)\""`
  over `app/js` returns 0 hits.
- The inline-style count (audit C2, ~177) drops by ≥ 60 %, and what's left is
  only dynamic custom-property assignments.
- axe `color-contrast` is clean in the dark, light and brutal themes.
- Visible focus ring on every interactive element in every theme.

---

## Phase 4: Tests and guardrails (2.5 days)

Lock the gains in so regressions fail CI instead of reaching users.

| # | Task | Files | Est. |
|---|---|---|---|
| 4.1 | **axe-core + Playwright a11y suite.** `tests/a11y/` with its own `package.json` (`@playwright/test`, `axe-core`), using the same approach as this audit: serve `app/` statically, demo mode, then run axe on list, open chat (text + image + webxdc + file rows), drawer, modal, context menu, lightbox, splash (`velta-mock-fresh`), each in the dark and light themes. Fail on critical/serious; snapshot moderate counts. CSP: inject axe via `bypassCSP` in the test context only. | new `tests/a11y/*`, `.github/workflows/` (new or existing frontend job) | 1 |
| 4.2 | **Keyboard journey tests.** Playwright, keyboard only: Tab to the first chat → Enter opens it; Shift+F10 on a message opens the menu → ArrowDown → Enter "Reply" focuses the composer; Esc closes dialogs and restores focus; the closed drawer has 0 tabbable descendants. | `tests/a11y/keyboard.spec.mjs` | 0.5 |
| 4.3 | **No-JS render snapshot.** Load `index.html` with `javaScriptEnabled:false` at 1280×800 and 412×860. Assert skeleton rows, the boot status text and the header/bar buttons are present and the theme matches `dw-theme`; keep a screenshot baseline with a tolerance. | `tests/a11y/nojs.spec.mjs` | 0.5 |
| 4.4 | **Startup budget check (PWA).** Slow-4G emulation (150 ms RTT, 1.6 Mbps): assert the skeleton is visible at FCP and CLS < 0.05; record FCP and time-to-first-row as an informational CI metric. Once the wasm transport is on in the PWA dist, run the same check against `worker-wasm` (alongside the existing `scripts/smoke-deltachat-wasm.mjs`). | `tests/a11y/startup.spec.mjs` | 0.25 |
| 4.5 | **Source guards in the node suite.** Extend `tests/app-source-integrity.test.mjs` (or add `tests/semantics-guard.test.mjs`): no `role="button"` on `div`/`span` in `app/js`, no `addEventListener("click"` on `velta-*` hosts, every `showModal`-built dialog has `aria-labelledby`, every `<iframe>` creation sets `title`. Document the rules in `AGENTS.md` §6.2. | `tests/*.test.mjs`, `AGENTS.md` | 0.25 |

**Risks.** CI time. Chromium is already installed for the wasm e2e jobs
(`scripts/package.json` has Playwright), so reuse that cache. Flaky screenshots
call for a tolerance and font pinning. Keep the committed screenshot baselines small (≤ 6 PNGs).

**Acceptance.**
- `npx playwright test tests/a11y` runs green locally and in CI on `master`.
- A deliberately reintroduced `div role="button"` or an unlabelled modal close
  button fails CI.
- The no-JS snapshot and startup budget are reported on every push to `master`.

---

## Summary

| Phase | Scope | Days | Main payoff |
|---|---|---|---|
| 0 | Quick wins: labels, alt, buttons, drawer `inert`, interim dialog roles, toast live region, iframe titles | 2 | All shells: removes the axe criticals and the worst keyboard traps |
| 1 | Progressive app shell: pre-paint theme, chat-list skeleton, boot status, pre-hydration CSS, static templates | 3 | **PWA** (wasm core startup); cosmetic on Tauri/Android |
| 2 | Lists as buttons/links, `<dialog>` (now detailed in `modals-audit-and-plan.md`, 11.5 d on its own), menus, history semantics + live announcer, tabs/toggles/status icons | 6 | All shells: keyboard + screen-reader operable chat loop |
| 3 | State in ARIA/`data-*`/host attributes, inline styles → CSS, `hidden`, focus rings, contrast | 3 | All shells: maintainability, themeability, visible focus |
| 4 | axe + keyboard + no-JS + startup-budget tests, source guards | 2.5 | Regression safety |
| | **Total** | **16.5** | |

Suggested order: 0 → 2.1/2.2/2.4 → 1 (once Architecture C's PWA dist is on the
roadmap) → rest of 2 → 3 → 4. Start 4.1 early (right after phase 0) so later
phases are measured against it.
