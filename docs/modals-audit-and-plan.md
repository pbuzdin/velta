# Modals, overlays and popups: audit + native `<dialog>` plan

Date: 2026-10-06. Base commit: `6c108a4` (web components audit + plan).
Scope: every modal, overlay and popup in `app/` (the shared frontend of the
Tauri desktop, Tauri Android and PWA shells). Docs only. No app code was
changed for this report.

This doc **supersedes** two items in `docs/web-components-plan.md`:
- Phase 0 item 0.4 (interim `role="dialog"` semantics on the `<div>` modal)
- Phase 2 item 2.4 ("Dialogs on native `<dialog>`")

Do the conversion plan in Part 2 instead. Phase M1 replaces 0.1 (close-button
name) and 0.4. Ship those two only as stopgaps if the conversion slips by more
than a release.

Related: `docs/web-components-audit.md` (findings A10, A11, A12, A14, A15, A20)
and `docs/native-elements.md` (popover and other native-element candidates).

---

## Summary

- **16 overlay components and 40+ call sites. No native `alert()`, `confirm()` or
  `prompt()` anywhere in app code.** All modal UI goes through one helper,
  `showModal()` (`app/js/ui.js:99-152`), which has **34 call sites** in 7 files.
  On top of it sit `confirmModal` (26 callers), `confirmDeleteMessagesModal`,
  `askText` (the `prompt()` replacement), `pickContactModal`, `showProgressModal`
  and the QR `acquireCode` sheet. The other overlays are hand-rolled: a context
  menu helper (6 call sites), 4 anchored popups, the drawer, 6 full-screen
  overlays (image lightbox, video lightbox, webxdc, HTML viewer, in-app browser,
  call screen), 2 non-modal screens (splash, boot error) and the toast stack.
- **Today none of them is a real dialog.** There is no role, no accessible
  name, no initial focus, no focus trap and no focus return. Tab walks straight
  into the dimmed page behind. Only the lightboxes handle Esc themselves. The
  global Esc handler (`app.js:4763-4765`) closes `#popups` and the drawer, but
  not the webxdc, HTML-viewer, in-app-browser or call overlays.
- **Android back works and must keep working.** Each overlay pushes one
  `history` entry (`{velta:"modal"|"lightbox"|"webxdc"|"html-view"|"inapp-browser"}`),
  and `popstate` tears it down (AGENTS.md "Overlay/BACK conventions"). The native
  `<dialog>` migration keeps that contract unchanged. The WebView never sees a
  CloseWatcher back gesture, because `MainActivity` routes BACK to
  `webView.goBack()`.
- **Stacking is ad hoc.** z-indexes go 40 (splash), 50 (modal overlay),
  55 (drawer), 60 (menu), 80 (toasts), 850 (webxdc, HTML viewer), 860 (quote
  chip), 900 (call, in-app browser), 920 (LC queue), 930 (stickers),
  1000 (boot error) and 2000 (lightbox). Two consequences are user-visible:
  the webxdc "Send to chat" confirm renders *under* the webxdc app (finding M1),
  and an incoming call is hidden under an open lightbox (M2). Toasts sit under
  every full-screen overlay (M3).
- **Platform floor.** Android minSdk 24 (Android 7.0, WebView capped at
  Chromium 119). Windows 10/11 with evergreen WebView2. macOS 10.15+ with system
  WKWebView (Safari 15.6 on Catalina). Every target supports `<dialog>`,
  `::backdrop`, `inert` and `:has()`. The gaps are `closedby`
  (Chromium 134+, no Safari), popover (missing on macOS 10.15/11), anchor
  positioning (Chromium 125+ / Safari 26) and `@starting-style` /
  `allow-discrete` (fine on Android 7's Chromium 119, missing on macOS 10.15/11).
  Each gap has a fallback in the plan.
- **Plan: 7 phases, 11.5 days.** The helper is rewritten on `<dialog>` with the
  same API, so the 34 call sites stay untouched apart from opt-ins.

---

## Part 1: Audit

### 1.1 Method

- Static read of `app/js/*.js`, `app/index.html` and `app/css/main.css` at
  `6c108a4`, plus `velta-app/src-tauri` (Tauri config, Android Gradle and
  `MainActivity.kt`).
- `rg` for `showModal(`, `confirmModal(`, `showContextMenu(`, `pushState`,
  `popstate`, `keydown`, `z-index`, `alert(`/`confirm(`/`prompt(`.
- Behaviour from the code paths, cross-checked against AGENTS.md §11
  (overlay/BACK conventions, `modalHistorySettled`) and
  `docs/agents/android-shell.md`.
- The findings marked *likely* come from reading the code and were not
  reproduced on a device. Each one names the step that would confirm it.

### 1.2 Counts by type

| Type | Components | Call sites | Where |
|---|---|---|---|
| Modal dialog helper (`showModal`) | 1 | 34 (`app.js` 17, `p2p.js` 8, `ui.js` 5, `chat-view.js` 2, `invites.js` 1, `qr-scan.js` 1) | `ui.js:99-152` |
| ↳ confirm wrappers (`confirmModal`, `confirmDeleteMessagesModal`) | 2 (counted in the 34) | 26 + 1 callers | `ui.js:250-288` |
| ↳ prompt wrappers (`askText`, `askGroupName`, `promptName`, edit name) | 4 (counted in the 34) | 2 + 1 + 1 + 1 | `app.js:3002-3050`, `p2p.js:186-200`, `app.js:2568` |
| ↳ pickers (`pickContactModal`, forward, QR `acquireCode`) | 3 (counted in the 34) | 3 + 1 + 5 | `app.js:2886,3508`, `qr-scan.js:110` |
| ↳ progress modals | 5 (counted in the 34) | | `app.js:3743,4316,4398`, `p2p.js:388`, splash steps |
| Context / long-press menu (`showContextMenu`) | 1 | 6 | `ui.js:28-55` |
| Anchored popups | 4: sticker picker, drawer account popover, LC queue popover, selection quote chip | 1 each | `ui.js:57-97`, `ui.js:537,660`, `app.js:983-1012`, `chat-view.js:2499` |
| Drawer (side sheet) | 1 | 1 | `ui.js:524-878` |
| Full-screen overlays | 6: image lightbox, video lightbox, webxdc app, HTML viewer, in-app browser, call screen | 4 + 1 + 1 + 1 + 1 + 1 | `ui.js:1045,1142`, `webxdc-manager.js:215`, `chat-view.js:2954`, `inapp-browser.js:42`, `calls.js:280` |
| Non-modal screens | 2: onboarding splash, boot-error banner | 1 each | `app.js:3843+`, `index.html:27-31` |
| Toast stack | 1 | 125 `toast()` + 62 `errToast()` | `ui.js:155-248`, `app.js:25` |
| Native `alert`/`confirm`/`prompt` | 0 in app code | 0 | webxdc frames are sandboxed with `allow-modals` (`webxdc-manager.js:226`), so *apps* can raise native dialogs. That is intended. |

There is no emoji picker. Quick reactions are a row in the message context menu
(`chat-view.js:2277`). The "attachment picker" is the attach context menu
(`chat-view.js:2589-2620`) followed by the OS file dialog via the Tauri dialog
plugin (`chat-view.js:2828`). The QR "My code / Scan" screen is a sidebar tab
(`app.js:1408`), not an overlay. Its paste/camera step is the `acquireCode`
modal. The selection bars (`index.html:102+`, in-bubble `msg-select-bar`
at `chat-view.js:2108-2155`) are inline toolbars, not overlays.

### 1.3 The `showModal()` helper (common behaviour of all 34 sites)

| Aspect | Today (`ui.js:99-152`, `main.css:1241-1363`) |
|---|---|
| Markup | `#popups > div.pop-overlay > div.modal[.modal-compact] > .modal-head(.modal-title + button.icon-btn) + .modal-body + .modal-foot?` |
| Open | `modalReplacing = true; closeAllPopups()` closes whatever is open (modal, menu, drawer). Then the overlay is appended and `{velta:"modal"}` is pushed unless the current state already is a modal. |
| Close | Returned `close()` → `doClose` (idempotent via `closed`). It removes the popstate listener, calls `history.back()` if the state is `modal` and we aren't replacing, removes the overlay, then calls `onClose()`. |
| Esc | Only through the global handler `app.js:4763-4765` → `closeAllPopups()`. It's registered at the very end of boot, so modals opened during onboarding/splash ignore Esc until boot completes. |
| Android back | Pops the `modal` entry → `onModalPop` → `doClose`. This works. The listener reacts to **any** popstate, not only to its own entry. |
| Backdrop | `pointerdown` on the overlay itself closes it (`ui.js:147`). On phones the non-compact sheet stops above the list bar, so a tap on the dimmed bar dismisses it (`main.css:1342`). |
| Focus | None. No initial focus (6 callers focus an input themselves), no trap (Tab reaches the page behind) and no return (focus drops to `<body>`). |
| Accessible name | None. No `role`, no `aria-modal` and no `aria-labelledby`. The close button is an unlabeled SVG (`ui.js:116-118`). The chat-info sheet passes `title: ""` (`app.js:2306`). |
| Stacking | **None. A new modal replaces the open one.** Sub-editors (disappearing messages `app.js:2156`, mute `2208`, edit name `2568`, edit profile) replace the chat-info sheet and reopen it from `onClose` after `modalHistorySettled()` (`app.js:2094-2105`). A confirm opened from a sheet closes the sheet. |
| Scroll lock | None needed so far: `html, body { height:100%; overscroll-behavior:none }` (`main.css:58`), and the page doesn't scroll, only inner panes do. Wheel/touch scroll over the scrim still scrolls the chat or list pane underneath. |
| Animation | CSS keyframes on insert: `fadeIn` on the overlay, `modalIn` on the card, `sheetIn` for phone sheets. No exit animation (`remove()` is instant). Not covered by `prefers-reduced-motion`. |
| Return value | The helper returns `{ close, modal }`. Wrappers build Promises by hand: `finish(result); close();` ("settle before close", AGENTS.md §11), and `onClose` settles the null/false case. |
| Layout | Phone ≤600px: non-compact = full screen (`main.css:1326-1346`). Desktop ≥601px: non-compact fills the chat-list pane (`main.css:1354-1363`). Compact = floating card. Overlay z-index 50. |
| Tests | `tests/chat-account-isolation.test.mjs:476-495` pins the settle/`onClose`-once contract against a stub DOM (no `HTMLDialogElement`). `tests/app-account-isolation.test.mjs:146,379-407` stubs `closeAllPopups` and counts `#popups` children. |

### 1.4 Inventory: `showModal` call sites

Columns: **C** = compact card; **Ret** = what the flow resolves; **Focus** =
initial focus today; **Target** = conversion target (all are `dialog.showModal()`
via the helper unless noted). "Replace" means the site relies on
replace-not-stack today.

| # | file:line | Title / purpose | C | Ret | Focus | Notes | Target / opt-ins |
|---|---|---|---|---|---|---|---|
| 1 | `ui.js:259` | `confirmModal` (generic confirm) | ✓ | `Promise<boolean>` | none | 26 callers; danger colour is an inline style | `<form method=dialog>`, `returnValue` `ok`/`""`; `role="alertdialog"` when `danger`; initial focus on **Cancel** for destructive actions; `stack:true` |
| 2 | `ui.js:286` | `confirmDeleteMessagesModal` | | `"me"\|"everyone"\|null` | none | | form, `returnValue`; `alertdialog`; `stack:true` |
| 3 | `ui.js:946` | `showEditProfile` | | profile or null | input `focus()+select()` at 948 (raises the keyboard) | name input has `aria-label`; avatar pick | form; `autofocus` only on desktop |
| 4 | `ui.js:982` | `showInvite` | | – | none | copy link button | default |
| 5 | `ui.js:1010` | `showAbout` | | – | none | | default |
| 6 | `app.js:2156` | Disappearing messages | | – | none | radios (good); replaces chat info, reopens it in `onClose` | `stack:true` over chat info (drops the reopen dance) |
| 7 | `app.js:2208` | Mute notifications | | – | none | rows are clickable `div.eph-row` (`app.js:2191`) | `stack:true`; rows → buttons/radios |
| 8 | `app.js:2306` | Chat info sheet | | – | none | `title:""` → no name; `<details>` sections | `aria-label` = chat name |
| 9 | `app.js:2568` | Edit name (from chat info) | | – | input | replaces chat info | form, `stack:true` |
| 10 | `app.js:2848` | Search in chat | | – | input (`setTimeout 50`) | results are `button.ctx-item` | `<search>` + `type=search` (see native doc) |
| 11 | `app.js:2886` | `pickContactModal` | | contacts or null | none | multi-select; 3 callers | form |
| 12 | `app.js:3020` | `askText` (prompt replacement) | | string or null | input | Enter via keydown | form `method=dialog`, `required`, Enter = submit |
| 13 | `app.js:3044` | `askGroupName` | | string or null | input | | same as 12 |
| 14 | `app.js:3240` | Profile management | | – | none | `onClose` → cleanupTransfer | default |
| 15 | `app.js:3477` | `chooseRelayOrNewProfile` | | choice | none | | form |
| 16 | `app.js:3508` | Forward to… | | – | none | | default |
| 17 | `app.js:3743` | `showProgressModal` ("Joining chat") | | – | none | spinner; **user can close it mid-handshake** | `closable:false` (or "Continue in background") |
| 18 | `app.js:3813` | Join chat via invite link | | – | none | `#join-input` URL field | form, `inputmode=url` |
| 19 | `app.js:4059` | Welcome to Velta (splash name) | ✓ | name | input | opened during boot, before the global Esc exists | form |
| 20 | `app.js:4190` | Relays | | – | none | | default |
| 21 | `app.js:4316` | Adding relay (steps) | | – | none | progress; closable mid-flow | `closable:false` |
| 22 | `app.js:4398` | Receiving profile (2nd device) | | – | none | progress; closable mid-transfer | `closable:false` + explicit Cancel |
| 23 | `invites.js:359` | Invite link domains | | – | none | host input, manual validation | form + `pattern` |
| 24 | `qr-scan.js:110` | `acquireCode` (paste / camera) | | code or null | none | camera stream stopped in `finish` | default; `onClose` must stop the camera (already does) |
| 25 | `p2p.js:111` | Pairing request | | `Promise<boolean>` | none | `modal.classList.add("pair-request")` | form; `alertdialog` |
| 26 | `p2p.js:194` | Welcome to Local chat (device name) | | name | input | | form |
| 27 | `p2p.js:209` | Local chat hub | | – | input | | default |
| 28 | `p2p.js:334` | My invite code | | – | none | | default |
| 29 | `p2p.js:388` | Pairing (progress bar div) | | – | none | | `closable:false`; `<progress>` |
| 30 | `p2p.js:468` | New local group | | – | none | | form |
| 31 | `p2p.js:538` | Add to group | | – | none | | form |
| 32 | `p2p.js:569` | Local chat window | | – | none | `modal.style.width = min(640px,96vw)` | default |
| 33 | `chat-view.js:205` | Crop image | | blob or null | none | pointer-drag handles | default |
| 34 | `chat-view.js:2311` | Message info | | – | none | retry buttons via `info.modal` | default |

API surface that callers touch: `close()`, `modal` (used for
`classList`, `style` and `querySelectorAll` at `p2p.js:112,575` and
`chat-view.js:2322`). The rewrite must keep `modal` pointing at the card
element.

### 1.5 Inventory: everything else

| Overlay | file:line | Open / close | Focus | Esc | Android back | Backdrop | Stacking / z | Scroll lock | Animation | Target |
|---|---|---|---|---|---|---|---|---|---|---|
| Context menu (6 sites: chat list `app.js:1762`, old-msg submenu `1782`, chat head `2741`, message `chat-view.js:2269`, reactions `2277`, attach `2606`) | `ui.js:28-55` | `closeAllPopups()` then append; item click → close + action | none; not `role=menu`; no arrow keys | global handler (after boot) | **no entry: back exits the chat/app instead of closing the menu** | transparent overlay `pointerdown`/`contextmenu` | z 60; replaces any modal | n/a | `menuIn` | `popover="auto"` + menu pattern; overlay fallback without popover |
| Sticker picker | `ui.js:57-97` | as above; tile click picks | none | global | no entry | transparent overlay | z 930 | n/a | none | `popover="auto"` |
| Drawer | `ui.js:524-878`, CSS `main.css:1494-1510` | `.open` class + `.drawer-overlay` `display`; capture-phase document `pointerdown` closes | none; closed drawer stays tabbable (audit A12) | global | **no entry** | `.drawer-overlay` stops above list bar (`main.css:1252`) | z 55 | n/a | `translateX` transition | stay custom + `inert` while closed (plan 0.3). Optionally modal `<dialog>` later (see M5.4) |
| Drawer account popover | `ui.js:537,660` | `hidden` toggle | none | global (closes the whole drawer) | no entry | document pointerdown | z 30 inside drawer | n/a | none | `popover="auto"` |
| LC queue popover | `app.js:983-1012` | `toggleLcQueuePop`, manual placement under `#lc-queue-chip` | none | none | no entry | document pointerdown | z 920 | n/a | none | `popover="auto"` + `popovertarget` |
| Selection quote chip | `chat-view.js:2499` | appears on text selection; inline `left/top` | none | none | no | n/a | z 860 | n/a | none | stay custom (could be `popover="manual"`) |
| Image lightbox | `ui.js:1045-1140` | `openImageLightbox`; tap/✕/Esc → `teardownLightbox(true)` | none | own capture-phase keydown (`ui.js:1074`) | `{velta:"lightbox"}`; popstate tears down on **any** pop (`ui.js:1043`) | tap on stage closes | z 2000 (above modals, call, toasts) | n/a | none | `<dialog>` `showModal()`, full-bleed |
| Video lightbox | `ui.js:1142-1174` | same | none | own keydown (`ui.js:1163`) | same | | z 2000 | | none | same |
| webxdc app | `webxdc-manager.js:215-290` | ✕ `closeWebxdc()`; reopen reuses entry | none (iframe not focused) | **none** | `{velta:"webxdc"}` | n/a | z 850 | n/a | none | `<dialog>` `showModal()`, full screen, focus iframe |
| HTML viewer | `chat-view.js:2954-3020` | ✕ → `history.back()`; `popstate` `{once:true}` removes on **any** pop (`chat-view.js:3014`) | none | **none** | `{velta:"html-view"}` | n/a | z 850 | | none | `<dialog>` `showModal()` |
| In-app browser | `inapp-browser.js:42-123` (styles injected at `10-40`) | ✕ / external; `popstate` `{once:true}` on any pop | none | **none** | `{velta:"inapp-browser"}` | n/a | z 900 | | none | `<dialog>` `showModal()`; on Android the native overlay is preferred (`docs/agents/android-shell.md`) |
| Call screen | `calls.js:274-310` | created by `render()`, removed by `hideOverlay()` | **none: Accept/Decline are not focused** | none | **no entry: back closes the chat under a ringing call** | n/a | z 900 (**below lightbox 2000**) | | none | `<dialog role="alertdialog">` `showModal()`, `closable:false`, focus Accept |
| Toast stack | `ui.js:155-248` | `<details class="toast">` in `#toasts`, max 3, auto-dismiss on `animationend` | n/a | n/a | n/a | n/a | z 80 (**below webxdc, call, IAB, lightbox, stickers, LC queue**) | n/a | `toastIn`, `toastTimer` | `#toasts` as `popover="manual"`, re-shown after each top-layer open (M3.4) |
| Onboarding splash | `app.js:3843+`, CSS `main.css:1648` | full-page screen, z 40, below modals | | | | | | | | stay custom (it's a page, not a dialog) |
| Boot-error banner | `index.html:27-31`, `main.css:1831` | pre-app.js safety net | | | | | z 1000 | | | stay custom (must work without modules) |

### 1.6 Findings

Severity follows the earlier audit (High / Medium / Low).

| # | Sev | Finding | Evidence | Fix (phase) |
|---|---|---|---|---|
| M1 | High | **webxdc "Send to chat" confirm is hidden under the app.** The confirm is a z-50 modal, while the webxdc overlay is z 850. The app awaits a promise the user can't see. Android back then pops the `modal` entry and, see M4, may also close the chat. *Likely: verify by calling `webxdc.sendToChat` from any app.* | `webxdc-manager.js:116`, `main.css:1242,2072` | top layer fixes it for free (M1) |
| M2 | High | **Incoming call hidden under an open lightbox.** `#call-overlay` z 900 < `.lightbox` z 2000. The ringtone plays with no visible Accept. | `calls.js:284-287`, `main.css:1786,1870` | call = top-layer `alertdialog` opened last (M5.2) |
| M3 | Medium | **Toasts render under full-screen overlays** (z 80). Errors raised while webxdc, IAB, the call screen or the lightbox is up are invisible. | `main.css:1591` vs 850/900/2000 | `popover="manual"` toasts (M3.4) |
| M4 | Medium | **History collisions between overlays.** The chat's popstate handler closes the chat on any non-`chat` state (`app.js:2047-2049`). A modal stacked on webxdc returns to state `webxdc`, which tears down the chat under the app. The HTML viewer and IAB listeners close on *any* popstate (`chat-view.js:3014`, `inapp-browser.js:99`), so BACK from an IAB opened inside the HTML viewer closes both. *Likely: verify with a link inside an HTML mail on desktop with the JS IAB.* | as cited | central overlay stack with depth-aware popstate (M3.2) |
| M5 | High | **No dialog semantics, no focus management** on any of the 34 modals (audit A10/A11). Tab escapes into the page. Screen readers announce nothing. Focus is lost on close. | `ui.js:99-152` | M1 |
| M6 | Medium | **Esc doesn't close webxdc, HTML viewer, IAB or the call screen,** and doesn't work on modals opened before boot finishes (splash name, onboarding). | `app.js:4763-4765` | `cancel` event per dialog (M1, M5) |
| M7 | Medium | **Context menus, sticker picker, drawer and popovers have no BACK handling.** Android back while a menu is open navigates the chat away and leaves the menu floating until the next tap (the transparent overlay survives in `#popups` until `closeAllPopups`). *Likely: verify on device.* | `ui.js:28-97`, `ui.js:524+` | light-dismiss + menu entry or `closeAllPopups` on popstate (M5.3) |
| M8 | Medium | **Progress modals can be dismissed mid-operation** (Joining chat, Adding relay, Receiving profile, Pairing). The flow continues invisibly, and its later `update()` writes into a detached node. | `app.js:3743,4316,4398`, `p2p.js:388` | `closable:false` option (M2.4) |
| M9 | Medium | **A confirm from a sheet destroys the sheet** (replace-not-stack). For example, a destructive confirm from chat info (`app.js:2363`) closes chat info, and sub-editors need the `modalHistorySettled()` reopen dance with a 300 ms wait. | `app.js:2094-2105,2156,2208,2568` | opt-in stacking (M3) |
| M10 | Low | **Modal animations ignore `prefers-reduced-motion`.** `fadeIn`/`modalIn`/`sheetIn`/`menuIn` aren't in any reduced-motion block. There's no exit animation. | `main.css:1245,1261,1320,1330` | M4 |
| M11 | Low | **Scrolling over the scrim scrolls the pane underneath** (wheel on desktop, touch on the dimmed list bar). | `main.css:1241` | top layer + `inert` removes hit-testing (M1) |
| M12 | Low | **Chat-info sheet has an empty title** → no accessible name once it's a dialog. | `app.js:2306` | `ariaLabel` option (M1) |
| M13 | Low | **The webxdc confirm path uses `allow-modals`.** Native `alert()` in a webxdc app blocks the whole WebView on WebView2. This is intended (matches Delta Chat), but note it for QA. | `webxdc-manager.js:226` | none (doc only) |
| M14 | Low | **The in-app browser injects its own `<style>`.** This corrects the earlier audit's "no JS-injected component styles" claim. | `inapp-browser.js:10-40` | move to `main.css` during M5.5 |
| M15 | Low | **Enter handlers in prompt modals ignore IME composition.** None of the 8 manual `keydown` Enter handlers checks `e.isComposing`, so Enter that commits a CJK/IME composition submits early | `app.js:3023,3048,4055`, `invites.js:368`, `p2p.js:199`, `qr-scan.js:123`, `ui.js:963` | `<form>` submit (M2) |

---

## Part 1b: Platform support

### Minimum targets

| Shell | Engine | Floor | Source |
|---|---|---|---|
| Android | System Android WebView (Chromium, updated via Play) | **minSdk 24 = Android 7.0**; compile/target SDK 36 | `velta-app/src-tauri/gen/android/app/build.gradle.kts:22` |
| | ↳ effective WebView cap by OS | Android 7.x → **Chromium 119** (last for Nougat). Android 8/9 → **138** (139+ needs Android 10). Android 10+ → current stable | Chrome support policy |
| Windows | WebView2 Evergreen (Chromium, auto-updates; `webviewInstallMode: downloadBootstrapper`) | Windows 10/11 → current Chromium | README, `tauri.conf.json` |
| macOS | System WKWebView = the installed Safari's WebKit | **macOS 10.15** → Safari 15.6. 11 → 16.6. 12 → 17.6. 13 → 18.x. 14+ → 26 | README:32 |
| Linux | WebKitGTK | **not a release target** (`release.yml` builds Android, Windows, macOS). Deep-link docs mention Linux, so treat it like macOS 12-era WebKit if someone builds it | `.github/workflows/release.yml` |
| PWA (Architecture C) | Any evergreen browser | Chrome/Edge/Firefox/Safari current. Chrome Android adds CloseWatcher (back closes dialogs) | `docs/research/wasm-core-landing-checklist.md` |

A device without Play Services (AOSP, de-Googled ROMs) can be stuck on the WebView
that shipped with the ROM. `main.css` already needs Chromium 105+ (`:has()` at
`main.css:1342`, `dvh`, `color-mix` at `main.css:189`), so the de-facto floor is
already above minSdk. Recommendation: document **"Android System WebView 111+"**
as the supported floor in AGENTS.md and README, and optionally log/toast the
WebView major version at boot (`navigator.userAgent`) so bug reports carry it.

### Feature matrix

✓ = available at the floor of that shell; ✗ = missing at the floor (version that
adds it in brackets).

| Feature | Chromium | Safari | Android 7 (≤119) | Android 8/9 (≤138) | WebView2 | macOS 10.15 (15.6) | macOS 11 (16.6) | macOS 12 (17.6) | Fallback needed? |
|---|---|---|---|---|---|---|---|---|---|
| `<dialog>`, `showModal()`, `::backdrop`, `cancel`/`close` events | 37 | 15.4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | No (keep a `showModal`-less path only for the node test stub DOM) |
| `<form method="dialog">` / `returnValue` | 37 | 15.4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | No |
| `closedby="any\|closerequest\|none"` | 134 | ✗ (TP only) | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | **Yes**: JS backdrop click + Esc `keydown` guard for `none` |
| `requestClose()` | 134 | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | Yes: call our own `doClose` |
| Popover API (`popover`, `showPopover`, `:popover-open`) | 114 | 17.0 | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | **Yes on macOS 10.15/11**: keep the transparent-overlay path |
| `popovertarget` (declarative) | 114 | 17.0 | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | Same; prefer JS `togglePopover()` with feature check |
| `popover="hint"` | 133 | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | Don't use yet |
| CSS anchor positioning | 125 | 26 | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | **Yes**: keep JS placement (`ui.js:50-53`, `chat-view.js:2589-2620`, `app.js:1005-1010`) |
| `inert` | 102 | 15.5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | No |
| `:has()` | 105 | 15.4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | No (already used) |
| `@starting-style` | 117 | 17.5 | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ (17.5+) | Yes: entry keyframes stay as fallback |
| `transition-behavior: allow-discrete` | 117 | 17.4 | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | Yes: no exit animation there (instant close) |
| `overlay` property transition (keep in top layer while animating out) | 117 | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | Optional; Safari closes instantly |
| CloseWatcher (back gesture closes dialogs) | 120 (Android Chrome) | ✗ | n/a in WebView | n/a | n/a | ✗ | ✗ | ✗ | Don't rely on it. Our history contract handles BACK. Close events from it must still consume our entry (PWA on Chrome Android) |
| Invoker commands (`commandfor`, `command="show-modal"`) | 135 | 26.x | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | Future; JS listeners stay |

**Support gaps that need a fallback**: `closedby` (Android 7, all macOS),
popover (macOS 10.15/11), anchor positioning (Android 7, macOS ≤ 15 without
Safari 26), `@starting-style`/`allow-discrete` (macOS 10.15/11). There are no
gaps for `<dialog>`, `::backdrop`, `inert` or `:has()`.

---

## Part 2: Conversion plan

### 2.1 Design

**Helper contract stays.** `showModal({ title, body, foot, onClose, compact })`
keeps returning `{ close, modal }`. New options are additive and default off:

| Option | Default | Meaning |
|---|---|---|
| `stack` | `false` | Open above the current modal instead of replacing it. `false` keeps today's replace semantics |
| `closable` | `true` | `false` = no ✕, Esc is blocked, the backdrop does nothing, BACK is swallowed (re-push) or turned into an explicit "Cancel operation" confirm |
| `role` | `"dialog"` | `"alertdialog"` for confirms and incoming pairing/calls |
| `ariaLabel` | – | Accessible name when `title` is empty (chat info) |
| `initialFocus` | auto | Element or selector. Auto = `[autofocus]`, else the first non-✕ control on desktop, else the dialog itself (phones, so the keyboard doesn't pop) |
| `form` | `false` | Wrap body+foot in `<form method="dialog">`. The promise wrappers read `dialog.returnValue` |

**DOM.** `#popups > dialog.modal[.modal-compact][aria-labelledby=<id>] > .modal-head(h2.modal-title#id + button.icon-btn[aria-label=Close][title=Close]) + .modal-body + .modal-foot?`
- `modal` (returned) **is** the `<dialog>`, so callers' `classList`/`style`/`querySelectorAll` keep working.
- Stay inside `#popups`, which the node tests count. A `<dialog>` renders in the top layer regardless of its DOM position.
- UA reset in CSS: `dialog.modal { padding:0; border:…; color:inherit; background:var(--bg-sidebar); max-width:none; max-height:none; margin:auto }`, plus `inset:0 auto auto 0; margin:0` for the desktop pane variant and `::backdrop { background: rgba(16,16,16,.45) }`. `.pop-overlay` is no longer used for modals but stays for menus on the popover fallback.

**Open.** `dialog.showModal()` (top layer, everything else `inert`, Esc → close
request). Feature check: `typeof dialog.showModal === "function"`. Without it
(node stub DOM only) fall back to setting the `open` attribute.

**Close paths all funnel into one idempotent `teardown(reason)`:**
- ✕ / caller `close()` → `teardown("api")`
- `cancel` event (Esc on desktop, CloseWatcher back on Chrome-Android PWA) → `preventDefault()`, then `teardown("cancel")`. Doing our own close keeps ordering identical to today: `history.back()` → remove → `onClose`.
- `close` event that we didn't initiate (a `form method=dialog` submit, `closedby`, a browser-forced close after repeated Esc) → `teardown("close")`
- BACK → `popstate` → stack-aware handler (below) → `teardown("back")` without `history.back()`

Inside `teardown`: `dialog.close(returnValue)` if still open → consume our
history entry (unless popped/replacing) → `dialog.remove()` → restore focus to
the opener → `onClose?.(returnValue)`. The settle-before-close rule still
holds: wrappers call `finish(result)` before `close()`, and `onClose` remains
the null/false path.

**Backdrop click.** Use `closedby="any"` when supported. Otherwise (and as a
belt-and-braces check) listen for `pointerdown` + `click` on the dialog and close
only if **both** land outside `dialog.getBoundingClientRect()`, so a text drag
that ends outside doesn't dismiss. A `target===dialog` test alone isn't enough,
because clicks on the card's own padding also target the dialog. On phones the
list-bar area is backdrop, so today's "tap the dimmed bar to dismiss" keeps
working.

**Android back closes the topmost first: overlay stack.** Add a tiny module
(`overlay-stack.js` or inside `ui.js`) that owns the history contract for *all*
overlays:
- `stack = [{ kind, depth, teardown }]`. Opening pushes
  `{velta: kind, depth: n}` (or reuses the entry on replace, exactly like
  `modalReplacing` today).
- One `popstate` listener: target depth = `e.state?.depth ?? 0` if
  `e.state?.velta` is an overlay kind, else 0. Tear down every entry above it,
  topmost first.
- The chat's handler (`app.js:2047`) only closes the chat when the state is
  *neither* `chat` *nor* an overlay sitting above a chat (`e.state?.overChat`).
  This fixes M4.
- Lightbox, webxdc, HTML viewer and IAB register with the same stack in M5
  instead of keeping their own `{once:true}` listeners.
- Keep "one entry per overlay" and "reopen replaces". AGENTS.md §11 already
  documents them. Add "stacked dialogs push one entry each, and BACK pops
  exactly one".

**Stacking.** `stack:false` (default) = today's replace. `stack:true` = a
second `showModal()` on top. The top layer orders by open time, so the newer
one wins, the lower dialog becomes inert automatically, and Esc/BACK close only
the top one. Convert `confirmModal`, `confirmDeleteMessagesModal` and the
chat-info sub-editors to `stack:true`. That removes the `modalHistorySettled()`
reopen dance for those paths (keep the helper for the remaining replace flows).
`closeAllPopups()` closes the whole stack, topmost first.

**Scroll lock.** Free: the top layer + `inert` stop hit-testing and wheel
targeting on the page. Add `html:has(dialog.modal[open]) { overflow: hidden }`
only if a WebView still chains scroll (test on WebView2 + Android 7).
`overscroll-behavior: contain` on `.modal-body` stops chaining from the sheet
itself.

**Animations.**
```css
dialog.modal { opacity:1; transform:none;
  transition: opacity .16s ease-out, transform .16s ease-out,
              overlay .16s allow-discrete, display .16s allow-discrete; }
dialog.modal:not([open]) { opacity:0; transform: translateY(14px) scale(.97); }
@starting-style { dialog.modal[open] { opacity:0; transform: translateY(14px) scale(.97); } }
dialog.modal::backdrop { background: rgb(16 16 16 / .45); transition: …same… }
@starting-style { dialog.modal[open]::backdrop { background: transparent; } }
@supports not (transition-behavior: allow-discrete) {
  dialog.modal[open] { animation: modalIn .16s ease-out; }   /* entry only */
}
@media (prefers-reduced-motion: reduce) {
  dialog.modal, dialog.modal::backdrop { transition: none; animation: none; }
}
```
The phone sheet variant swaps the transform for `translateY(28px)`. On Safari
< 17.4 / macOS 10.15–11 you get entry keyframes and an instant close, same as
today.

**Focus.** Initial focus per `initialFocus`. The ✕ is never auto-focused
unless nothing else is focusable. On close, focus returns to
`document.activeElement` captured before opening, if it's still connected,
else to a caller-supplied fallback (the chat header button, the list row).
`<dialog>` traps Tab natively in the top layer. With `inert` behind it there's
nothing else to reach.

**Non-closable dialogs (`closable:false`).** Set `closedby="none"` where
supported. On every engine, also `keydown` Escape → `preventDefault()` inside
the dialog. Since Chromium 120, a second Esc without user activation may skip
`cancel`, and preventing `keydown` stops the close request before it starts.
Ignore backdrop clicks. On BACK, re-push the entry and show a toast
("Pairing in progress", or offer Cancel). As a last resort, an unexpected
`close` event re-opens the dialog.

### 2.2 Phases

| Phase | Scope | Files | Days |
|---|---|---|---|
| **M0** Groundwork | Playwright harness on the demo build (served `app/`, mock core). Feature-detect helpers (`supportsPopover`, `supportsClosedBy`). Overlay-stack module skeleton plus unit tests on the stub DOM. Extend the node stub DOM with a minimal `HTMLDialogElement` (`showModal`/`close`/`open`/events) so `chat-account-isolation` keeps covering the contract | `tests/`, `app/js/ui.js` | 1 |
| **M1** Helper on `<dialog>` | Rewrite `showModal()` per §2.1: `<dialog>`, `aria-labelledby`, `h2` title, ✕ `aria-label`, `ariaLabel`/`role`/`initialFocus`, `cancel`/`close` → `teardown`, backdrop click with `closedby` fallback, focus return, history contract unchanged. Port the CSS (UA reset, `::backdrop`, phone sheet, desktop pane, list-bar offset via `:has()`). All 34 sites work without edits. Chat info gets `ariaLabel` (M12) | `ui.js:99-152`, `main.css:1241-1363`, `app.js:2306` | 2 |
| **M2** Confirm / prompt / forms | `form` option. `confirmModal` and `confirmDeleteMessagesModal` read `returnValue` (`alertdialog`, Cancel focused for danger, no inline colour). `askText`/`askGroupName`/edit name/`promptName`/edit profile/join link/invite domains use `<form method="dialog">`, a submit button, `required`/`maxlength`/`pattern` and Enter=submit (drop manual `keydown` handlers). `closable:false` for the 4 progress modals (M8) | `ui.js:250-288,889-972`, `app.js:2568,3002-3050,3813`, `invites.js:328-367`, `p2p.js:186-200`, progress sites | 1.5 |
| **M3** Stacking + BACK | Overlay stack with depth in history state. `stack:true` for confirms and chat-info sub-editors (retire their `modalHistorySettled` reopen). `closeAllPopups()` = close stack top-down. Chat popstate guard (M4). Toasts → `#toasts[popover=manual]`, re-`showPopover()` after every top-layer open so they sit above (M3) | `ui.js`, `app.js:2047-2049,2094-2105,2156,2208,2568` | 1.5 |
| **M4** Motion | `@starting-style` + `allow-discrete` entry/exit for dialog and backdrop. Keyframe fallback. Reduced-motion block for modals, menus and toasts (M10) | `main.css` | 0.5 |
| **M5** Special overlays, one by one | **5.1** Image + video lightbox → full-bleed `<dialog>` (keep pinch/wheel zoom; Esc via `cancel`; drop the document keydown). **5.2** Call screen → `<dialog role=alertdialog>`, `closable:false`, focus Accept when ringing, opened last so it tops lightbox/webxdc (M2). **5.3** Context menu, sticker picker, account popover, LC queue → `popover="auto"` with the current overlay path as fallback for macOS ≤ 11; BACK closes an open popover via `closeAllPopups` on popstate (M7); menu keyboard pattern (audit A14). **5.4** Drawer: `inert` while closed (plan 0.3); stays custom because the list bar must stay clickable and swipe gestures drive it. Revisit as `<dialog>` only if the bar is moved inside it. **5.5** webxdc, HTML viewer, IAB → full-screen `<dialog>` registered with the overlay stack (Esc closes them, M6; focus moves to the iframe; IAB styles move to `main.css`, M14). Re-test the "confirm before lightbox" sticker flow (`chat-view.js:1718-1735`), which can now become confirm-over-lightbox with `stack:true` | `ui.js:28-97,524-878,1030-1174`, `calls.js:274-310`, `webxdc-manager.js:215-290`, `chat-view.js:2954-3020`, `inapp-browser.js`, `main.css` | 3.5 |
| **M6** Tests + QA | Playwright + axe specs (below). Android emulator API 24 with WebView 119 and API 28 with 138 (dialog, back, keyboard). macOS 10.15 VM or BrowserStack Safari 15.6 for the popover fallback. WebView2 on Windows. Update AGENTS.md §11 overlay conventions | `tests/a11y/*.spec.mjs`, `AGENTS.md` | 1.5 |
| | **Total** | | **11.5** |

Order: M0 → M1 → M2 → M3 → M4 → M5 (5.2 first, it's a real bug; 5.5 next for
M1/M4) → M6. M1+M2 can ship as one release. M3 should follow before
`stack:true` is used anywhere.

Relation to `docs/web-components-plan.md`: 0.1 and 0.4 fold into M1. 2.4
becomes M1–M5. 4.2 "Esc closes dialogs and restores focus" is covered by M6.
The previous plan's 1.5 days for 2.4 were too low because they left out the
history stack, forms, popover fallbacks and device QA.

### 2.3 Tests (M6)

Playwright, demo build, Chromium plus WebKit projects (WebKit approximates
macOS). Keyboard only:

| Spec | Checks |
|---|---|
| `dialog-focus.spec` | Opening About / Relays / confirm moves focus inside. Tab ×20 never leaves the dialog. Shift+Tab wraps. On close, focus is back on the opener |
| `dialog-esc.spec` | Esc closes the top dialog only. Esc on a `closable:false` progress modal does nothing (twice in a row too). Esc closes lightbox, webxdc (stub), HTML viewer, IAB |
| `dialog-back.spec` | `history.back()` (stands in for Android BACK) closes the top dialog, then the next, then the chat. Opening and closing N dialogs leaves `history.length` balanced. Confirm over chat info: back closes the confirm only. Webxdc + confirm: back closes the confirm and the chat survives (M4) |
| `dialog-return.spec` | `confirmModal` resolves `true` on OK, `false` on Cancel/Esc/backdrop/back. `askText` resolves the trimmed value on Enter, `null` on Esc. `confirmDeleteMessagesModal` returns `me`/`everyone`/`null` |
| `dialog-backdrop.spec` | Click on the scrim closes it. Drag-select from inside to outside doesn't. Phone viewport: tap on the dimmed list bar closes it |
| `dialog-stack.spec` | Toast raised while a dialog is open is visible (elementFromPoint hits the toast). Incoming-call mock while a lightbox is open: the call dialog is topmost |
| `dialog-axe.spec` | axe on 6 representative dialogs: no `aria-dialog-name`, `button-name` or `focus-order-semantics` violations |
| node | Stub-DOM contract tests (settle-before-close, `onClose` once, `#popups` emptied) keep passing. New overlay-stack unit tests: depth math, replace vs stack, popstate to an arbitrary depth |

### 2.4 Risks

| Risk | Mitigation |
|---|---|
| History regressions (lost or double entries) break Android BACK, the most sensitive behaviour in the app (AGENTS.md §11) | Keep the entry shapes, add only `depth`. Back-spec in CI. Manual BACK matrix on Android before release |
| Top layer changes stacking: the sticker "confirm before lightbox" ordering, toasts, the splash under modals | Explicit open order. `#toasts` popover re-show. M5 last-mile tests |
| `<dialog>` UA styles (max-size, padding, `color: CanvasText`) leak into the layout, especially the desktop pane-modal | Full reset in M1. Screenshot compare phone/desktop for 5 modals |
| Initial focus raises the Android keyboard on sheets | Auto-focus inputs only on `pointer: fine`. Phones focus the dialog |
| Chromium Esc anti-abuse closes `closable:false` dialogs | Block at `keydown`, plus `closedby=none`, plus re-open on stray `close` |
| Popover missing on macOS 10.15/11 | Feature-detect. The transparent-overlay path stays as fallback |
| Iframe overlays (webxdc/IAB) inside `<dialog>`: focus and pointer capture inside iframes, WebView2 airspace | Test webxdc games and the IAB scroll on WebView2. If broken, keep them custom but registered with the stack |
| Node tests run on a stub DOM without `HTMLDialogElement` | M0 stub plus a `showModal`-less fallback in the helper |

### 2.5 Acceptance criteria

- All 34 helper sites render as `<dialog>` with an accessible name, a labelled
  close button, a focus trap, Esc, backdrop click, BACK and focus return, with
  no call-site changes beyond the listed opt-ins.
- `confirmModal`, `confirmDeleteMessagesModal` and `askText` resolve from
  `returnValue` and pass the return spec.
- BACK closes exactly the topmost overlay (dialog, menu, popover, lightbox,
  webxdc, HTML viewer, IAB) and never the chat underneath. `history.length` is
  balanced after any open/close sequence.
- Toasts and the call screen are visible above every other overlay.
- Progress modals can't be dismissed by Esc, backdrop or BACK.
- Reduced motion disables modal, menu and toast animations.
- axe: 0 serious/critical violations in the 6 dialog snapshots. All node tests
  pass.
- Works on Android 7 (WebView 119), Android 9 (138), current WebView2 and
  Safari 15.6 (popover fallback path).
