# Native HTML elements survey: where the platform can replace custom JS/ARIA

Date: 2026-10-06. Base commit: `6c108a4`. The survey below is the original notes. The top 8 rows landed in the working tree on 2026-10-07 (not committed). The element count is in "What landed".

Companion to `docs/modals-audit-and-plan.md` (which covers `<dialog>` and the
overlay history contract) and `docs/web-components-audit.md` /
`docs/web-components-plan.md` (findings A1–D4 and the phased fix plan). The
platform floor and feature matrix are in `docs/modals-audit-and-plan.md`,
"Part 1b". In short: **Android 7 → Chromium 119, Android 8/9 → 138,
WebView2 evergreen, macOS 10.15 → Safari 15.6 (11 → 16.6, 12 → 17.6)**. Linux
is not a release target.

Rating scale:
- **Benefit**: what users or maintainers gain (a11y, less JS, PWA parity, perf)
- **Effort**: S ≤ 0.25 d, M ≤ 1 d, L > 1 d
- **Risk**: chance of a regression in a hot path or on an old WebView
- **Priority**: P1 = do with the next UI pass, P2 = this quarter, P3 = opportunistic, ✗ = not recommended

---

## Top recommendations

| # | Pri | Recommendation | Effort |
|---|---|---|---|
| 1 | P1 | **Popover API** for the context menu, sticker picker, drawer account popover and LC queue, plus `popover="manual"` for toasts. You get light dismiss, Esc and the top layer, and drop 4 transparent overlays and z-index hacks. Keep the overlay path for macOS 10.15/11 | M (1 d, in modals plan M5.3) |
| 2 | P1 | **`<form>` + explicit `<button type>` + constraint validation** in prompt-style modals (`askText`, group name, edit name, join link, relay address, invite domains, device name, profile). Enter-to-submit and `required`/`maxlength`/`pattern` come for free, and the 8 manual Enter `keydown` handlers go away (none of them checks `isComposing`, so Enter that commits an IME composition submits early). Prerequisite: give the ~136 buttons that have no `type` an explicit one | M (in modals plan M2) |
| 3 | P1 | **Composer and field hints**: `enterkeyhint="send"` (or `"enter"` when Send-on-Enter is off), `autocapitalize="sentences"` and `autocomplete="off"` on `#composer-input`. `type="search"` + `enterkeyhint="search"` on the 3 search fields. `inputmode="url"`/`autocapitalize="none"` on the invite-link field | S |
| 4 | P1 | **`<input type="file" accept capture>` path for the PWA.** Today the attach menu errors with "File picker is only available in the Tauri app" outside Tauri. A native file input gives the PWA photo, camera and file attachments | M |
| 5 | P2 | **`<progress>` / `<meter>`** for the transfer bars, pairing progress, chat-load bar, IAB load bar and update download, plus `<meter>` for relay quota. Screen readers get the values for free, and no inline-width divs | M |
| 6 | P2 | **Real form controls instead of clickable divs**: mute options → radios (like the ephemeral dialog), message-selection tick → visually styled `<input type=checkbox>`, drawer and ephemeral groups in `<fieldset>`/`<legend>`, drawer on/off rows → `role="switch"` checkboxes | M |
| 7 | P2 | **`<time datetime>`** for message times, day chips, chat-list times and "last seen". Machine-readable, with a `title` for the full date | S |
| 8 | P2 | **`field-sizing: content`** for the composer and edit textareas, with the current `scrollHeight` JS kept as a fallback for Android 7 and Safari | S |

Already native and fine, keep: `<details>/<summary>` (drawer settings, toasts,
chat info, pin tray, splash log); `<audio controls>`; `<video controls>` in the
lightbox; `<textarea>` composer (no contenteditable); `<label>`-wrapped
checkboxes and radios in the drawer; radios in the ephemeral dialog;
`overscroll-behavior`; `:has()`; `loading="lazy"` on stickers and link previews.

The table above is the original recommendation, including the ~136 button estimate and the 3 search fields. The count below is what the diff against `v1.4.60` actually changed. A form and the controls inside it are counted as separate elements. Disappearing-message radios were already radios; only their fieldset and legend are new.

## What landed

**217 elements.**

| What | Elements |
|---|---|
| Untyped buttons given `type="button"` | 119 |
| Untyped buttons given `type="submit"` | 10 |
| Splash "Create account", already `type="button"`, now `type="submit"` | 1 |
| `<form>`: ask text, group name, edit name, join link, nickname, device name, edit profile (`showModal({ form: true })`), plus profile-add, splash relay, invite domain, local-chat send | 11 |
| Popovers: context menu, sticker picker, account menu, local-chat queue, toasts | 5 |
| `<progress>`: transfer, pairing, chat-load, in-app browser, app update | 5 |
| Relay quota `<meter>` | 1 |
| `<fieldset>`: 8 drawer groups, disappearing messages, mute | 10 |
| `<legend>` on those fieldsets | 10 |
| Drawer checkboxes given `role="switch"` (4 bottom-bar, 5 chat categories, 18 other rows; 5 of the 27 are Android-only) | 27 |
| Mute rows turned from divs into radios (5 durations, plus Unmute) | 6 |
| Message-selection tick turned into a checkbox | 1 |
| `<time>`: message, day chip, chat list, chat-head last seen, chat-info last seen, calls | 6 |
| Composer (`enterkeyhint`, capitalization, `autocomplete`, `field-sizing` with the `scrollHeight` fallback) | 1 |
| Search fields set to `type="search"` | 2 |
| Invite-link field (`inputmode="url"`) | 1 |
| PWA `<input type="file">` | 1 |

Not in this pass: there is no contact-picker search field, so two search fields rather than three. The QR paste box stays a textarea (Enter submits only when an IME composition is not open). Local group create and add-members stay as they were. Popover placement stays in JS until the floor reaches Chromium 125 / Safari 26, and macOS 10.15/11 keep the overlay path. `field-sizing` stays behind `CSS.supports`. A file chosen in the browser still needs the Velta app to send, because the core wants a real path.

---

## Survey

### 1. Popover API (`popover`, `popovertarget`, `showPopover()`)

Support: Chromium 114 (all Android floors ✓, WebView2 ✓), Safari 17.0 (macOS
12+ with Safari 17; **✗ on 10.15/11**). `popover="hint"` (Chromium 133, no
Safari) not yet. Anchor positioning (Chromium 125, Safari 26) is ✗ on Android 7
and older macOS, so keep the JS placement.

| Candidate | file:line | Today | With popover | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|---|
| Context menu (6 call sites) | `ui.js:28-55` | transparent `.pop-overlay` + `pointerdown`/`contextmenu` close, z 60, viewport clamp | `popover="auto"` on `.ctx-menu`: light dismiss, Esc, top layer above dialogs (menus *inside* a dialog work). Clamp stays in JS | High | M | Low | P1 |
| Attach menu | `chat-view.js:2589-2620` | same helper + manual bottom/top math | same; later `position-anchor: --attach` + `position-try` when the floor reaches Chromium 125 / Safari 26 | Med | S (rides on the above) | Low | P1 |
| Sticker picker | `ui.js:57-97` | overlay, z 930 | `popover="auto"` | Med | S | Low | P1 |
| Drawer account popover | `ui.js:537,660` | `hidden` toggle + document listener | `popover="auto"` + `popovertarget` on the account button (`aria-expanded` comes free) | Med | S | Low | P2 |
| LC queue popover | `app.js:983-1012` | `toggleLcQueuePop`, manual placement, z 920 | `popover="auto"`, `popovertarget="lc-queue-pop"` on `#lc-queue-chip` | Med | S | Low | P2 |
| Toast stack | `ui.js:155-248`, `#toasts` z 80 | under every full-screen overlay (modals doc M3) | `#toasts[popover="manual"]`, `showPopover()` re-called after each dialog open so it stays topmost | High | S | Med (ordering) | P1 |
| Selection quote chip | `chat-view.js:2499` | fixed div, inline left/top, z 860 | `popover="manual"` (top layer over lightbox/dialog) | Low | S | Low | P3 |
| Tooltips (`title=` everywhere) | many | native `title` | keep `title` (works with touch long-press on Android). `popover=hint` only after Safari ships it | Low | – | – | ✗ |
| Emoji picker | – | doesn't exist (quick reactions are a menu row at `chat-view.js:2277`) | if one is built: `popover="auto"` grid of `<button>` | – | – | – | – |

Fallback: `const hasPopover = HTMLElement.prototype.hasOwnProperty("popover")`.
Without it, keep today's overlay code path. Only macOS 10.15/11 users hit it.

### 2. `<details>` / `<summary>`

Support: universal. `details[name]` exclusive accordions: Chromium 120 (✗ on
Android 7), Safari 17.2.

| Candidate | file:line | Note | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|
| Drawer settings sections | `ui.js:549-610` | already `<details class="drawer-details">` | – | – | – | keep |
| Toasts | `ui.js:166+` | `<details class="toast">` (expand for long errors), fine | – | – | – | keep |
| Chat-info sections | `app.js:2260,2287,2296,2301` | already native | – | – | – | keep |
| Pin tray | `chat-view.js:572-635` | already native | – | – | – | keep |
| Splash log | `app.js:3870` | already native | – | – | – | keep |
| Exclusive drawer sections | `ui.js:549-610` | `name="drawer-settings"` would auto-close siblings (optional UX; harmless where unsupported) | Low | S | Low | P3 |
| Diagnostics / message-info raw headers | `chat-view.js:2311` (message info) | long technical blocks could collapse in `<details>` | Low | S | Low | P3 |

### 3. `<select>` / `<datalist>`

| Candidate | file:line | Today | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|---|
| Mute duration | `app.js:2186-2213` | list of clickable `div.eph-row` (not focusable) | radio list like the ephemeral dialog (`app.js:2128-2140`); a `<select>` would hide the options behind a tap | High (keyboard/SR) | S | Low | P1 (also audit A9) |
| Relay address | `app.js:3071,3863` | free text | `<datalist>` of known public relays (chatmail list) for suggestions; still free text | Med | S | Low (Android datalist UI is basic) | P3 |
| Invite domains | `invites.js:328` | free text | `<datalist>` of known mirrors (`i.delta.chat`, …) | Low | S | Low | P3 |
| Theme / UI scale / media quality | `ui.js:552,558` | radios | keep radios (all options visible) | – | – | – | keep |

### 4. Inputs: `type=search|range|color|file`, `accept`, `capture`

| Candidate | file:line | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|
| Search in chat | `app.js:2799` | `type="search"`, `enterkeyhint="search"`, `aria-label`. Esc clears natively (desktop). Wrap in `<search>` | Med | S | Low (style the WebKit cancel button) | P1 |
| Sidebar chat search | `app.js:2970` | same | Med | S | Low | P1 |
| Contact picker filter | `app.js:2886` (pickContactModal) | same if a filter is added | Low | S | Low | P3 |
| **PWA attachments** | `chat-view.js:2810-2825` | when `!invoke`: create `<input type=file>` with `accept="image/*"` (photo), `accept="video/*"` (video), none (file), `multiple` where the core supports it. On Android Chrome `capture` opens the camera directly: offer "Camera" → `accept="image/*" capture="environment"` | High (PWA parity) | M | Low | P1 |
| Profile picture (PWA) | `app.js:3655-3675` | already a native file input fallback; add `capture="user"` option for a selfie | Low | S | Low | P3 |
| Tauri attachments | `chat-view.js:2828` | keep the Tauri dialog plugin (gives real file paths for the core) | – | – | – | keep |
| `type=range` | – | no slider UIs today. UI scale stays radios. The image cropper uses handles (`chat-view.js:205`); a range "zoom" could complement it | Low | S | Low | P3 |
| `type=color` | – | no colour picking anywhere (avatar colours come from the core) | – | – | – | n/a |
| Passphrase | `app.js:3088` | already `type=password autocomplete=new-password`; add `minlength="6"` (matches the "min 6 chars" text) | Low | S | Low | P2 (with forms) |

### 5. `<progress>` / `<meter>` / `<output>`

Support: universal. Styling: `appearance:none` + `::-webkit-progress-*` / `::-moz-*`, or keep the div visual and put a visually-hidden `<progress>` next to it.

| Candidate | file:line | Today | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|---|
| File transfer bar | `chat-view.js:1403` | `.mfp-bar > i[style=width:N%]` + text | `<progress max=100 value=N>` | Med | S | Low (row sig must include value) | P2 |
| P2P pairing bar | `p2p.js:385-394` | inline-styled div, `width` updates | `<progress>`; indeterminate (`value` absent) while "Preparing…" | Med | S | Low | P2 |
| Chat load bar | `index.html:85` | `div[role=progressbar]` with a CSS sweep | `<progress aria-label="Loading chat history">` without value = indeterminate | Low | S | Low | P3 |
| In-app browser load bar | `inapp-browser.js:31` | `::before` sweep | indeterminate `<progress>` | Low | S | Low | P3 |
| Update download | `ui.js:389-440` | percentage in the button text | `<progress>` under the button + `aria-describedby` | Med | S | Low | P2 |
| Relay quota | `app.js:572,774-775` | "55% used" text parsed from core HTML | `<meter min=0 max=100 low=70 high=90 optimum=0 value=55>` in the relay detail | Med | S | Low | P2 |
| Selection count | `index.html:106` (`#sel-count`) | span updated by JS | `<output aria-live="polite">` | Low | S | Low | P3 |

### 6. `<time datetime>`, `<search>`, `<menu>`

| Candidate | file:line | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|
| Message time | `chat-view.js:1549` | `<time datetime="${iso}" title="${full}">${formatTime(ts)}</time>` | Med (SR/date context, copy) | S | Low (row signature unchanged: derived from ts) | P2 |
| Day chips | `chat-view.js:1330,1374` | `<time datetime="YYYY-MM-DD">` | Low | S | Low | P2 |
| Chat-list time | `components.js:352` | `<time>` | Low | S | Low | P2 |
| Last seen / calls list | `components.js:391`, `app.js:1380,2235` | `<time>` with absolute `title` | Low | S | Low | P3 |
| `<search>` landmark | `app.js:2799,2970` | wraps the search field + results (Chromium 118, Safari 17. On older engines it's an unknown inline element, so add `role="search"` too) | Low | S | Low | P2 |
| `<menu>` | `ui.js:28-55` | `<menu>` is just a list (`role=list`), not `role=menu`. Use `role="menu"`/`menuitem` + arrow keys (audit A14) on the popover instead | – | – | – | ✗ |

### 7. Forms: `<fieldset>/<legend>`, validation, `<label>`, `role=switch`

| Candidate | file:line | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|
| Prompt-style modals | inputs `app.js:3008,3031,3071,3806,3863`, `invites.js:328`, `p2p.js:186,430`, `ui.js:901`; Enter handlers `app.js:3023,3048,4055`, `invites.js:368`, `p2p.js:199`, `qr-scan.js:123`, `ui.js:963` (none checks `isComposing`) | `<form method="dialog">` (in a `<dialog>`, modals plan M2) or `<form>` + `submit` handler. Enter submits; `required`, `maxlength` (already set), `pattern` for hostnames (`invites.js` host check), `minlength` for passphrase. `reportValidity()` instead of toasts | High | M | **Med: every untyped `<button>` inside a form becomes a submit button. index.html has 24 and template strings 65 `<button>` without `type`, plus 47 `createElement("button")` that default to submit.** Add `type="button"` first | P1 |
| Drawer radio groups (theme, UI scale) | `ui.js:552,558` | `<fieldset>` + `<legend class="visually-hidden">` inside the `<details>` (or `role="radiogroup" aria-labelledby` on the summary) | Med | S | Low | P2 |
| Drawer checkbox groups (bar items, categories, notifications) | `ui.js:564,571,578-584` | `<fieldset>` + legend | Med | S | Low | P2 |
| Ephemeral options | `app.js:2128-2140` | `<fieldset>` around the radios | Low | S | Low | P2 |
| On/off toggles ("Local chat: on") | `ui.js:546-547` + other `ctx-item` toggles | `role="switch"` on the checkbox. Drop the ": on/off" text from the label (state comes from `aria-checked`) or keep it `aria-hidden`. Safari 17.4's `<input switch>` is a progressive extra only | Med | S | Low | P2 |
| Message selection tick | `chat-view.js:1377,2367,2387` | real `<input type=checkbox>` (visually the circle) with `aria-label="Select message"`. Today it's a `div.msg-checkbox` with an SVG | Med | M | Med (hot render path: add to `_rowSigCache` inputs) | P2 |
| Splash relay / device name inputs | `app.js:3863`, `p2p.js:186` | visible or `aria-label` labels (audit 0.9) | Med | S | Low | P1 (in plan 0.9) |

### 8. `<a href>` vs click handlers, `<button type>`, `inert`, `<template>`

| Candidate | file:line | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|
| Chat rows | `components.js` `<velta-chat-item>` | rows as `<button>` (audit 2.1). `<a href>` only makes sense once the PWA has URL routing (`#/chat/ID`). Velta routes through `history.state`, not URLs | Med | – (in plan 2.1) | – | P2 (plan) |
| Message links | `chat-view.js` linkify | already `<a href>` with interception, keep | – | – | – | keep |
| "Download APK" / external links | `ui.js:389-440`, `inapp-browser.js` "Open externally" | stay buttons (Tauri opener needed); for the PWA use `<a href target=_blank rel=noopener>` | Low | S | Low | P3 |
| `<button type>` hygiene | `index.html` (24), JS templates (65), `createElement("button")` (47) | `type="button"` everywhere; add a source guard to `tests/app-source-integrity.test.mjs` | Med (enables forms) | S | Low | P1 |
| `inert` on the closed drawer | `ui.js:524-878` | plan 0.3 (Chromium 102, Safari 15.5: no gaps) | High | S | Low | P1 (plan) |
| `inert` behind custom overlays | webxdc/HTML viewer/IAB/call | becomes free once they're `<dialog>` (modals plan M5). Until then `#app.inert = true` while open | Med | S | Low | P2 |
| `<template>` for static markup | drawer (`ui.js:530-610`), splash (`app.js:3843+`), side-view empty (`app.js:1312`), modal bodies built from strings with inline styles | `<template id>` in `index.html` + `cloneNode`. Cleaner diffs, CSP-friendly, parsed once. Pairs with plan Phase 1 (static shell) | Med | M | Low | P3 |

### 9. Media: `loading`, `decoding`, `<picture>`, `<audio>`/`<video>`, `alt`

| Candidate | file:line | Suggestion | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|
| Message images | `chat-view.js:1432` | `data-src` + `decoding="async"`; the virtual scroller only mounts visible rows, so `loading="lazy"` adds little. Keep. Add `fetchpriority="high"` on the lightbox image (`ui.js:1055`) | Low | S | Low | P3 |
| Avatars | `components.js:107` | already lazy/decoded async (Elena avatar), keep | – | – | – | keep |
| webxdc icon | `chat-view.js:1476` | add `loading="lazy"` | Low | S | Low | P3 |
| Thumbnails at DPR | thumbnail URLs (`?w=720`) | `srcset` (360/720/1440w) + `sizes`, or `<picture>` with WebP when the core can produce it. Mainly saves PWA bandwidth | Med (PWA) | M | Med (media URL chain, WebView2 protocol quirks in `media.js:34,79`) | P3 |
| Audio messages | `chat-view.js:1463` | native `<audio controls preload=metadata>`, keep; add `aria-label="Voice message from …"` | Low | S | Low | P2 |
| Video | `components.js:163-256`, `ui.js:1152` | tap-to-create `<video>` then native controls in the lightbox; keep (decoder budget). Play overlay → `<button>` (plan 0.6) | – | – | – | plan |
| Voice recording | `chat-view.js` `_recordVoice`, `#voice-rec` | implemented: `MediaRecorder` + `#btn-voice-send` (`aria-pressed="true"`) while recording. No native element replaces the recorder | – | – | – | keep |
| `alt` text | message images, lightbox, stickers | covered by plan 0.7/0.9 | – | – | – | plan |

### 10. Composer: `enterkeyhint`, `inputmode`, `autocomplete`; contenteditable vs textarea

`index.html:168`: `<textarea id="composer-input" rows="1" placeholder="Message" aria-label="Message">`

| Attribute | Suggestion | Support | Benefit | Effort | Pri |
|---|---|---|---|---|---|
| `enterkeyhint` | `"send"` when Send-on-Enter is on (`velta-send-enter !== "0"`, `chat-view.js:2565`), else `"enter"`. Update when the setting toggles | Chromium 77, Safari 13.1 | Med (correct key label on Android/iOS keyboards) | S | P1 |
| `autocapitalize` | `"sentences"` | Android Chrome ✓, Safari ✓ | Low | S | P1 |
| `autocomplete` | `"off"` (no form-autofill suggestions above the keyboard) | ✓ | Low | S | P1 |
| `spellcheck` | leave default (on) | ✓ | – | – | keep |
| `inputmode` | leave default `text` | ✓ | – | – | keep |
| Search fields | `type=search enterkeyhint=search` | ✓ | Med | S | P1 |
| Join link `#join-input` | `inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false"` (the relay inputs already do this) | ✓ | Low | S | P1 |
| Name inputs | `autocomplete="nickname"` (profile), `"off"` elsewhere | ✓ | Low | S | P3 |
| `field-sizing: content` | replace the `scrollHeight` autogrow (`chat-view.js:517,2550`) with `field-sizing: content; max-height: 40dvh`. Keep the JS behind `@supports not (field-sizing: content)` / `CSS.supports` | Chromium 123 (✗ Android 7), Safari ✗ | Med (less layout thrash per keystroke) | S | P2 |
| **contenteditable vs textarea** | **keep `<textarea>`**. No contenteditable anywhere. Mentions/rich text would be the only reason to switch, and it costs IME, undo, paste-sanitising and a11y work. Not recommended | – | – | – | ✗ |

### 11. CSS: `:has()`, container queries, scroll-snap, overscroll-behavior

| Candidate | file:line | Suggestion | Support | Benefit | Effort | Risk | Pri |
|---|---|---|---|---|---|---|---|
| `:has()` state | already `main.css:1342`. Candidates: `.app.chat-open` toggled by JS (`app.js:1967`, `closeChatUI`), `body.chat-read-only` (`main.css:574`) | Prefer keeping explicit state classes or attributes set by JS (plan Phase 3). Use `:has()` only for *derived* styling, e.g. `.drawer-details:has(:checked)` or `html:has(dialog.modal[open])` | 105 / 15.4 ✓ | Low | S | Low | P3 |
| Container queries | `.qr-box` already `container-type` (`main.css:1691`). Candidate: chat rows and modal content inside the 300–420px pane (`main.css:1354-1363`) vs full-screen sheet | `@container` on `.sidebar` and `.modal` so the same component adapts to pane width instead of viewport media queries | 105 / **16** (✗ macOS 10.15) | Med | M | Low (10.15 keeps the base layout) | P3 |
| scroll-snap | category chips `index.html:46` (horizontal scroll), image galleries (none yet) | `scroll-snap-type: x proximity` on `.chat-cats` | ✓ | Low | S | Low | P3 |
| overscroll-behavior | `main.css:58` (none on html/body), `main.css:365` (contain) | add `overscroll-behavior: contain` to `.modal-body`, `.drawer` items, `.sticker-grid`, `.ctx-menu`, `#lc-queue-pop` so the end of a list doesn't scroll the pane behind | 63 / 16 ✓ | Med | S | Low | P2 |
| `scrollbar-gutter` | already used | – | – | – | – | – | keep |

### 12. Other native platform features worth noting

| Feature | Candidate | Support | Pri |
|---|---|---|---|
| Invoker commands (`commandfor`, `command="show-modal"`/`"close"`/`"toggle-popover"`) | declarative open/close for the ✕ buttons and popover triggers | Chromium 135, Safari 26.x; ✗ Android 7–9 caps, ✗ older macOS | P3 (future, behind the JS) |
| `hidden="until-found"` | collapsed long sections so Ctrl+F finds text (desktop) | Chromium 102; not at the macOS floors | P3 |
| CSS Custom Highlight API | in-chat search hit highlighting without wrapping spans | Chromium 105, Safari 17.2 | P3 |
| Tabs | `role=tab` buttons (`app.js:1408,2949`). No native tab element exists. Keep ARIA tabs and add `aria-selected`/arrow keys (plan 2.x) | – | plan |
| Category chips | `index.html:46` `role=toolbar`. Radio-group semantics (`role=radiogroup` + `aria-checked`) fit a single-select filter better | ✓ | P3 |

---

## Suggested sequencing

1. With modals plan M1/M2: `type="button"` sweep + source guard, then forms
   (#2), composer and field hints (#3).
2. With modals plan M5.3: popovers (#1) and toasts on `popover=manual`.
3. PWA track (Architecture C): file input (#4), `srcset`, `<template>` shell.
4. Semantics pass (plan Phase 2/3): `<progress>`/`<meter>` (#5), real controls (#6),
   `<time>` (#7), `overscroll-behavior: contain`, `field-sizing` (#8).

Each item ships on its own. Re-run `chatlist-incremental`, `scroll-restore`
and `chat-msg-update-hardening` for anything that touches message or chat rows
(row signatures must include new attributes, AGENTS.md §11 "Event-storm
hardening").
