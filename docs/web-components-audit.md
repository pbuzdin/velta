# Web components audit: semantics, accessibility, progressive rendering

Audit date: 2026-10-06. Baseline: `master` @ `02d5e78`. Scope: everything under
`app/` that renders UI. That is the four Elena custom elements plus the plain-DOM
"components" (builder functions) that make up the rest of the UI. This is a
documentation-only audit: no app code was changed. The phased fix plan is in
[`web-components-plan.md`](web-components-plan.md).

Related prior work: [`VENDOR-REVIEW.MD`](../VENDOR-REVIEW.MD) §1 (Elena fit and
library bugs E1–E4) and `VENDORISSUES.MD` #3/#8/#9 (Elena workarounds). This
audit doesn't repeat those. It cites them where the a11y or progressive-rendering
impact is new.

---

## 1. Summary

- **Inventory: 31 UI components.** 4 are Elena custom elements
  (`<velta-avatar>`, `<velta-video>`, `<velta-chat-item>`, `<velta-chat-head>`,
  all in `app/js/components.js`). 27 are plain-DOM components: the static shell in
  `index.html`, and builders in `app.js`, `ui.js`, `chat-view.js`, `calls.js`,
  `p2p.js`, `webxdc-manager.js` and others. One more page, `diag.html`, is a
  separate static page.
- **Elena is used as a small client-side renderer, not as a progressive
  layer.** All four elements are Elena "Primitive" components (`render()`,
  light DOM, no shadow DOM, no `static styles`). None of them ships
  pre-hydration CSS (`:not([hydrated])` / `:not(:defined)`). None uses `this.text`.
  None ever appears in static HTML: JS always creates them. Elena is
  vendored (`app/vendor/elena.js`, `@elenajs/core` 1.0.1, 7.8 KB). It isn't
  an npm dependency. `scripts/package.json` only pulls Playwright for the wasm e2e.
- **The static app shell is already a good base.** `index.html` paints the
  sidebar header, the bottom action bar, the "Select a chat" empty state and
  (hidden) the chat header and composer before any JS runs. All CSS lives in
  one page stylesheet (`app/css/main.css`). No Elena component injects styles
  from JS (exception: the in-app browser, `inapp-browser.js:10-40`, injects its
  own `<style>`; see `modals-audit-and-plan.md` M14).
  What is missing: the chat list paints empty until the whole module graph
  boots, and the theme is only applied by `app.js`.
- **Accessibility is the main gap.** The core chat loop is not
  keyboard-operable:
  - Chat rows are not focusable (measured: Tab skips all 12 demo rows).
  - The chat header, video play, attachment cards, message images and avatars
    are click-only.
  - Message actions are context-menu/long-press only.
  - Modals have no dialog semantics or focus management.
  - The closed drawer stays in the tab order.
  - Nothing in the app uses `aria-live`. New messages, toasts and incoming calls
    are not announced.
- **Findings: 44 in total: 14 high, 19 medium, 11 low** (§5).

### Top 5

1. **A1 (high):** Chat list rows can't be reached or opened by keyboard. They
   are `<velta-chat-item>` hosts with a click listener and an inner `role="option"`
   div, with no tabindex and no key handling (`components.js:347`, `app.js:1658-1672`).
2. **A10/A11 (high):** `showModal()` builds a plain `div.modal`. It has no
   `role="dialog"`, `aria-modal` or `aria-labelledby`. Focus stays on `<body>`, and
   the close button has no accessible name (axe *critical* `button-name`)
   (`ui.js:99-152`, `ui.js:116-118`). About 35 call sites inherit this.
3. **A13/A14 (high):** No live regions anywhere. `#history` and `#toasts` are
   plain divs (`index.html:119`, `index.html:182`), so incoming messages and
   error toasts are silent for screen readers.
4. **A12 (high):** The closed drawer is only moved off-screen with
   `translateX(-100%)` (`main.css:1494-1510`), so 19 hidden controls stay in the
   tab order (measured). Opening it doesn't move focus, and `#bar-menu` has no
   `aria-expanded`.
5. **B1 (high for the PWA):** The chat list is empty until JS boot finishes.
   Measured under slow-4G emulation: first contentful paint at 1.0 s (static
   shell), first chat row at 6.3 s. That's a 5 s blank list with no skeleton and no
   `aria-busy`. Today's measurement excludes the wasm core (~4.4 MiB brotli), and
   with it the gap grows.

### Where progressive rendering pays off

Tauri desktop and Android load `app/` from local disk or the app bundle, so
network-bound first-paint gains there are small: the measured unthrottled
load paints the first chat row in about 0.3 s. The payoff is in the **PWA
path** (`PLAN-PWA-WEBSOCKET.MD`, Architecture C). There the static HTML+CSS
arrives long before the module graph and the wasm core finish loading and
starting. Phase 1 of the plan targets that case. Accessibility fixes (phases
0, 2 and 3) apply equally to every shell.

---

## 2. Method

1. Read `AGENTS.md` (§2, §3, §4.2, §6.2, §7.2), `VENDOR-REVIEW.MD` §1 and the
   Elena docs (`elenajs.com/llms-full.txt`: Primitive/Composite/Declarative
   components, the `hydrated` attribute, pre-hydration CSS).
2. Enumerated components with
   `rg "customElements|extends (HTMLElement|Elena)|\.define\(\)|attachShadow|adoptedStyleSheets|:defined|:state\("`.
   This found exactly 4 custom elements and 0 shadow roots, constructed sheets,
   `:defined` rules or `:state()` uses. Then walked every UI builder in `app/js/*.js`.
3. Searched for semantics hot spots: `role=`, `aria-*`, `tabindex`,
   `addEventListener("click"` on non-buttons, `<img … alt`, `iframe` titles,
   `keydown`/`Escape` handling, `.focus()`, inline styles
   (`style=` / `.style.x =` / `cssText`), and state classes (`classList.toggle`).
4. **Tests:** ran `node --test tests/*.test.mjs`. Result: 357/357 pass.
   The cases `AGENTS.md` §7.2 lists as known-broken are now green too.
5. **Headless Chromium** (system Chrome via `playwright-core` + `axe-core` 4,
   installed in a scratch dir outside the repo). I served `app/` with
   `python3 -m http.server`:
   - **JS disabled**, 1280×800 and 412×860: screenshot plus visible text.
   - **JS enabled, demo mode** (`localStorage["velta-mock"]="1"`): axe-core
     run on the chat list, an open chat, the open drawer and the chat-info modal.
     I also ran a 40-step Tab walk, checked focus after drawer and modal open,
     and read the modal's role attributes.
   - **Timing**: unthrottled vs. slow-4G (150 ms RTT, 1.6 Mbps down) with cache
     disabled. Recorded FCP, LCP, time to the first `velta-chat-item[hydrated]`,
     and CLS.
   - axe needed `bypassCSP` because the page CSP blocks inline script injection.
     That only affects the test harness.

### Measured results

| Measurement | Result |
|---|---|
| No-JS paint, desktop | Sidebar header + bottom bar + "Select a chat to start messaging" empty state; chat list blank. Dark theme only. |
| No-JS paint, mobile 412 px | Header + bottom bar; **no text at all** (list blank, main column hidden on mobile) |
| Unthrottled (demo core) | FCP 32 ms, first chat row 285 ms, LCP 272 ms, CLS 0.028 |
| Slow-4G (demo core, no compression, no wasm) | **FCP 1 020 ms, first chat row 6 290 ms**, LCP 6 272 ms, CLS 0.028; 47 requests, ~1.05 MB, 32 JS files |
| Tab walk | `#btn-search` → 6 category chips → `#chat-list` (scroll container) → 6 bar buttons → **19 stops inside the closed drawer** → body. **No chat row ever receives focus.** |
| Focus after opening drawer | stays on `#bar-menu` |
| Focus after opening a modal | `<body>`; `.modal` has `role=null`, `aria-modal=null`, `aria-labelledby=null` |
| axe (list view) | serious: `color-contrast` (11), `scrollable-region-focusable` (#chat-list); moderate: `meta-viewport`, `page-has-heading-one`, `region` (13); minor: `aria-allowed-role` (#chat-list, .list-bar) |
| axe (open chat) | + serious `nested-interactive` (`.msg-webxdc`) |
| axe (chat-info modal) | + **critical `button-name`** (`.modal-head > .icon-btn`), serious `svg-img-alt` (identity tile SVG), `region` (21) |

axe only sees what is mounted and visible, so it misses most keyboard and
focus problems (A1, A3–A8, A12). The Tab walk and code reading cover those.

---

## 3. Inventory

Legend:
- **Kind**: Elena = `Elena(HTMLElement)` custom element; DOM = plain
  `createElement`/`innerHTML` builder; static = markup in an HTML file.
- **DOM**: every component uses light DOM. There's no shadow DOM in the app.
- **Pre-JS**: renders meaningful markup/CSS before JS runs (y/n/partial).
- **A11y**: ok / partial / poor.

| # | Component | File:lines | Kind | DOM | Pre-JS | A11y | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `<velta-avatar>` | `js/components.js:13-123` | Elena | light | n | partial | `aria-hidden` tile (good when decorative). Click-wired as a profile button in 2 places with no role or focus (A7). Inline size/color styles (C2). |
| 2 | `<velta-video>` | `js/components.js:141-263` | Elena | light | n | poor | Host-click play, play overlay is a `<span>`, `ariaLabel()` (239-241) never used (A4) |
| 3 | `<velta-chat-item>` | `js/components.js:301-362` | Elena | light | n | poor | Inner `div role="option"` with no tabindex/`aria-selected`. `.active` class duplicates the host `[active]` (A1, C1). |
| 4 | `<velta-chat-head>` | `js/components.js:365-412` | Elena | light | n | poor | Clickable host opens chat info, not focusable (A3). Name is a `div`, not a heading. |
| 5 | App shell | `index.html:26-186` | static | light | **y** | partial | Real `<aside>/<header>/<nav>/<main>/<section>/<footer>`, labelled icon buttons, labelled textarea. Problems: `nav role=listbox`, `footer role=toolbar` (A2), `user-scalable=no` (A21). |
| 6 | Chat list + ghost rows | `js/app.js:1553-1672` | DOM | light | n (empty `<nav>`) | poor | No skeleton (B1). Inline-styled empty state `1615` (B6). |
| 7 | Chat categories bar | `index.html:46-53`, `js/app.js:1538-1551` | static+DOM | light | partial (hidden) | partial | Native buttons. State only via `.active` (A17, C1). |
| 8 | Bottom list bar | `index.html:55-74`, `js/app.js:1262-1290` | static | light | **y** | partial | Labelled buttons. Active view via `.active`, no `aria-current`/`aria-pressed`. `#btn-search` name doesn't follow its title (A26). |
| 9 | Relay line + detail chips | `index.html:42-45`, `js/app.js:680-770` | static+DOM | light | partial | partial | Good `data-state` CSS (C1 positive). `role=status` with label-only updates (A28). |
| 10 | Side views (contacts, calls, search, new, QR) | `js/app.js:1295-1450`, `2928-2960` | DOM | light | n | partial | Rows are real `<button class="chat-item">` (good). `role=tab` without `aria-selected`/panels (A17). |
| 11 | Drawer / settings | `js/ui.js:524-878` | DOM | light | n | poor | Native checkboxes/radios/`<details>` (good). In tab order while closed, no focus management or `aria-expanded` (A12). Clickable avatar (A7). |
| 12 | Modal (+ confirm/delete variants) | `js/ui.js:99-152`, `250-288` | DOM | light | n | poor | No dialog semantics or focus management, unnamed close (A10, A11). Inline danger colors (C2). |
| 13 | Context menu | `js/ui.js:28-55` | DOM | light | n | partial | `<button>` items (good). No `menu`/`menuitem`, no focus/arrow keys. Opened only by pointer (A8). |
| 14 | Sticker picker | `js/ui.js:57-97` | DOM | light | n | partial | Tiles are buttons with only `<img alt="">`, so they're nameless (A25) |
| 15 | Toasts | `js/ui.js:166-248` | DOM | light | n | partial | Native `<details>/<summary>` (good). Container not live (A14). |
| 16 | Image/video lightbox | `js/ui.js:1033-1174` | DOM | light | n | partial | Esc + labelled close (good). Not a dialog, `alt=""` despite a known caption (A20). |
| 17 | Message rows | `js/chat-view.js:1334-1900` | DOM | light | n | poor | `div` rows, `role=button` divs, click-only images, chips and quotes, unlabelled ticks (A5, A6, A8, A9, A16) |
| 18 | Pinned-messages tray | `js/chat-view.js:586-635` | DOM | light | n | partial | `<details>` summary (good). Items are clickable divs (A9). |
| 19 | Composer, reply/media preview, selection bar | `index.html:102-176`, `js/chat-view.js:2400-2660` | static+DOM | light | **y** (hidden) | ok/partial | Labelled controls. Selection actions named by `title` only, count not live (A27). |
| 20 | Bubble text-selection bar | `js/chat-view.js:2108-2155` | DOM | light | n | ok | Native buttons |
| 21 | HTML viewer overlay | `js/chat-view.js:2954-2990` | DOM | light | n | partial | `iframe` without `title` (A18). Labelled close. |
| 22 | Splash / onboarding | `js/app.js:3843-3990` | DOM | light | n | partial | `<h1>`, real buttons, logo alt (good). Relay input has a placeholder only, and the steps list isn't live (A19). Fully JS-built (B4). |
| 23 | Call overlay | `js/calls.js:280-310` | DOM | light | n | poor | Not an `alertdialog`, no focus on Accept, status not live, mute without `aria-pressed` (A15, A28) |
| 24 | Webxdc app overlay | `js/webxdc-manager.js:215-250` | DOM | light | n | partial | `iframe` without `title` (A18). Labelled close. |
| 25 | In-app browser overlay | `js/inapp-browser.js:70-95` | DOM | light | n | partial | `iframe` without `title` (A18). Labelled buttons. |
| 26 | Local chat (P2P) card + modals | `js/p2p.js:240-300`, `js/app.js:1110-1140` | DOM | light | n | partial | `.p2p-row` clickable divs (A9). Labelled lc-card buttons. Inline styles (C2). |
| 27 | Invite cards | `js/invites.js:133-260` | DOM | light | n | ok | Buttons with `aria-label` |
| 28 | Link preview card | `js/link-preview.js:104-121` | DOM | light | n | ok | `<a>` card. Decorative `alt=""` is fine, since the title text carries the name. |
| 29 | Diagnostics rows | `js/diagnostics.js:110-144` | DOM | light | n | ok | Labelled copy button |
| 30 | Edit-profile modal | `js/ui.js:889-972` | DOM | light | n | partial | `aria-label` inputs (good). Inherits modal issues. `style.display` toggling (C3). |
| 31 | `diag.html` | `app/diag.html` | static | light | **y** | ok | Standalone service diagnostics page with `<h1>` and buttons |

---

## 4. Elena usage

| Aspect | Finding |
|---|---|
| Distribution | `app/vendor/elena.js` (`@elenajs/core` 1.0.1, MIT, 7.8 KB minified), imported directly by `components.js:2`. There's no frontend package.json and no bundler. |
| Components using Elena | 4 of 31 UI components, all Primitive (`render()` + `html`/`unsafeHTML`) |
| Progressive features used | **None.** No `:not([hydrated])` CSS, no `this.text`, no Composite components wrapping static HTML, no Declarative Shadow DOM. Elena sets `hydrated` on every instance (25 measured), but no CSS reads it. |
| Shadow DOM / `static styles` | Not used. All styles are in `main.css` (consistent light DOM). |
| `static events` | `velta-chat-item`, `velta-chat-head` re-dispatch `click` from the inner element (`components.js:304`, `367`) |
| Workarounds | Hyphenated-prop defaults set in constructors (`components.js:26-29`, `312-321`, VENDORISSUES #3/#9). A "self-heal" block reaches into Elena's **minified private fields** `h`, `D`, `F`, `N` (`components.js:38-42`, `158-162`, VENDORISSUES #8). A recreate-instead-of-update policy for rows and heads (`app.js:1557-1566`, `1594-1600`, `1904-1906`, `1925-1929`). |
| Everything else | About 27 UI surfaces are imperative `innerHTML`/`createElement` builders. The same visual "chat row" exists in three implementations: `<velta-chat-item>` (not focusable), `<button class="chat-item contact-row">` (`app.js:1316`, `1353`) and `<button class="chat-item call-row">` (`app.js:1376`). |

VENDOR-REVIEW's rule ("Elena for leaf components only; the message list stays
hand-rendered") is sound, and this audit doesn't argue against it. The gap is
that Velta uses none of the progressive half of Elena's design. Its four leaf
components can't render anything until JS defines them, so they can't take part
in a static app shell.

---

## 5. Findings

Severity:
- **High** blocks a core task for keyboard or screen-reader users, or (B1)
  costs seconds of blank UI on the PWA.
- **Medium** is a real barrier or inconsistency with a workaround.
- **Low** is polish.

Counts: **14 high, 19 medium, 11 low (44 in total).**

| Category | High | Medium | Low |
|---|---|---|---|
| A. Semantics & accessibility | 13 | 11 | 6 |
| B. Progressive rendering | 1 | 3 | 2 |
| C. CSS semantics | 0 | 2 | 2 |
| D. Elena usage | 0 | 3 | 1 |

### A. Semantics & accessibility

**A1 (high): chat rows aren't keyboard-operable.**
- `index.html:54`: `<nav id="chat-list" role="listbox">`.
- `components.js:347`: each row renders `<div class="chat-item" role="option">` with no
  `tabindex`, `aria-selected` or key handling.
- `app.js:1658-1672`: the host gets `click` and `contextmenu` listeners only.
- Measured: Tab never lands on a row. Only the scroll container takes focus,
  and axe flags it as `scrollable-region-focusable`.

The side-view rows already use `<button class="chat-item …">` (`app.js:1316`, `1353`,
`1376`), which is the obvious fix.

**A2 (medium): ARIA roles on the wrong elements.** `<nav role="listbox">`
(`index.html:54`) and `<footer role="toolbar">` (`index.html:55`) both trip axe
`aria-allowed-role`. A listbox also implies single-select arrow-key navigation,
which the list doesn't implement. The `option` sits inside a generic custom-element
host. Recommendation: `<ul>`/`<li>` with a `<button>` or `<a>` per row (a list of
links), `aria-current="true"` on the open chat, and a plain `<div role="toolbar">`
or no role for the bar.

**A3 (high): the chat header is click-only.** The `<velta-chat-head>` host gets
`click` → `showChatInfo` (`app.js:1910`, `app.js:1971`), but has no role, tabindex or
key handler. The chat name is a `div` (`components.js:407`), not a heading. The
chat-info sheet (mute, members, block, …) can't be reached by keyboard.

**A4 (high): video playback has no keyboard access and no name.**
`<velta-video>` listens for `click` on the host (`components.js:163-179`). The
play affordance is `<span class="velta-video-play">` (`components.js:257`).
`ariaLabel()` ("Play <name>", `components.js:239-241`) is defined but never
rendered.

**A5 (high): attachment cards are `div role="button"` with no focus or key
support.** See `chat-view.js:1435`, `1456`, `1466` (download), `1475` (webxdc) and
`1482` (file). None has `tabindex="0"` or an Enter/Space handler. `.msg-webxdc`
(`1475-1478`) also nests a real `<button class="webxdc-start">`, which axe flags as
serious `nested-interactive`.

**A6 (high): message images are click-only and have no text alternative.**
`<img data-src="image" alt="">` (`chat-view.js:1432`) is the lightbox trigger
(`chat-view.js:1715-1745`). It isn't focusable, and its empty alt hides the photo
completely. A failed-image placeholder is announced, but a working photo isn't.

**A7 (high): clickable avatars.**
- `<velta-avatar data-act="profile" style="cursor:pointer">` in the drawer
  head (`ui.js:531`).
- Group sender avatars open the profile (`chat-view.js:1558-1565`).

Both render `aria-hidden="true"` content (`components.js:105-120`), so they have no
name, no role and no focus.

**A8 (high): message actions depend on the pointer.** Copy, forward, delete,
react, pin, info and select are opened by `contextmenu` or long-press on a
non-focusable `div.msg-row` (`chat-view.js:1366`, `1786-1795`, `1863`). The context
menu (`ui.js:28-55`) has `<button>` items, but:
- no `role="menu"` / `menuitem`;
- focus doesn't move into it on open, and there are no arrow keys or Home/End;
- focus isn't returned on close.

Only the hover "Reply" pill (`chat-view.js:1572-1587`) is a focusable button.

**A9 (medium): other clickable `div`/`span` elements.**
- Reaction chips `<span class="reaction-chip" data-react>` (`chat-view.js:51-55`,
  handled at `1886`).
- Quote jump `<div class="msg-quote" data-quote>` (`1393`, `1888`).
- Pinned-tray items `<div class="pin-tray-item">` (`606-625`).
- P2P peer rows `<div class="p2p-row">` (`p2p.js:244`, `271-297`).

**A10 (high): modals have no dialog semantics or focus management.**
`showModal()` (`ui.js:99-152`) builds `div.pop-overlay > div.modal` with:
- no `role="dialog"`, `aria-modal` or `aria-labelledby` (the title is a
  `div.modal-title`, `ui.js:115`);
- no initial focus (measured: `<body>`; individual callers `setTimeout(focus)`
  an input, e.g. `app.js:2570`, `2849`);
- no focus trap and no focus return;
- no `inert` on the background.

Esc works only through the global handler that boot registers
(`app.js:4763-4764`). There are about 35 call sites (`app.js`, `p2p.js`,
`invites.js`, `qr-scan.js`, `chat-view.js`, `ui.js`).

**A11 (high, quick win): the modal close button has no accessible name.**
`close.className = "icon-btn"; close.innerHTML = CLOSE_SVG` (`ui.js:116-118`)
has no `aria-label` or `title`. axe flags it as *critical* `button-name`.

**A12 (high): the closed drawer is still focusable.** `.drawer` is closed with
`transform: translateX(-100%); pointer-events: none` (`main.css:1494-1510`). That
removes it visually but not from the tab order: the measured walk took 19 Tab
stops inside the invisible drawer. Opening it (`ui.js:788-794`) doesn't move
focus or update `#bar-menu`, which has no `aria-expanded`/`aria-controls`
(`index.html:71`). The drawer is also a bare `div` appended to `<body>`, outside
any landmark (axe `region`).

**A13 (high): no live region for chat activity.** `#history` (`index.html:119`)
is a plain `div`. Repo-wide, `aria-live` has zero uses and `role="log"`/`"feed"`
has none. Incoming messages, typing state (`components.js:376`) and
delivery/failed transitions aren't announced. The virtual scroller also mounts
and unmounts rows while scrolling, so the fix shouldn't make `#history` itself a
live region. A separate visually-hidden announcer driven by the incoming-message
path is the right approach (plan, phase 2).

**A14 (high): toasts and errors aren't announced.** `#toasts`
(`index.html:182`) has no `role="status"`/`aria-live`, so `toast()`/`errToast()`
(`ui.js:166-248`) are silent. The boot error banner `#boot-error`
(`index.html:27-31`) isn't `role="alert"` either.

**A15 (high): the incoming call overlay is inaccessible.** `#call-overlay`
(`calls.js:280-310`) is a plain `div`. It needs:
- `role="alertdialog"` plus a label;
- focus on Accept when ringing;
- a live `.call-status`.

The Mute toggle swaps its text but has no `aria-pressed` (`calls.js:291`).

**A16 (medium): status icons have no text alternative.**
- Delivery ticks (`components.js:278-298`, used by the chat list at `338` and
  message meta at `chat-view.js:1536`) are bare SVGs. Sent, delivered, read,
  pending and failed all read as nothing.
- Pin, mute, open-lock and wifi badges (`components.js:268-277`) are unlabelled
  too.
- The unread badge reads only as a number (`components.js:334`).

**A17 (medium): tab and toggle state isn't exposed.**
- `role="tab"` buttons have no `aria-selected`, `aria-controls` or tabpanel, and
  their state is only `.active` (`app.js:1407-1409`, `2948-2955`, `3103`).
- Category chips (`index.html:46-53`, `app.js:1550`) and bottom-bar view buttons
  (`app.js:1268`) have no `aria-pressed`/`aria-current`.

**A18 (medium): iframes have no `title`.** Webxdc (`webxdc-manager.js:219`),
the HTML mail/attachment viewer (`chat-view.js:2970`) and the in-app browser
(`inapp-browser.js:89`).

**A19 (medium): onboarding form and progress.** The splash relay input is named
only by its placeholder (`app.js:3863`). The setup steps list `ul.ob-steps`
(`app.js:3868`, `addStep` `3892-3899`; same pattern at `4315`, `4397`) has no
live region, so progress and failure aren't announced.

**A20 (medium): lightboxes aren't dialogs.** Both lightboxes (`ui.js:1045-1174`)
are plain overlays with no `role="dialog"` and no focus move. The image uses
`alt=""` even though the caption or filename is passed in (`ui.js:1053-1057`).

**A21 (medium): zoom is disabled.**
`<meta name="viewport" … user-scalable=no>` (`index.html:5`) trips axe
`meta-viewport` (WCAG 1.4.4). The in-app Interface scale option (`ui-scale.js`,
`ui.js:460-484`) mitigates this, but pinch-zoom is the expected platform tool.
Check Android WebView behaviour before changing it.

**A22 (medium): color contrast.** axe flagged `color-contrast` on 11–15 nodes in
the light theme (category chips first). Also check the dark and brutal themes.

**A23 (medium): no heading or landmark structure.**
- There's no `<h1>` in the app shell (axe `page-has-heading-one`; the splash
  has one).
- The chat name, modal titles (`ui.js:115`) and drawer sections (`ui.js:548`)
  are `div`s.
- The drawer, modals, overlays and toasts are appended outside landmarks (axe
  `region`, 13–21 nodes).

**A24 (low): times aren't `<time datetime>`.** See the list time
(`components.js:352`), message meta time (`chat-view.js:1549`) and day chips
(`chat-view.js:1374`).

**A25 (medium): sticker tiles are nameless buttons.**
`<button class="sticker-tile"><img alt=""></button>` (`ui.js:80-86`).

**A26 (low): the search button's name doesn't follow its state.**
`syncHeaderButtons()` flips `title` to "Close search" but leaves
`aria-label="Search chats"` (`app.js:1281-1289`, `index.html:37`).

**A27 (low): selection mode.**
- Action buttons are named only by `title` (`index.html:108-113`).
- `#sel-count` isn't live (`index.html:106`).
- The per-row `div.msg-checkbox` has no `role="checkbox"`/`aria-checked`
  (`chat-view.js:1377`).
- Selected state lives in the `.selected` class only (`chat-view.js:1370`).

**A28 (low): relay status and the call mute button.** `#relay-line`
`role="status"` (`index.html:43`) carries no text; JS only updates its
`aria-label` (`app.js:751-752`), which many screen readers don't announce from a
status region. The call mute button has no `aria-pressed` (`calls.js:291`).

**A29 (low): focus visibility.** `main.css` has no `:focus-visible` rules. The
composer textarea sets `outline: 0` (`main.css:1087`), and `.text-field` relies on
a border-color change (`main.css:1446-1449`). Buttons keep the UA ring, which is
easy to miss on the brutal and light themes.

**A30 (low): the fingerprint identity tile has `role="img"` but no name.**
`buildAvatarSvg()` emits `<svg … role="img">` with no `<title>` or `aria-label`
(`avatar.js:202`). The chat-info modal renders the captioned 168 px variant
(`app.js:2612`), and axe flags it as serious `svg-img-alt`. Rated low because
the fingerprint text sits nearby, but it should be labelled ("Key fingerprint
identity tile").

### B. Progressive rendering

**B1 (high for the PWA, low for Tauri/Android): the chat list is empty until
boot finishes.**
- The static shell paints at FCP. `#chat-list` stays empty, with no skeleton and
  no `aria-busy`, until `app.js` loads its 32-file module graph, starts the
  core, runs `getAccount` and the first `renderChatList()`.
- Measured under slow 4G: FCP 1.0 s → first row 6.3 s.
- On mobile the no-JS paint shows no text at all.
- With the Architecture C wasm core (~4.4 MiB brotli plus instantiate and core
  startup) the gap gets longer.

`renderChatList()` already removes non-row children (`app.js:1580`), so a
static skeleton in `index.html` would be replaced automatically. Tauri desktop
and Android read from local disk, where the gap is about 0.3 s, so the gain
there is small.

**B2 (medium): the theme is applied late.** `applyTheme()` runs from the
`app.js` module (`app.js:866-876`) after the whole graph has loaded, while CSS
defaults to dark. Users with a light, brutal or auto-light theme get a dark →
light flash, and the no-JS paint is always dark. `ui-scale.js` (`index.html:19`)
already shows the CSP-safe pre-paint pattern. Theme belongs there (or in a
sibling script), together with the `theme-color` meta.

**B3 (medium): custom elements can't be pre-rendered.** None of the four elements
has `:not([hydrated])`/`:not(:defined)` CSS. `velta-chat-item { display:block }`
(`main.css:1184`) has no intrinsic height, so a row present in HTML before
`define()` would collapse and then shift. Ghost rows reserve `height: 68px`
(`main.css:1202`; note that `AGENTS.md` §7.2 says 66px). This is acceptable today
because JS creates every instance, but it blocks the phase-1 skeleton and any
future static or SSR rows.

**B4 (medium): the splash and onboarding are JS-only and late.**
`showSplash()` builds the welcome screen in JS (`app.js:3843-3880`). It shows
only after `getAccount` succeeds or fails, and that path retries up to 3× with a
15 s ceiling plus 3 s pauses (`app.js:4495-4510`). A first-run PWA user sees a
blank shell meanwhile, with no "Starting Velta…" status.

**B5 (low): chat-head placeholder.** `#chat-head-info` (`index.html:90`) is
empty until `<velta-chat-head>` is created on open. This causes a small shift; total
measured CLS is 0.028, within the "good" range.

**B6 (low): empty states are JS-built with inline styles.** See `app.js:1614-1621`
and `side-view-empty` (`app.js:1312`). A `<template>` or CSS class in the static
shell would avoid both.

*Positive:* all component CSS lives in the page stylesheet. There are no
constructed stylesheets, no shadow roots and no JS-injected component styles.
Two `<style>` blocks are injected: the theme/font block for the sandboxed
HTML-mail iframe, which is legitimate, and the in-app browser's own styles
(`inapp-browser.js:10-40`), which should move to `main.css` (correction
2026-10-06). The shell markup for the header, bottom bar,
composer and selection bar is static.

### C. CSS semantics

**C1 (medium): state is held in ad-hoc classes where ARIA or data attributes
fit.**

| State | Current class | File:line | Better carrier |
|---|---|---|---|
| Open chat in list | `.active` on the inner div | `components.js:347` (duplicates host `[active]`) | `aria-current="true"` |
| Category / tab selection | `.active` | `app.js:1550`, `2955`, `3103` | `aria-pressed` / `aria-selected` |
| Bottom-bar view | `.active` | `app.js:1268`, `1292` | `aria-current="page"` |
| Drawer open | `.open` | `ui.js:789` | `aria-expanded` on trigger, `[data-open]`/`inert` on drawer |
| Message selection | `.selectable` / `.selected` | `chat-view.js:1369-1370` | `[data-selecting]` on list, `aria-checked`/`aria-selected` on row |
| Video playing | `.playing` | `components.js:202-203` | host `[playing]` / `:state(playing)` |
| Avatar image loaded | `.loaded` | `components.js:80` | `[data-loaded]` |
| Image revealed | `.ready` | `chat-view.js:1697` | `[data-ready]` (already set alongside) |
| Online status | `.online` | `components.js:408` | `[data-presence="online"]` |
| Update available | `.update` | `ui.js:339` | `[data-update]` |

Good patterns already in the codebase to copy: `.relay-seg[data-state]` and
`[data-sending]` (`main.css:129-141`), `.chat-load-bar[data-on]` (`main.css:276`)
and `html[data-theme]`.

**C2 (medium): hard-coded styles in JS.** There are about 177 inline-style sites
(`style="…"`, `.style.x =`, `cssText`): `chat-view.js` 74, `app.js` 40, `ui.js` 19,
`p2p.js` 19, `components.js` 11, `invites.js` 7, `qr-scan.js` 6. Examples:
- Avatar `width/height/font-size/background` computed in `render()`
  (`components.js:92-93`) instead of `--size`/`--avatar-color`.
- SVG size styles in constants (`components.js:8-9`, `138-139`).
- `ok.style.color = "var(--danger)"` (`ui.js:257`, `280`) instead of a
  `.btn-danger`/`data-variant`.
- "Show Full Message…" button styles (`chat-view.js:1517`).
- P2P hint and layout styles (`p2p.js:261-266`).

Dynamic geometry (`chat-view.js:1429`, `1452`, `1681-1689`, `components.js:229-232`)
is legitimate, but it would be cleaner as custom properties (`--w`, `--ar`) read by
CSS.

**C3 (low): `hidden` and `style.display` are mixed.** `overlay.style.display`
(`ui.js:649`, `790`, `799`), `removeBtn.style.display` (`ui.js:899`, `914`) and
`iconImg.style.display = "block"` (`chat-view.js:1633`) all sit next to the
`hidden` + `[hidden]{display:none}` convention in `AGENTS.md` §6.2.

**C4 (low): `:state()` and ElementInternals are unused.** For host-level states of
the custom elements (video playing/failed, avatar loaded/failed), reflected host
attributes (which Elena does natively) or `:state()` custom states would beat
classes on inner nodes. Support: Chromium (Android WebView, WebView2) 125+,
Safari/WKWebView 17.4+. Prefer attributes for older macOS WebKit.

*Consistent:* light DOM everywhere, a single stylesheet, and namespaced class
prefixes (`velta-avatar-*`, `ci-*`, `cht-*`). Elena's `@scope` advice isn't needed
at this size.

### D. Elena usage

**D1 (medium): Elena's progressive features are unused.** See §4. Nothing reads
the `hydrated` attribute, no component wraps static markup, and every instance is
created by JS. As a result Elena gives Velta reactive props + templating, but none
of the "HTML/CSS first" behaviour it was chosen for (`components.js:1`: "Progressive
Web Components built on Elena").

**D2 (medium): the self-heal code depends on minified private fields.**
`delete this.D; delete this.F; this.N?.()` gated on `this.h`
(`components.js:38-42`, `158-162`) relies on minifier-chosen names in
`app/vendor/elena.js`. Any re-vendor can rename them and silently disable the
workaround, which brings back blank avatars and videos. It's already ledgered as
VENDORISSUES #8; the new point is that the phase-2 a11y work adds more nested
elements and makes this worse.

**D3 (medium): recreating instead of updating would destroy focus.** Because of
E2, rows and heads are replaced whenever their data changes (`app.js:1557-1566`,
`1594-1600`, `1904-1906`, plus head swaps at `1927`, `2001`, `2070`, `2089`, `2499`). Once rows become focusable (A1), every
`chatlist-item-changed` for the focused row (a new message, typing, a tick) would
drop keyboard focus to `<body>`. Phase 2 has to either keep a stable focusable
wrapper outside the Elena element or restore focus after replacement.

**D4 (low): state computed in render instead of on the host.** `active` is a
string prop, and the `.active` class is derived inside `render()` from
`getAttribute("active")` (`components.js:347`). CSS could select
`velta-chat-item[active]` directly. The constructor prop-default workaround
(`components.js:26-29`, `312-321`) is noise that would go away upstream
(VENDORISSUES #3/#9).

---

## 6. Quick wins (≤ 0.5 day each, no architecture change)

1. Add `aria-label="Close"` and `title` to the modal close button (`ui.js:116-118`). Fixes A11.
2. `#toasts` → `role="status" aria-live="polite"`; danger toasts → a sibling
   `role="alert"` container. `#boot-error` → `role="alert"` (A14).
3. Add `inert` to the drawer while closed and remove it on open. Add
   `aria-expanded`/`aria-controls` to `#bar-menu` and focus the first drawer item
   on open (A12).
4. Add `title` to the three iframes (A18).
5. Add `role="dialog" aria-modal="true" aria-labelledby` to `showModal()`, move
   focus to the first focusable element (or the dialog) and restore it on close.
   This is the bare minimum before the `<dialog>` migration (A10).
6. Render `ariaLabel()` in `<velta-video>` and make the play overlay a
   `<button type="button">` (A4).
7. `div role="button"` cards → `<button type="button">`. In webxdc cards, drop
   the outer role and keep the inner Start button plus a name button (A5).
8. Give message images an alt (`m.text` excerpt or "Photo from <sender>") and
   wrap them in a `<button>` that opens the lightbox. Pass the caption as the
   lightbox alt (A6, A20).
9. Give sticker tiles `aria-label` (collection name + index) (A25). Keep
   `aria-label` in sync on `#btn-search` (A26).
10. Label the splash relay input (`<label>` or `aria-label`) and make
    `ul.ob-steps` `aria-live="polite"` (A19).
11. Move theme application into the parser-blocking pre-paint script next to
    `ui-scale.js` (B2).
12. Add a static skeleton (6–8 CSS-only rows plus `aria-busy="true"`) inside
    `#chat-list`, cleared by the existing `renderChatList()` path (B1). This one
    is about 1 day, so it's listed in phase 1.
