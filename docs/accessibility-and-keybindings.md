# Accessibility and keyboard shortcuts: Delta Chat Desktop reference, Velta audit, plan

Audit date: 2026-10-06. Velta baseline: `master` @ `55818b5`. This document only
covers docs. No app code was changed.

Related documents. This one doesn't repeat them; it cites their finding IDs:
- [`web-components-audit.md`](web-components-audit.md) (findings **A1–A30**,
  B1–B6, C1–C4, D1–D4) and [`web-components-plan.md`](web-components-plan.md)
  (phases 0–4). Examples: chat rows can't be reached by keyboard (A1), message
  actions need a pointer (A8), modals aren't real dialogs (A10), the closed
  drawer stays in the tab order (A12), and there's no `aria-live` (A13/A14).
- [`modals-audit-and-plan.md`](modals-audit-and-plan.md) (findings M1–M15,
  phases M0–M6; finding and phase IDs share the M prefix, so this document
  says "finding M6" for a finding; a bare "modal plan M3" means the phase). It covers `<dialog>`, the overlay stack, Esc via `cancel`,
  Android BACK, and menus as popovers.
- [`native-elements.md`](native-elements.md). It covers `enterkeyhint`,
  `type="search"`, `<time>`, form controls and popover.

New findings in this document use two prefixes. **K1–K8** are keyboard and
shortcut findings. **N1–N13** are accessibility findings that the earlier
audits don't cover. K4 turned out to be the same as modal-plan finding M15
(found at the same time). It stays in the table for completeness but isn't
counted as new.

---

## 1. Summary

- **Delta Chat Desktop** (`deltachat/deltachat-desktop` `main` @ `e034628`,
  2026-10-03, package `2.62.0`) has **41 shortcut actions**, about 70 key
  combinations in total (§2.2). They come from one central mapper
  (`packages/frontend/src/keybindings.ts`), per-component handlers (message,
  composer, multiselect, media viewer, context menu) and Electron menu
  accelerators. The in-app cheat sheet (`Ctrl+/`) lists only 19 of them. The
  repo's `docs/KEYBINDINGS.md` is out of date.
- DC Desktop's accessibility work is mature in some areas:
  - roving tabindex in every list;
  - `aria-live` for delivery state, edits, reactions and draft changes;
  - `aria-keyshortcuts`;
  - layout-independent letter shortcuts and an IME guard;
  - shortcuts turn off while a modal is open;
  - `dir="auto"` handling for RTL text.

  It's weak on reduced motion (one rule), forced colors (none), and has no
  high-contrast theme.
- **Velta has 4 distinct shortcuts:**
  - Enter sends;
  - Ctrl/Cmd+Enter sends when "Send on Enter" is off;
  - Shift+Enter inserts a newline;
  - Esc.

  Those 4 live in **16 key-handler sites** (§3.1). There's no keybinding layer
  and no help. Measured: of 16 DC shortcuts pressed in demo mode, **none did
  anything** (§3.2).
- **Gap table against the 41 DC actions:** 2 have, 7 partial, 27 missing,
  5 conflict (§3.3). All 5 conflicts come from WebView or browser defaults:
  - Ctrl+F opens find-in-page;
  - Ctrl+P opens the print dialog;
  - Ctrl+R and F5 reload the app;
  - Ctrl+N is reserved by the browser in a PWA tab.
- **New findings: 20 in total, 4 high, 11 medium, 5 low** (K4 isn't counted
  because it duplicates modal-plan finding M15). The 4 high ones:
  - **K1:** no keybinding layer.
  - **K2:** Esc closes every layer at once and doesn't cancel a reply or edit.
  - **N1:** every mounted message has an invisible "Reply" tab stop.
  - **N2:** Android text scaling stops at 115%. The WebView pins
    `textZoom=100`, and pinch zoom is off.
- **Plan: 6 phases, 21 days** (§6). P0 adds a registry and a help dialog
  (3 d). P1 brings DC parity (3 d). P2 adds roving tabindex and announcements
  (5 d). P3 covers motion, contrast, scaling and touch targets (3.5 d). P4 goes
  beyond DC and adds customizable bindings (4 d). P5 adds tests (2.5 d). The
  phases fit between web-components-plan phases 0/2/3/4 and modal-plan
  M1/M3/M5 (§6.7).

---

## 2. Delta Chat Desktop reference

### 2.1 Sources

| What | Where (deltachat-desktop @ `e034628`, 2026-10-03, `package.json` 2.62.0) |
|---|---|
| Action enum + central key → action mapper | `packages/frontend/src/keybindings.ts:6-47` (actions), `:100-132` (`matchesLetterShortcut` / `matchesNonLetterShortcut`), `:152-355` (`keyDownEvent2Action`) |
| Global dispatcher | `packages/frontend/src/contexts/KeybindingsContext.tsx:50-69` (one `document` keydown → `ActionEmitter`) |
| Cheat sheet (in-app "Keyboard shortcuts" dialog) | `packages/frontend/src/components/dialogs/KeybindingCheatSheet.tsx`; data in `components/KeyboardShortcutHint.tsx:94-131` (send/newline per setting) and `:141-251` (`getKeybindings`) |
| Per-message shortcuts | `packages/frontend/src/components/message/Message.tsx:619-722` |
| Composer | `components/composer/ComposerMessageInput.tsx:131-160` (send/newline/ArrowUp-edit), `components/composer/Composer.tsx:341-370` (Esc chain) |
| Multiselect | `packages/frontend/src/hooks/useMultiselect.ts:225-360` |
| Roving tabindex | `packages/frontend/src/contexts/RovingTabindex.tsx:1-60, 275-298` |
| Context menu keys | `packages/frontend/src/components/ContextMenu.tsx:330-365` |
| Media viewer | `components/dialogs/FullscreenMedia.tsx:255-275`, `hooks/useZoomKeyboardShortcuts.ts` |
| Ctrl+A scoping | `hooks/useSelectAllKeyboardShortcut.ts` |
| Command palette | `components/screens/MainScreen/MainScreen.tsx:139-165`, `components/dialogs/CommandPalette/*` |
| Electron menu accelerators | `packages/target-electron/src/menu.ts` lines 128, 155, 175, 180, 188, 206, 265, 274, 320, 340, 345, 350, 393 |
| User docs | `docs/KEYBINDINGS.md` (stale, see §2.4) |
| History | `CHANGELOG.md`: 0.900.0 (first keybindings), 1.29.0 (cheat sheet), 1.30.0 (Shift+Enter is always a newline, Ctrl/Cmd+Enter always sends), 1.46.2 (Ctrl+↑/↓ reply, Ctrl+PageUp/Down/Tab), 1.49–1.53 (arrow-key navigation everywhere, Home/End), 2.10–2.15 (`aria-haspopup`, landmarks, `aria-posinset`), 2.43.0 (per-message shortcuts, redesigned dialog), 2.53.0 (shortcuts off while a dialog is open), 2.56.0 (command palette, `aria-live` for drafts), 2.59.0 (Ctrl+A scoping) |

`deltachat-desktop/packages/target-tauri` now only holds a README. The Tauri
target moved to `deltachat/deltachat-tauri`, which wasn't audited here. The
shortcuts listed below live in the shared frontend, so they apply to both
shells. Only the menu accelerators (D34–D38) are Electron-specific.

### 2.2 Every DC Desktop shortcut

`Mod` means Ctrl on Windows/Linux and ⌘ on macOS. Where DC's code uses the
literal Control key on macOS too, the table says so. Sources are relative to
`packages/frontend/src/` unless noted.

| # | Action | Windows / Linux | macOS | Source |
|---|---|---|---|---|
| **Navigation (global)** |||||
| D1 | Next chat | Alt+↓ · Ctrl+PageDown · Ctrl+Tab (auto-repeat for Alt/PageDown) | ⌥↓ · **⌃**PageDown · **⌃**Tab | `keybindings.ts:182-201, 321-353` |
| D2 | Previous chat | Alt+↑ · Ctrl+PageUp · Ctrl+Shift+Tab | ⌥↑ · ⌃PageUp · ⌃⇧Tab | same |
| D3 | Next account | Ctrl+Alt+PageDown | ⌃⌥PageDown | `keybindings.ts:186-189` |
| D4 | Previous account | Ctrl+Alt+PageUp | ⌃⌥PageUp | `keybindings.ts:192-195` |
| D5 | Focus chat-list search (doesn't clear it) | Ctrl+F | ⌘F | `keybindings.ts:206-214` |
| D6 | Search in the current chat | Ctrl+Shift+F | ⌘⇧F | `keybindings.ts:211-212` |
| D7 | New chat dialog | Ctrl+N | ⌘N (either modifier works on every OS) | `keybindings.ts:215-216` |
| D8 | Command palette, search mode (experimental, 2.56) | Ctrl+K | ⌘K | `keybindings.ts:217-218`, `MainScreen.tsx:140-151` |
| D9 | Command palette, command mode | Ctrl+P | ⌘P | `keybindings.ts:219-220` |
| D10 | Focus composer | Ctrl+M | **⌃**M (⌘M minimizes) | `keybindings.ts:221-222` |
| D11 | Settings | Ctrl+, | ⌘, | `keybindings.ts:238-242`, `menu.ts:128,175` |
| D12 | Keyboard shortcuts cheat sheet | Ctrl+/ | ⌘/ | `keybindings.ts:273-277`, `menu.ts:274` |
| D13 | Help | F1 | F1 | `menu.ts:265` |
| D14 | Force network re-check (`maybe_network`) | F5 | F5 | `keybindings.ts:255-256` |
| D15 | Scroll the message list one page (focus in composer) | PageUp / PageDown | same | `keybindings.ts:257-272` |
| D16 | Leave chat-list search (clear + focus composer) | Esc in the search field | same | `keybindings.ts:243-248, 367-370` |
| D17 | Move from search field into results | Enter or ↓ | same | `keybindings.ts:249-254` |
| D18 | Type to focus the composer (printable key, no input focused) | any character | same | `keybindings.ts:278-318` |
| **Composer** |||||
| D19 | Send | Enter (if "Enter sends", default **off**) · Ctrl+Enter | Enter (if set) · ⌘Enter | `ComposerMessageInput.tsx:131-145`, `KeyboardShortcutHint.tsx:94-131` |
| D20 | Newline | Shift+Enter (always) · Enter (if "Enter sends" off) | same | same |
| D21 | Pick the message to reply to (walk up/down) | Ctrl+↑ / Ctrl+↓ | ⌘↑ / ⌘↓ | `keybindings.ts:223-237` (composer target only) |
| D22 | Edit last own message | ↑ in an empty composer | same | `ComposerMessageInput.tsx:148-160` |
| D23 | Cancel reply/edit, close emoji or app picker | Esc | same | `Composer.tsx:341-370` |
| **Focused message** |||||
| D24 | Edit | Ctrl+E | ⌘E | `Message.tsx:633-645` |
| D25 | React (opens reactions bar) | Ctrl+R | ⌘R | `Message.tsx:647-670` |
| D26 | Save to Saved Messages | Ctrl+S | ⌘S | `Message.tsx:672-686` |
| D27 | Unsave | Ctrl+Shift+S | ⌘⇧S | `Message.tsx:688-703` |
| D28 | Delete (selected messages) | Delete | Delete (Fn+⌫) | `Message.tsx:705-722` |
| D29 | Move between messages | ↑ / ↓ · Home / End | same | `RovingTabindex.tsx:275-298`, `MessageList.tsx:1136` |
| D30 | Multiselect | Ctrl+Space or Ctrl+click toggles · Shift+↑/↓/Home/End/click extends · Esc clears | ⌘ instead of Ctrl | `useMultiselect.ts:225-360` |
| D31 | Context menu | Shift+F10 / Menu key (native `contextmenu`); inside the menu ↑/↓, → opens a submenu, ← closes it, Esc | same | `ContextMenu.tsx:330-365`, CHANGELOG 2.10.0 |
| **Media viewer** |||||
| D32 | Previous / next media | ← / → | same | `FullscreenMedia.tsx:255-275` |
| D33 | Zoom media in / out / reset | Ctrl + = / − / 0 | ⌘ + = / − / 0 | `useZoomKeyboardShortcuts.ts` |
| **App / window (Electron menu)** |||||
| D34 | Zoom the whole app | Ctrl + = / − / 0 | ⌘ + = / − / 0 | `menu.ts:340-350` |
| D35 | Quit | Ctrl+Q | ⌘Q | `menu.ts:155,180` |
| D36 | Close window | Ctrl+Q (secondary windows) | ⌘W | `menu.ts:188,206` |
| D37 | Minimize | – | ⌘M | `menu.ts:320` |
| D38 | Developer tools | Ctrl+Shift+I | ⌥⌘I | `menu.ts:393` |
| D39 | Select all, limited to the current message's text outside inputs | Ctrl+A | ⌘A | `useSelectAllKeyboardShortcut.ts` |
| **Dialog-local** |||||
| D40 | Focus member search in the group dialog | Ctrl+F | ⌘F | `dialogs/ViewGroup/index.tsx:350-375` |
| D41 | ↓ from a search field into the list (New chat, Add member) | ↓ | same | `dialogs/CreateChat/index.tsx:313`, `AddMember/AddMemberInnerDialog.tsx:158-170` |

The command palette also has its own keys: ↑/↓, Enter, Tab, and Backspace on
an empty query to leave a scope or filter (`CommandPalette/index.tsx:331-356`).
Lists inside dialogs (contacts, gallery, sticker picker, reactions) all use the
same roving ↑/↓/Home/End. These aren't counted separately.

### 2.3 Keybinding engine techniques worth copying

1. **One mapper, many handlers.** `keyDownEvent2Action()` turns a
   `KeyboardEvent` into an action ID. Components subscribe with
   `useKeyBindingAction` (`keybindings.ts:49-76`, `ActionEmitter`).
   Per-message keys are the exception: they live in `Message.tsx`.
2. **Layout independence.** `matchesLetterShortcut()` matches `ev.key`, and
   falls back to `ev.code` only when a letter key produces a non-Latin
   character (Russian, Greek). `matchesNonLetterShortcut()` avoids taking
   `Ctrl+-` on a German layout when it wants `Ctrl+/`
   (`keybindings.ts:83-132`). This was added after #4140 and #5667 (Dvorak).
3. **IME guard.** `ev.isComposing` suppresses everything
   (`keybindings.ts:175`).
4. **Modal scope.** Nothing fires while a `dialog:modal` is open, and the
   context menu counts as a dialog (`keybindings.ts:148-173`). Dialogs
   handle their own keys (D40).
5. **Repeat policy.** Most shortcuts fire on the first press only. Chat
   switching and page scrolling auto-repeat (`keybindings.ts:180, 319-354`).
6. **`aria-keyshortcuts`** on the composer (`Control+M`), the send button,
   the search input and the new-chat button (`ComposerMessageInput.tsx:257`,
   `Composer.tsx:826`, `SearchInput/index.tsx:57`, `chat/ChatList.tsx:472`).
   A code comment asks maintainers to keep these and the cheat sheet in sync
   by hand (`keybindings.ts:178-179`).
7. **The cheat sheet** groups shortcuts as Navigation / Message input /
   Selected message. Key labels follow the platform (Option/Command on
   macOS, Strg in German), and a `<kbd>` lights up while you press its key
   (`KeyboardShortcutHint.tsx:5-60`). It has no search, and it isn't built
   from the mapper.

### 2.4 Inconsistencies in DC itself (input for §5)

- **Stale docs.** `docs/KEYBINDINGS.md` still describes the pre-1.30 composer
  ("Shift+Enter sends" when Enter-sends is off). It omits Ctrl+Shift+F, the
  palette, the per-message keys, ↑-to-edit and zoom.
- **The cheat sheet is missing** D8/D9 (palette), D12 (itself), D16–D18,
  D29–D33 and D39. Users only learn arrow-key navigation, multiselect and
  viewer keys by accident.
- **Mixed macOS modifiers.** D5/D7/D8/D9 use ⌘. D1/D2/D10 use ⌃. D21 accepts
  ⌘, so on macOS ⌘↑ in the composer can't jump to the start of the text.
- **Alt+← was dropped** because it collides with macOS word movement (#1796).
  Alt+↑/↓ still collides with ⌥↑/↓ (paragraph start/end) in the macOS
  composer.
- **F5** runs `maybe_network` instead of the universal "reload".
- **Ctrl+/ is also blocked while any dialog is open,** so you can't open help
  from a dialog.

### 2.5 DC Desktop accessibility techniques

| Technique | Where | Notes |
|---|---|---|
| Roving tabindex (one tab stop per widget, ↑/↓/←/→, Home/End) | `contexts/RovingTabindex.tsx`; chat list, accounts list, message list, contacts, gallery, sticker/emoji picker, reactions bar, settings (CHANGELOG 1.49–1.53) | Handles DOM reordering and removed elements without stealing focus |
| List semantics | `MessageList.tsx:877,912` (`<ol aria-label="Messages">`); chat list items `role="tab"` with `aria-posinset` (`chat/ChatListItem.tsx:281,379`, CHANGELOG 2.6.0/2.15.0); accounts `role="tablist"` (1.58.0) | |
| Menus | `aria-haspopup="menu"` on items with a context menu (Shift+F10), `aria-expanded` on submenu parents, labelled menus (2.10.0) | |
| Live announcements | Delivery state and edits: `message/MessageMetaData.tsx:61-120,189`. Reactions in the current chat: `Message.tsx:1115`. Draft quote/attachment: `composer/Composer.tsx:630-651`. Toasts: `Toast/ToastLayer.tsx:77` `role="status"`. Palette and search results: `CommandPalette/index.tsx:499-501` | They took care not to over-announce: no re-announcing the composer after each send (2.15.0), delivery status announced once, no reactions announced on scroll (2.56.0) |
| New-message policy | `system-integration/notifications.ts:144-160`: OS notifications for every chat other than the focused one, for accessibility (#4743) | `aria-live` on the open chat is still "TODO, maybe" |
| Landmarks | App-wide landmarks (2.15.0 #5067); "Reply" and "Attachment" landmarks in the composer (2.25.0) | |
| Focus management | Focus returns to the opener when a dialog closes, Esc steps back through nested dialogs, Settings keeps focus after going back a level (2.53/2.56); jump-to-quote focuses the target message (1.52.1) | |
| Focus visibility | `:focus-visible` outlines (`scss/composer/_composer.scss:85-122`); outline contrast fix on Windows (2.6.0 #5217) | |
| RTL | `dir="auto"` on the composer and messages (`ComposerMessageInput.tsx`, `Message.tsx`, `App.tsx`), `unicode-bidi: plaintext` (`scss/message/_message.scss:123,584`, `scss/chat/_chat-list-item.scss:199`) | |
| Themes and contrast | `themes/`: dark, light, dark_amoled, darkpurple (+2 dev themes); follows the OS theme (`target-electron/src/themes.ts:84,147`) | **No high-contrast theme, and no `forced-colors` / `prefers-contrast` rules** |
| Reduced motion | Only `Toast/styles.module.css:40` | The rest of the UI animates regardless |
| Font scaling | App zoom via menu (D34). Zoom is no longer stored in settings (`shared/shared-types.d.ts:62`) | There's no separate message font-size setting |

### 2.6 Delta Chat Android (hardware keyboard, TalkBack)

Source: `deltachat/deltachat-android` `main` @ `847c63a` (2026-10-06,
`versionName 2.62.0`).

- **Hardware keyboard.** Enter is the only key handled. When "Enter sends"
  is on (default **off**, `util/Prefs.java:133-134`), `ComposeKeyPressedListener`
  forwards Enter to the send button
  (`ConversationActivity.java:1813-1827`). There's no `onKeyShortcut` or
  `onProvideKeyboardShortcuts`, so there are no Ctrl shortcuts and nothing
  shows up in Android's Meta+/ shortcut helper.
- **TalkBack.**
  - With touch exploration on, each message gets one composed
    `contentDescription`: sender, type (audio, document, webxdc, vCard,
    call, media, sticker), text and footer
    (`ConversationItem.java:225, 363-393`).
  - Every link in a message becomes a TalkBack custom action, "Open link
    …" (`ConversationItem.java:440-475`, CHANGELOG v2.51.0).
  - Tapping anywhere on an audio message plays it under a screen reader
    (v1.41.0).
  - Click handling changes while TalkBack is on
    (`BaseConversationItem.java:105-120`).
  - The layouts carry 89 `contentDescription` attributes.
- **Text scaling.** Layouts use `sp` (73 `textSize` values in sp, 5 in dp),
  so the system font scale applies. There's no in-app font size.
- **Touch targets.** `48dp` appears in 18 layout attributes, roughly the
  Material minimum.

What this means for Velta on Android: TalkBack reads Velta through
Chromium's accessibility tree, so the web semantics (A-series, N-series)
are all TalkBack has. Velta can't register TalkBack custom actions from web
content. Visible, focusable action buttons are the only way to expose
per-message actions (see N13).

---

## 3. Velta audit: keyboard

### 3.1 Every key handler in Velta

Found with `rg "keydown|keyup|keypress|\.key\b|\.code\b|ctrlKey|metaKey|altKey|shiftKey|isComposing"`
over `app/` (vendored libraries checked too, and they have none). The Tauri
shell was also checked:
- `velta-app/src-tauri/src/*.rs` and `tauri.conf.json` have no menu, no
  accelerators and no global shortcuts.
- The Android Kotlin sources (`gen/android/.../org/velta/*.kt`) have no
  `KeyEvent` handling.

| # | Binding | Scope | File:line | Notes |
|---|---|---|---|---|
| V1 | Enter sends (`velta-send-enter` ≠ "0", **default on**) | composer | `app/js/chat-view.js:2559-2568` | IME-safe (`!e.isComposing`) |
| V2 | Ctrl+Enter / ⌘Enter sends when "Send on Enter" is off | composer | same | `metaKey` is accepted on every OS (the Win key on Windows) |
| V3 | Shift+Enter inserts a newline | composer | same (native) | |
| V4 | Esc → `chatView.exitSelection()` + `closeAllPopups()` (every popup **and** the drawer) | document | `app/js/app.js:4763-4764`, `app/js/ui.js:20-26` | Registered at the end of boot, so it's missing during splash and onboarding (modal-plan finding M6) |
| V5 | Esc closes the image lightbox (capture phase, `stopPropagation`) | lightbox | `app/js/ui.js:1073-1074` | |
| V6 | Esc closes the video lightbox | lightbox | `app/js/ui.js:1162-1163` | |
| V7 | Enter submits: rename prompt | modal input | `app/js/app.js:3023` | **No IME guard** (K4) |
| V8 | Enter submits: new group name | modal input | `app/js/app.js:3047-3048` | no IME guard |
| V9 | Enter submits: onboarding nickname | modal input | `app/js/app.js:4055` | no IME guard |
| V10 | Enter submits: local chat name | modal input | `app/js/p2p.js:198-199` | no IME guard |
| V11 | Enter sends: legacy local 1:1 chat | modal input | `app/js/p2p.js:590-591` | no IME guard |
| V12 | Enter submits: edit profile name | modal input | `app/js/ui.js:962-963` | no IME guard |
| V13 | Enter adds a mirror host | modal input | `app/js/invites.js:367-368` | no IME guard |
| V14 | Enter submits a pasted QR/invite (Shift+Enter = newline) | modal textarea | `app/js/qr-scan.js:122-123` | no IME guard |
| V15 | Alt+right-click passes through to the WebView menu (devtools) | chat row | `app/js/app.js:1663` | mouse modifier |
| V16 | Alt+right-click passthrough | message row | `app/js/chat-view.js:1790` | mouse modifier |

There's one more listener: a passive `keydown` on the history scroller marks
"user scrolled" (`chat-view.js:3067`). It isn't a shortcut. In total that's
4 distinct shortcuts (Enter, Ctrl/⌘+Enter, Shift+Enter, Esc) and 16 handler
sites. Nothing else exists: no shortcut help, no `aria-keyshortcuts`, and no
key hints in `title`s (`title="Send"`, `index.html:173`).

### 3.2 Measured behaviour (headless Chromium, demo mode)

I used Playwright-core 1.56 + system Chrome and axe-core 4.14, installed
in `/tmp/a11y`, outside the repo. `app/` was served with
`python3 -m http.server`, with `localStorage["velta-mock"]="1"` and
`bypassCSP` set in the test context only. That's the same harness as the
web-components audit. Chromium approximates WebView2 for page-level key
handling. Shell-level accelerators (WebView2 browser keys, the macOS menu)
aren't exercised.

| Probe | Result |
|---|---|
| With a chat open, focus on `<body>`, I pressed 16 DC shortcuts one by one: Alt+↓, Alt+↑, Ctrl+PageDown, Ctrl+PageUp, Ctrl+Tab, Ctrl+Alt+PageDown, Ctrl+F, Ctrl+Shift+F, Ctrl+N, Ctrl+K, Ctrl+P, Ctrl+M, Ctrl+,, Ctrl+/, F1, PageUp | **0 of 16 changed anything** (no change to open chat, focus, popups, drawer, composer, reply or scroll) |
| Typing "hi" with focus on `<body>` | Composer stays empty, focus stays on `<body>` (no type-to-focus) |
| ↑ in the empty composer | Nothing happens (no edit-last) |
| PageUp with focus in the composer | History `scrollTop` 3820 → 3820 (not scrolled) |
| Reply set via the context menu, then Esc in the composer | **Reply preview still shown** (`replyVisible: true`) |
| Right-click a message to open the context menu, then ↓ | Focus stays on `<body>`. The menu has no `role`, and ↓ does nothing (A8) |
| Shift+Tab from the composer towards the chat header (29 mounted rows) | 25 stops: Attach, Cancel reply, then **16 × `button.msg-hover-reply`** (invisible, see N1), 2 × "Show Full Message…", 1 × webxdc Start, then Chat menu, Search, Call, `#bar-menu` |
| Message rows | 29 mounted, 0 focusable, 0 with a role |
| Accessibility tree of a chat row | `option "Weekend Crew 🏕 19:11 Can't believe how fast the sync is across devices now 14"`. The unread count is a bare number (A16) |
| Accessibility tree of the history (start) | `text: Haha that's perfect 😂 12:49`, `img` (unnamed tick), `button "Reply"` (repeated per row), `text: September 30 On my way, give me 10 minutes 07:21` (the day chip is fused into the message, N12) |
| Headings in the chat view | none (A23) |
| Reduced motion emulated, drawer opened | `transition: transform 0.22s` and the `fadeIn` overlay animation still run (N3) |
| Forced colors emulated (screenshots) | Bubble boundaries, the active chat row, the active category chip and unread badge pills all disappear (N4) |

### 3.3 Gap table: DC Desktop → Velta

Status counts each DC action once:
- **have**: Velta has an equivalent binding.
- **partial**: some of it exists (pointer-only, or a different shell).
- **missing**: no binding.
- **conflict**: the key already does something else in a Velta shell
  (WebView2, browser tab, macOS default menu).

"Proposed" uses `Mod` = ⌘ on macOS and Ctrl elsewhere. Phases refer to §6.

| # | DC action | Velta today | Status | Proposed Velta binding | Phase |
|---|---|---|---|---|---|
| D1 | Next chat | – | missing | Alt+↓. Also Ctrl+PageDown and Ctrl+Tab in Tauri (in a PWA tab, Chrome reserves both for tab switching) | P1 |
| D2 | Previous chat | – | missing | Alt+↑. Also Ctrl+PageUp and Ctrl+Shift+Tab in Tauri | P1 |
| D3 | Next account | Account switcher is pointer-only (`ui.js:537,660`) | missing | Ctrl+Alt+PageDown | P1 |
| D4 | Previous account | same | missing | Ctrl+Alt+PageUp | P1 |
| D5 | Focus chat search | `#btn-search` click (`app.js:4617-4620`) | **conflict**: WebView2/browser find bar | Mod+F with `preventDefault` | P1 |
| D6 | Search in chat | `#btn-chat-search` click (`app.js:2793-2848`) | missing | Mod+Shift+F | P1 |
| D7 | New chat | `#btn-new-chat` | **conflict**: Ctrl+N is a reserved "new window" in a PWA tab | Mod+N in Tauri and standalone PWA. In a tab, use the palette (P4) | P1 |
| D8 | Command palette (search) | – | missing | Mod+K = quick switcher (chats, contacts, messages) | P4 |
| D9 | Command palette (commands) | – | **conflict**: Ctrl+P = print in WebView2/browser | Don't bind Mod+P. Mod+K plus typing `>` gives commands (§5) | P4 |
| D10 | Focus composer | – | missing | Ctrl+M (⌃M on macOS too, as in DC) | P1 |
| D11 | Settings | Drawer `#bar-menu` | missing | Mod+, opens the drawer with focus on the Settings group | P1 |
| D12 | Shortcut cheat sheet | – | missing | Mod+/ and `?` (outside text fields) | **P0** |
| D13 | Help | – (no help page) | missing | F1 → cheat sheet, with a link to the docs | P0 |
| D14 | Force network re-check | Diagnostics "Restart: Core" (`index.html:156-160`, `rpc-core.js:239-244`) | **conflict**: F5 reloads the app in WebView2/browser | F5 → `maybe_network` + toast. Block reload in Tauri (K3). Keep Mod+Shift+R for a deliberate reload in the PWA | P0 |
| D15 | PageUp/Down from composer | – (measured) | missing | PageUp/PageDown scroll `#history-scroll` by ~90% of a page when the composer is focused | P1 |
| D16 | Esc leaves chat-list search | Global Esc only closes popups | missing | Esc in the search field: clear it, return to the chat list, focus the active row | P1 |
| D17 | Enter/↓ into results | – (`app.js:2970-2998`) | missing | Enter opens the first hit, ↓ focuses the first result | P1 |
| D18 | Type to focus composer | – (measured) | missing | Same as DC on fine pointers. Never on touch | P1 |
| D19 | Send | V1/V2 | **have** | Keep. Default per platform (K5) | P1 |
| D20 | Newline | V3 | **have** | Keep | – |
| D21 | Pick reply target | Hover pill / context menu | missing | Mod+↑/↓ from the composer, but **only when the caret is at the very start (↑) or end (↓)**, so caret movement still works (§5.3) | P1 |
| D22 | Edit last own message | Context menu "Edit" (`chat-view.js:2216`) | missing | ↑ in an empty composer (not whitespace-only, as in DC 2.53) | P1 |
| D23 | Esc cancels reply/edit/picker | V4 closes the sticker picker (popup), but **not the reply/edit** (measured) | partial | Layered Esc chain (K2, P0.2) | P0 |
| D24 | Edit focused message | – | missing | Mod+E (message focused) | P2 |
| D25 | React | Context menu "React" (`chat-view.js:2264`) | **conflict**: Ctrl+R reloads in WebView2/browser | Mod+R with `preventDefault` on a focused message. Keep Tauri reload blocked (K3) | P2 |
| D26 | Save to Saved Messages | Context menu + selection bar (`index.html:111`) | missing | Mod+S (a browser tab would otherwise "Save page"; `preventDefault` handles it) | P2 |
| D27 | Unsave | – | missing | Mod+Shift+S | P2 |
| D28 | Delete | Context menu + selection bar | missing | Delete, and on macOS also ⌘⌫ (Mac keyboards have no Delete key) | P2 |
| D29 | ↑/↓/Home/End between messages | Rows not focusable (A8) | missing | Roving tabindex over mounted rows (P2.2) | P2 |
| D30 | Multiselect | Selection mode is pointer-only; Esc exits (`app.js:4764`) | partial | Space toggles (in selection mode), Shift+↑/↓ extends, Mod+Space toggles outside it, Esc clears | P2 |
| D31 | Context menu by keyboard | `contextmenu` only on pointer targets; menu takes no focus (A8, measured) | missing | Shift+F10 / Menu key / Mod+. on a focused row or chat. Menu keys per modal plan M5.3 | P2 |
| D32 | Prev/next media | Lightbox Esc only (`ui.js:1073,1162`) | missing | ← / → across the chat's media (K8) | P1 |
| D33 | Zoom media | Pinch/wheel only | missing | Mod + = / − / 0 inside the lightbox | P1 |
| D34 | Zoom the app | Interface scale radios (`ui.js:455-485`). Tauri `zoomHotkeysEnabled` defaults to off. Browser zoom works in a PWA tab | partial | Mod + = / − / 0 step through the UI scale (more steps up to 2.0, N2) | P3 |
| D35 | Quit | macOS: Tauri's default app menu (⌘Q). Win/Linux: none (Alt+F4 from the OS) | partial | Leave as is | – |
| D36 | Close window | macOS default menu ⌘W | partial | Leave as is | – |
| D37 | Minimize | macOS default menu ⌘M | partial | Leave as is | – |
| D38 | DevTools | WebView2 F12 / Ctrl+Shift+I when the `devtools` feature is on (`Cargo.toml:35`), behind the Diagnostics DevTools switch (`app.js:203`) | partial | Keep behind the Diagnostics switch | – |
| D39 | Scoped Ctrl+A | – (selects the whole UI) | missing | Same as DC: no-op outside fields, or select the message's text (K7) | P1 |
| D40 | Mod+F in the group dialog | No member search | missing | When a member filter exists (native-elements §4), Mod+F focuses it | P4 |
| D41 | ↓ from search into the list | – (`pickContactModal`, `app.js:2850+`) | missing | ↓ moves into the list | P1 |

**Totals: have 2 · partial 7 · missing 27 · conflict 5** (41 DC actions).

### 3.4 Platform notes

- **Windows (Tauri, WebView2).** Tauri 2.11.5 (`Cargo.lock`) and
  `tauri.conf.json` leave WebView2's `AreBrowserAcceleratorKeysEnabled` at
  its default, **true**. These keys are therefore live:
  - Ctrl+F/F3 find;
  - Ctrl+P print;
  - Ctrl+R/F5 reload;
  - Ctrl+Shift+C/F12 DevTools (when enabled);
  - the Back/Forward keys, including Alt+←/→.

  See [Microsoft's docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2settings.arebrowseracceleratorkeysenabled).
  Alt+← runs `history.back()`, and Velta's overlays and open chat are
  history entries (`AGENTS.md` §5.1, the `{velta:'modal'}` history entry and BACK). So Alt+←
  already works as "close the overlay / close the chat", which is useful
  but nobody designed it. Velta has no menu bar, so Alt-based bindings don't
  collide with menu mnemonics here.
- **Linux (Tauri, WebKitGTK).** The WebView adds no browser accelerators.
  Alt+↑/↓ is free. Some desktop environments use Ctrl+Alt+↑/↓ for
  workspaces, which is why D3/D4 use PageUp/Down.
- **macOS (Tauri, WKWebView).** Tauri's default macOS menu
  (`enable_macos_default_menu`, on by default) provides ⌘Q, ⌘W, ⌘M, ⌘H and
  the Edit-menu clipboard/undo roles. In text fields, ⌥↑/↓ and ⌘↑/↓ move the
  caret (paragraph or document start/end), and ⌃↑/↓ is Mission Control.
  Velta has no other macOS handling. Only V2 accepts `metaKey`, and nothing
  shows ⌘/⌥ labels.
- **Android (Tauri WebView).** Hardware keyboards deliver `keydown` to the
  page, so desktop bindings mostly work on DeX, Chromebooks and Bluetooth
  keyboards. Some keys are reserved:
  - **Meta+/** opens Android's system shortcut helper (Android 7+), so on
    Android `Mod` must be Ctrl, never Meta.
  - TalkBack's default keyboard commands use **Alt** (Alt+arrows walk
    items). With TalkBack and a hardware keyboard, Alt+↑/↓ chat switching
    would collide, so prefer Ctrl+PageUp/Down there.
  - Some OEM keyboards map Esc to BACK. That reaches the page as `popstate`
    as well as `keydown`, so the Esc chain must not handle both.

  Soft keyboards send Enter as a real key, so with "Send on Enter" on by
  default there's no way to type a newline (K5).
- **PWA in a browser tab.** Chrome reserves Ctrl+N/T/W, Ctrl+Tab,
  Ctrl+PageUp/Down and Ctrl+Shift+Tab: pages can't override them. Some of
  them are released to an installed standalone PWA window. Bindings must
  degrade gracefully there: Alt+↑/↓ and the palette work everywhere.

---

## 4. Velta audit: accessibility beyond the earlier audit

### 4.1 Findings

Severity follows the scale in `web-components-audit.md`:
- **High** blocks a task for keyboard or assistive-tech users.
- **Medium** is a serious barrier or a WCAG AA failure with a workaround.
- **Low** is polish.

The A-series findings (A1 non-focusable rows, A8 pointer-only actions, A10
dialogs, A12 drawer tab order, A13/A14 live regions, A16 badges, A23
headings) aren't repeated. The findings below are additional.

| ID | Sev | Finding | Evidence (file:line) | Fix (phase) |
|---|---|---|---|---|
| **K1** | High | **There's no keybinding layer.** Velta has 4 shortcuts. Everything else (switching chats or accounts, search, new chat, reply, react, delete, settings) needs a pointer or touch. Nothing announces or lists shortcuts, and there's no `aria-keyshortcuts`. | §3.1, §3.2 (0/16 shortcuts had any effect) | `app/js/keybindings.js` registry plus a help dialog (P0, P1) |
| **K2** | High | **Esc is all-or-nothing and still misses things.** One document listener exits selection *and* closes every popup *and* the drawer (`app.js:4763-4764`, `ui.js:20-26`). Esc in the composer doesn't cancel a reply or edit (measured). Esc does nothing in webxdc, the HTML viewer, the in-app browser or calls (modal-plan finding M6), and before boot ends. | `app/js/app.js:4763-4764`, `app/js/ui.js:20-26`, `chat-view.js` reply state | Layered Esc chain: topmost layer first, one layer per press (P0.2, built with modal plan M3) |
| **K3** | Medium | **WebView and browser accelerators are live in the desktop app.** In WebView2: Ctrl+F opens a native find bar over the app, Ctrl+P prints, Ctrl+R/F5 reload (dropping RPC state mid-session), and Alt+←/→ runs history back/forward. Nothing turns them off or redirects them. | `velta-app/src-tauri/tauri.conf.json` (no settings), Tauri 2.11.5. WebView2 default `AreBrowserAcceleratorKeysEnabled=true` | Accelerator policy: the registry `preventDefault`s the keys it owns. In Tauri, turn off browser accelerators (wry `with_browser_accelerator_keys(false)` / `tauri-plugin-prevent-default` once Tauri ≥ 2.12), keeping DevTools behind the Diagnostics switch (P0.4) |
| **K4** | Medium | **Enter submits in 8 places without an IME guard** (= modal-plan finding M15; not counted as new). Pressing Enter to commit a CJK or Vietnamese candidate submits the form half-typed. | `app.js:3023, 3047-3048, 4055`, `p2p.js:198-199, 590-591`, `ui.js:962-963`, `invites.js:367-368`, `qr-scan.js:122-123` (V7–V14). The composer has the guard (`chat-view.js:2565`) | Shared `isSubmitEnter(e)` that checks `isComposing` and `keyCode 229`. Or let `<form>` submission handle it, as in modal plan M2 (P0.5) |
| **K5** | Medium | **"Send on Enter" is on by default on every platform, including touch.** On Android and iOS soft keyboards, the Enter key sends, so you can only type a multi-line message by turning off a setting in the drawer. DC Desktop and DC Android both default to *off* (`state.ts:10`, `Prefs.java:133-134`). | `app/js/chat-view.js:2559-2568` (`velta-send-enter` default on), `ui.js:615, 836-840` | Default on with a fine pointer and off with a coarse pointer, with `enterkeyhint` to match (native-elements §10). Show "Enter to send · Shift+Enter for a new line" as a hint (P1.6) |
| **K6** | Medium | **Shortcuts can't be discovered.** There's no help dialog or `title` hints, and the drawer doesn't mention keys. | `index.html:173` (`title="Send"`), drawer `ui.js:537-660` | Help dialog plus `aria-keyshortcuts`, both generated from the registry (P0.3) |
| **K7** | Low | **Ctrl+A outside a field selects the whole app UI** (chat list, header, bubbles). | No handler | Same scoping as DC D39 (P1.4) |
| **K8** | Low | **The lightbox only handles Esc.** No ←/→ between media and no keyboard zoom. The image/video buttons inside aren't in a focus trap (that part is modal plan M5.1). | `app/js/ui.js:1073-1074, 1162-1163` | ←/→ and Mod + = / − / 0 (P1.5) |
| **N1** | High | **Invisible tab stops on every message.** Each mounted row has a `button.msg-hover-reply` that's `opacity:0` and only becomes visible on `.msg-row:hover`. There's no `:focus-visible` or `:focus-within` rule, so keyboard users tab through 16+ invisible "Reply" buttons (measured 16 of 25 stops). Screen readers also hear "Reply" after every message. | `app/js/chat-view.js:1572-1587`, `app/css/main.css:547-563` | Quick win: `tabindex="-1"` plus `aria-hidden` on the hover pill. Expose Reply through roving row actions or the context menu instead (P0, real fix P2.2) |
| **N2** | High | **Text scaling is capped at 115% on Android.** `MainActivity.kt` pins `WebSettings.textZoom=100`, so the system font size is ignored. The viewport has `user-scalable=no`, so pinch zoom is off. The in-app scale tops out at 1.15. That fails WCAG 1.4.4 (200%) for low-vision users. | `velta-app/src-tauri/gen/android/.../MainActivity.kt:115-136`, `index.html:5`, `app/js/ui.js:455-485` (`UI_SCALES` 0.85/1/1.15) | Map Android `fontScale` to the UI scale, add 1.3/1.5/1.75/2.0 steps, and test reflow at 2.0 (P3.4) |
| **N3** | Medium | **Reduced motion is partial.** There are 15 `@keyframes` blocks, and only 6 animated areas have a `prefers-reduced-motion` override. The drawer slide (`transition: transform .22s`), overlay `fadeIn`, popover and modal entrances, the typing dots and call pulse still animate (measured). | `app/css/main.css`: keyframes at 140, 165, 336, 464, 814, 896, 1175, 1253, 1263, 1323, 1347, 1575, 1613, 1621, 1755. Overrides only at 141, 337, 815, 908, 1180, 1579 | One global reduced-motion block. Keep opacity fades ≤ 150 ms and drop transforms (P3.1, shared with modal plan M4) |
| **N4** | Medium | **No `forced-colors` or `prefers-contrast` support** (0 rules). In Windows High Contrast, message bubble boundaries, the selected chat row, the active filter chip and unread badges disappear (screenshots). Icons are `<svg fill="currentColor">`, so they survive. | `app/css/main.css` (no `@media (forced-colors)`) | Forced-colors block: borders on bubbles, chips and badges, and `Highlight` for selection. `prefers-contrast: more` reuses the "brutal" theme tokens (P3.2) |
| **N5** | Medium | **Contrast failures** besides the ones the earlier audit flagged (WCAG 1.4.3, 4.5:1; AGENTS.md §6.4):<br>- dark: unread badge `#f4f4f4` on `--accent-2 #8774e1` = 3.4:1; "Contact Requests" avatar initials 2.54:1; empty-state subtitle `#65656e` on `#0b0b10` = 3.4:1<br>- light: category chips 4.46:1; time on the active row `#cee0f1` on `#5aa2e6` = 2.0:1<br>- brutal: avatar 2.54:1, empty-state text 3.94:1, `.cht-status` 4.36:1, `.msg-fwd` 4.24:1 | `main.css:12` (`--accent-2`), 1214-1220 (`.ci-badge`), 1198 (active row), 262 (`.no-chat-sub`), 1237 (`.cht-status`), 623 (`.msg-fwd`), 112-116 (chips) | Adjust tokens per theme and add a contrast check to the axe matrix (P3.3, together with WC plan 3.4) |
| **N6** | Medium | **No bidi handling.** Message text, chat-list previews and the composer have no `dir="auto"` or `unicode-bidi: plaintext`. Arabic or Hebrew messages in an LTR UI come out left-aligned, and mixed punctuation gets reordered wrongly. DC handles this. | `chat-view.js:1510, 1527` (`.msg-text`), `index.html:168` (composer), chat-list preview in `app.js` row render | `dir="auto"` on text containers plus `unicode-bidi: plaintext` (P3.6) |
| **N7** | Medium | **The call overlay rebuilds its DOM every 300 ms.** `render()` replaces `innerHTML`, which drops keyboard focus from Mute/Hang up and makes screen readers re-read the whole overlay. | `app/js/calls.js:281-312` (`render`), the timer interval | Update the timer text node only, and keep the buttons stable. Overlay semantics per modal plan M5.2 (P2.6) |
| **N8** | Medium | **The search fields have no accessible name or result feedback.** Both use a placeholder as the only label, and no status announces "N results" or "no results". Sidebar search results aren't a labelled list. | `app/js/app.js:2793-2848` (in chat), `app.js:2960-2998` (sidebar) | `aria-label`, a polite `role="status"` result count, a labelled results list (P2.6, with native-elements §4 for `type="search"`) |
| **N9** | Medium | **Touch targets** at 412 px width:<br>- chat list: 25 targets, of which 6 are under 24 px, 7 under 44 and 13 under 48 (`#btn-search` 40×40, category chips 63×22, bottom bar 60×46)<br>- open chat: 8 of 12 under 48 (header icons 40×40, text links 138×26, webxdc "Start" 52×21)<br>- drawer: scale options are 369×30<br>That's below Android's 48 dp and Apple's 44 pt (WCAG 2.5.8 minimum 24 px; most pass that, the chips don't). | `main.css:98-99` (`.icon-btn` 40 px), 112-116 (chips), 206 (`.bar-btn` 46 px), 996-1001 (reaction chips) | 44 px minimum hit area via padding or `::after` without visual change. Chips at least 32 px tall with 48 px hit slop (P3.5) |
| **N10** | Low | **Voice and audio players have no label.** A bare `<audio controls>` is announced as "audio" with no sender or duration context. | `app/js/chat-view.js:1463` | `aria-label="Voice message from X, 0:42"` (P2.6) |
| **N11** | Low | **The page language doesn't follow the locale.** `<html lang="en">` is fixed. Dates use `toLocale*([])` (the browser locale), so `lang` and the date language can disagree, and screen readers mispronounce. There's no UI translation yet (out of scope), but `lang` should reflect the content language. | `index.html:2`, `app/js/format.js:40-57` | Set `document.documentElement.lang` from `navigator.language` until i18n exists. `lang` on message text is optional (P3.7) |
| **N12** | Low | **The day separator and unread separator are fused into the next message.** They're rendered inside the message row, so screen readers read "September 30 On my way…". | `app/js/chat-view.js:1372-1375` | Render them as separate `role="separator"` items with an `aria-label`, or as a heading per day (P2.6) |
| **N13** | Medium | **On Android, message actions are long-press only.** TalkBack users can reach them with a double-tap-and-hold, but there's no visible alternative, and web content can't add TalkBack custom actions (DC Android does, `ConversationItem.java:440-475`). | `chat-view.js:2212-2268` (context menu via long press) | A focusable "More actions" button per row, shown on focus or for screen readers, which opens the same menu (P2.4) |

**Severity totals (new): High 4 (K1, K2, N1, N2) · Medium 11 (K3, K5, K6, N3,
N4, N5, N6, N7, N8, N9, N13) · Low 5 (K7, K8, N10, N11, N12) = 20.** K4 is
modal-plan M15. N3 goes further than modal-plan M10, which only covers modal
animations. K2 includes modal-plan finding M6 but adds the all-at-once
closing and the reply/edit cancel.

### 4.2 Screen-reader flows (NVDA/JAWS browse mode, VoiceOver, TalkBack)

| Flow | Today | Target |
|---|---|---|
| Find and open a chat | The chat list is a `listbox` of `option`s (`index.html:54`), but the options can't be focused (A1). In browse mode you can read them, but Enter does nothing. TalkBack: double-tap works. | Roving `listbox` (or DC-style `tablist`), Enter opens, Alt+↓/↑ switch (P1, P2) |
| Read new messages | No `aria-live` (A13). Day chips are fused (N12). Each message is followed by "Reply" (N1). The read ticks are an unnamed `img`. | Rows are focusable `article`s with a composed name ("Alice, 12:49, delivered: text"). New messages in the open chat are announced politely and throttled. Other chats rely on OS notifications, as in DC (P2.5) |
| Reply to a message | Hover the pill or right-click → menu that takes no focus (A8). | Focus the row, then Mod+↑ from the composer or Shift+F10 → Reply. The reply preview is announced, and Esc cancels it (P1, P2) |
| React / delete | Context menu only, unreachable by keyboard. | Mod+R and Delete on the focused row, plus the menu (P2) |
| Search | The placeholder is the only label, with no result count (N8). | Labelled field, announced count, ↓ into results, Esc back (P1.2, P2.6) |
| Calls | Focus is lost every 300 ms (N7). The incoming call isn't an `alertdialog` (modal plan M5.2). | Stable buttons. A keyboard toggle for mute (Mod+D, P4.6) |
| Browse-mode single-letter keys (NVDA/JAWS H, B, K...) | No headings (A23), so H finds nothing. | Rule: Velta binds **no unmodified letter keys** outside text fields, apart from `?` when focus isn't in a field, so screen-reader quick-nav keeps working |

### 4.3 Landmarks, headings, focus order, language

- **Landmarks (measured).** `aside`, `header`, `nav` (`role="listbox"`,
  which hides the navigation landmark), `footer` (`role="toolbar"`),
  `main`, `header`, `footer`. The sidebar `nav` overriding its role with
  `listbox` loses the landmark. Wrap the list in a `<nav aria-label="Chats">`
  instead.
- **Headings.** None in the chat view. The chat title in the header should
  be an `h1`/`h2` (already A23).
- **Focus order.** Today it goes header → Attach → Cancel reply → 16 hidden
  Reply buttons → … (§3.2). The target order follows the visual flow: header
  actions → history (one stop) → composer → send. F6 cycles between regions
  (sidebar, chat history, composer), as in Slack and Teams (P4.3).
- **Roving.** No roving tabindex anywhere. Plan it once (`app/js/roving.js`)
  and key it by stable IDs (chat ID, message ID). Then the virtual
  scroller's row recycling and event-storm re-renders (`_rowSigCache`) keep
  focus (P2.1).
- **Scaling and reflow.** No horizontal overflow at 320 px, 640×400,
  380×520 and UI scale 1.15 (measured). But 127 font sizes are in `px` and
  none in `rem`, so the UI scale is the only lever (N2).
- **Language.** See N11.

---

## 5. Opinion: how DC's keybindings could be better (and what Velta should do)

> **This section is opinion,** not audit. It's the author's view on what to
> adopt from Delta Chat Desktop, what to improve, and where Velta should
> deliberately diverge. The plan in §6 follows it, but each point can be
> argued.

### 5.1 Discoverability is DC's biggest gap

DC has good bindings that few people find. The cheat sheet lists 19 of 41
actions, the repo docs are years old, and only 4 controls carry
`aria-keyshortcuts`, kept in sync by hand. The fix is structural:
**one registry that every surface is generated from**:
- the help dialog;
- `aria-keyshortcuts`;
- tooltip suffixes ("Search (Ctrl+F)");
- the palette's right-hand key hints;
- a generated `docs/keybindings.md`.

The help dialog should be **searchable** and should **open from inside
dialogs too** (DC blocks Ctrl+/ there). It should show only bindings that
work on the current platform and shell.

### 5.2 Follow the conventions people already know

The other apps' columns come from their own shortcut help screens as I remember them. I didn't re-check them for this audit, so treat them as indicative.


| Action | Slack | Discord | Telegram Desktop | Signal Desktop | DC Desktop | Velta proposal |
|---|---|---|---|---|---|---|
| Quick switcher | Mod+K | Mod+K | Mod+F (search) | Mod+F (search) | Mod+K (experimental) | **Mod+K** |
| Next/prev chat | Alt+↑/↓ | Alt+↑/↓ | Ctrl+Tab, Alt+↑/↓ | Alt+↑/↓ | Alt+↑/↓, Ctrl+PgUp/Dn | Alt+↑/↓ (+ Ctrl+PgUp/Dn) |
| Next/prev **unread** chat | Alt+Shift+↑/↓ | Alt+Shift+↑/↓ | – | Alt+Shift+↑/↓ | **missing** | **Alt+Shift+↑/↓** |
| Edit last message | ↑ | ↑ | ↑ | ↑ | ↑ | ↑ |
| Reply to message | – (hover) | – | Ctrl+↑/↓ | Mod+Shift+R (focused message) | Ctrl+↑/↓ | Mod+↑/↓ at the caret boundary |
| Mark chat read | Esc | Esc | – | – | **missing** | **Shift+Esc** (Esc is taken by the layered chain) |
| Mark all read | Shift+Esc | Shift+Esc | – | – | **missing** | Palette command |
| Jump to oldest unread | – | Shift+PgUp | – | – | **missing** | **Shift+PageUp** |
| Shortcut help | Mod+/ | Mod+/ | – | Mod+/ | Mod+/ | **Mod+/** and `?` |

### 5.3 Modifier and platform conflicts DC gets wrong (or barely gets away with)

1. **⌥↑/↓ and ⌘↑/↓ on macOS** are text-navigation keys. DC takes ⌥↑/↓ for
   chat switching and ⌘↑/↓ for reply selection, so in a multi-line draft
   they don't do what macOS users expect. Proposal:
   - Chat switching with ⌥↑/↓ only when the caret is on the first/last
     line, or when focus isn't in a field. ⌃Tab works everywhere.
   - Reply selection only when the caret is at the very start/end.
2. **Mixed ⌘/⌃ on macOS** (⌘F but ⌃M, ⌃PageDown). Pick one rule: ⌘ for
   commands, ⌃ only where the shortcut means "Control" on every OS (⌃Tab).
   ⌃M stays only because ⌘M is reserved for minimize.
3. **Delete on a Mac.** Most Mac keyboards have no Delete key. Bind ⌘⌫ too,
   as Finder and Mail do.
4. **F5 ≠ reload** surprises people. In Velta, F5 should *also* stop the
   reload in Tauri, and say "Reconnecting…" in a toast so the remap is
   visible.
5. **Alt+letter** is avoided in DC and should stay avoided. On Windows it
   types characters in some layouts (AltGr = Ctrl+Alt), and on macOS ⌥+letter
   types special characters.
6. **Keys a web tab reserves** (Ctrl+N/T/W/Tab/PgUp/PgDn). DC has no web
   build. Velta does, so every binding needs a tab-safe alternative (§3.4).
7. **Screen readers.** Never bind unmodified letters or Ctrl+Alt+arrows
   (NVDA table navigation and Narrator use them). Don't bind Insert or
   CapsLock combinations. TalkBack takes Alt+arrows on Android.

### 5.4 Actions DC (and Velta) should add

- Next/previous **unread** chat, mark chat read, jump to first unread
  message, jump to the newest message (End in the history).
- Next/previous **search hit** inside a chat (Enter / Shift+Enter in the
  in-chat search, F3 / Shift+F3 once find-in-page is blocked).
- **F6** to cycle regions (sidebar ↔ history ↔ composer).
- **Archive / pin / mute** the current chat from the palette (`app.js:1763-1777`
  has the actions already).
- **Toggle mute in a call** (Mod+D, as in Meet and Teams).
- **Quote / forward / copy text** of the focused message (Mod+C on a
  focused row with no selection copies the text).

### 5.5 Structure: declarative scopes, remapping, palette

- **Declarative scopes.** Each binding declares a scope: `global`,
  `chat-list`, `history`, `message`, `composer`, `lightbox`, `dialog`. The
  dispatcher resolves the innermost active scope first. That replaces DC's
  split between the central mapper and the handlers in `Message.tsx`, and
  "all shortcuts off while a modal is open" becomes "the dialog scope lets
  only its own bindings and help through".
- **Remapping.** Users can rebind any action. Conflict detection runs
  against the registry *and* a per-platform reserved list (WebView,
  browser, OS, screen reader). Saved per device in `localStorage`, not per
  account, with an export.
- **Every binding is a palette command, and every palette command can get a
  binding.** The palette shows the current key, so users learn shortcuts by
  using the palette.

### 5.6 Adopt vs improve

| DC technique | Velta |
|---|---|
| Central action mapper + emitter | **Adopt**, as a declarative, scoped registry (§5.5) |
| Layout-independent letter matching (`key` then `code`) | **Adopt as is.** Velta's users include Russian-layout users (`ev.key` = "а" for Ctrl+F) |
| `isComposing` guard | **Adopt everywhere** (K4) |
| Shortcuts off in modals | **Improve**: dialog scope, help still works |
| Repeat policy (only navigation repeats) | **Adopt** |
| `aria-keyshortcuts` by hand | **Improve**: generated |
| Cheat sheet | **Improve**: generated, searchable, per platform |
| Roving tabindex everywhere | **Adopt**, keyed by stable IDs for the virtual scroller |
| `aria-live` restraint (announce once) | **Adopt** |
| No high contrast / forced colors / reduced motion | **Do better** (P3) |
| Enter-sends default off | **Adopt for touch.** Keep on for desktop, where Velta users expect it (K5) |

---

## 6. Phased plan

Day estimates are for one developer who knows the codebase. Each phase has
to keep the AGENTS.md invariants:
- account isolation, so no key handler acts on a stale account's chat;
- the event-storm rules, so roving focus survives `_rowSigCache` re-renders;
- the overlay/BACK convention.

New modules go in `app/js/` as ES modules. Each new module is added to the
service worker's asset list, and the cache version constant in `app/sw.js`
is bumped (AGENTS.md §6.2).

### P0: Foundation, 3 days

| Task | Files | Days |
|---|---|---|
| 0.1 **`app/js/keybindings.js` registry.** `register({id, keys:{default, mac, android?}, scope, when, repeat, run, label, group})`. One capture-phase `keydown` dispatcher. It handles platform `Mod`, layout-independent matching (DC `matchesLetterShortcut` logic), the `isComposing`/229 guard, scope resolution (§5.5), and `preventDefault` only when a binding fires. It also exports `ariaKeys(id)` and `labelKeys(id)`. | new `app/js/keybindings.js`; `app/js/app.js` (boot wiring); `app/sw.js` | 1 |
| 0.2 **Layered Esc chain.** Topmost layer first: lightbox → menu/popover → modal → drawer → reply/edit preview → selection mode → search field → (nothing). One layer per press. The existing global listener (`app.js:4763-4764`) and `closeAllPopups()` stay for programmatic use, but Esc stops calling them. Register the listener early in boot (modal-plan finding M6). Esc and BACK share one `closeTop()` (modal plan M3). | `app/js/app.js`, `app/js/ui.js`, `app/js/chat-view.js` | 0.5 |
| 0.3 **Help dialog** (Mod+/, `?` outside fields, F1). Generated from the registry, grouped, searchable, with platform labels (⌘ ⌥ ⇧ on macOS) and only the bindings available in this shell. Built on the modal plan M1 dialog helper. A "Keyboard shortcuts" entry in the drawer. | new `app/js/keyboard-help.js`; `app/css/main.css`; `index.html` drawer entry | 0.75 |
| 0.4 **Accelerator policy.** The registry owns Mod+F/R/P/N and F5 when bound. In Tauri desktop, turn off WebView browser accelerators (Windows: `with_browser_accelerator_keys(false)` via wry, or `tauri-plugin-prevent-default` after the Tauri ≥ 2.12 upgrade). DevTools stays behind the Diagnostics switch. Write the reserved-key list per shell into the registry. | `velta-app/src-tauri/src/lib.rs`, `Cargo.toml`, `app/js/keybindings.js` | 0.5 |
| 0.5 **`isSubmitEnter(e)`** in the 8 Enter handlers (K4), unless modal plan M2 has already turned them into `<form>`s. **Quick win N1:** `tabindex="-1"` + `aria-hidden="true"` on `.msg-hover-reply`. | `app/js/app.js`, `p2p.js`, `ui.js`, `invites.js`, `qr-scan.js`, `chat-view.js:1572-1587` | 0.25 |

- **Risks.** A capture-phase dispatcher can swallow keys from webxdc iframes
  or the in-app browser: never dispatch when `document.activeElement` is an
  `iframe`. Clipboard and undo keys (Ctrl+C/V/X/Z) aren't WebView2 browser
  accelerators, so they should keep working when accelerators are off. Verify
  that on Windows. The Esc chain has to agree with `popstate`
  handling, or one press closes two layers.
- **Acceptance.**
  - Mod+/ opens a help dialog that lists every registered binding, with ⌘
    labels on macOS.
  - Esc closes exactly one layer per press, including the reply preview.
  - Ctrl+F/P/R/F5 never trigger native find/print/reload in the Tauri
    Windows build.
  - A CJK candidate commit never submits a prompt.
  - Tab from the composer never lands on an invisible element.

### P1: DC parity, 3 days

| Task | Files | Days |
|---|---|---|
| 1.1 **Chat and account switching.** D1–D4 with repeat. `when`: the chat list has items. Chat switching uses the visible order of the current filter/category. Account switching goes through the existing account-switch path (it doesn't bypass the isolation guards). Also D10 (Ctrl+M), D11 (Mod+,), D18 (type-to-focus, fine pointer only). | `app/js/app.js`, `ui.js`, `keybindings.js` | 0.75 |
| 1.2 **Search keys.** D5 Mod+F (sidebar search), D6 Mod+Shift+F (in-chat search), D16 Esc, D17 Enter/↓, D41 ↓ into lists. In-chat search: Enter / Shift+Enter for next/prev hit (more in P4.2). | `app/js/app.js:2793-2848, 2960-2998, 2850+` | 0.5 |
| 1.3 **Composer keys.** D15 PageUp/Down scroll history, D21 Mod+↑/↓ reply target (caret-boundary rule), D22 ↑ edit last own message (empty composer only), D23 Esc cancels reply/edit. | `app/js/chat-view.js` (composer block ~2559) | 0.75 |
| 1.4 **App keys.** D7 Mod+N new chat (Tauri / standalone PWA), D14 F5 → `maybe_network` + toast, D39 scoped Mod+A (K7). | `app/js/app.js`, `rpc-core.js:239-244` | 0.25 |
| 1.5 **Lightbox keys.** D32 ←/→ across the open chat's media (order from the history model), D33 Mod + = / − / 0 zoom. | `app/js/ui.js:1073-1170` | 0.5 |
| 1.6 **Send-on-Enter default** (K5). Coarse pointer → off, fine pointer → on, an explicit user choice always wins. Matching `enterkeyhint` (native-elements §10). An inline hint under the composer the first time. `aria-keyshortcuts` on Send, the search buttons and New chat. | `app/js/chat-view.js:2559-2568`, `ui.js:615, 836-840`, `index.html:168-173` | 0.25 |

- **Risks.**
  - Alt+↑/↓ collides with ⌥↑/↓ caret movement on macOS: apply the
    first/last-line rule.
  - Chat switching while a render storm is in flight: use the same
    `openChat` path as a click, which is already storm-safe.
  - ↑-to-edit must skip messages that can't be edited (non-text, other
    people's).
- **Acceptance.**
  - Every "missing" or "conflict" row in §3.3 tagged P1 works in the
    Tauri desktop build (Windows, Linux, macOS) and in Chrome PWA standalone.
  - In a browser tab, the tab-safe alternatives work.
  - The help dialog lists them all.
  - On Android with a soft keyboard, Enter inserts a newline by default.

### P2: Roving focus, message actions, announcements, 5 days

| Task | Files | Days |
|---|---|---|
| 2.1 **`app/js/roving.js`.** One tab stop per widget, ↑/↓/Home/End (←/→ for horizontal toolbars and chips). The active item is keyed by a **stable ID** (`data-chat-id`, `data-msg-id`), so virtual-scroller recycling and signature re-renders restore it. If the focused row unmounts, focus moves to the nearest mounted row, not `<body>`. | new `app/js/roving.js` | 1 |
| 2.2 **Apply it** to the chat list, the history (rows become focusable `article`s with a composed `aria-label`), category chips, the account list, reactions and the sticker picker. Swap the hover pill for focus-visible row actions (finishes N1). Builds on WC plan 2.1 (chat rows as buttons), 2.2 (focus survives row recreation) and 2.6 (history semantics). | `app/js/app.js` (row render), `chat-view.js` (row render ~1372-1590), `main.css` | 1.5 |
| 2.3 **Message-scope bindings.** D24 Mod+E, D25 Mod+R, D26 Mod+S, D27 Mod+Shift+S, D28 Delete / ⌘⌫, D30 multiselect (Space, Shift+arrows, Mod+Space), D31 Shift+F10 / Menu key / Mod+. → context menu, with focus inside the menu (menu semantics per modal plan M5.3). | `app/js/chat-view.js:1790, 2212-2268`, `app.js:1663, 1748+` | 0.75 |
| 2.4 **"More actions" button per row** for TalkBack and VoiceOver (N13). Visible on focus and for screen readers, it opens the same menu. | `chat-view.js`, `app.js`, `main.css` | 0.5 |
| 2.5 **Announcer.** One polite `role="status"` region (the announcer from WC plan 2.6). It announces new incoming messages in the open chat (throttled, sender + first 80 chars), delivery state once, reply/edit set and cancelled, and search result counts. | new `app/js/announce.js` or WC's helper, `chat-view.js` | 0.5 |
| 2.6 **Smaller fixes.** N7 call overlay: stable DOM, update only the timer. N8 search labels and counts. N10 audio labels. N12 day and unread separators as separate items. | `app/js/calls.js:281-312`, `app.js:2793-2998`, `chat-view.js:1372-1375, 1463` | 0.75 |

- **Risks.**
  - Focus restore can scroll the history unexpectedly. Never call `focus()`
    without `{preventScroll: true}` on a re-render.
  - Rows taking focus can steal it from the composer during storms. Only
    restore focus if it was in the list before the re-render.
  - Screen-reader verbosity: tune the announcer with NVDA and TalkBack.
- **Acceptance.**
  - Tab reaches the chat list, history and composer each in one stop.
  - Arrows move within each.
  - Focus survives 100 incoming messages in demo mode.
  - Every message action can be done without a pointer.
  - axe: 0 serious/critical on the chat, list and drawer screens.

### P3: Motion, contrast, scaling, targets, 3.5 days

| Task | Files | Days |
|---|---|---|
| 3.1 **Reduced motion everywhere** (N3). One `@media (prefers-reduced-motion: reduce)` block for the 9 keyframes that aren't covered and for the drawer, modal and popover transitions. Respect it in JS scroll calls too (`behavior: "auto"`). Coordinate with modal plan M4. | `app/css/main.css`, `chat-view.js` (smooth scrolls) | 0.25 |
| 3.2 **Forced colors and `prefers-contrast`** (N4). Borders for bubbles, chips, badges and the selected row, using system colors (`Highlight`, `CanvasText`). `prefers-contrast: more` maps to the brutal theme's tokens. | `app/css/main.css` | 0.75 |
| 3.3 **Contrast fixes** (N5), per theme. Shared with WC plan 3.4. Do it there if that ships first. | `app/css/main.css` theme tokens | 0.5 |
| 3.4 **Android text scaling** (N2). Read `fontScale` in `MainActivity.kt`, pass it to the web layer (or let `textZoom` follow the system), and map it to the UI scale. Add steps 1.3/1.5/1.75/2.0 and keyboard zoom (D34). Drop `user-scalable=no` or justify it. Check reflow at 2.0 at 320 px. | `MainActivity.kt:115-136`, `app/js/ui.js:455-485`, `index.html:5`, `main.css` | 1 |
| 3.5 **Touch targets** (N9). 44 px minimum hit area using padding or `::after` hit slop, without a visual redesign. Chips at least 32 px tall. | `app/css/main.css:98-116, 206, 996-1001` | 0.5 |
| 3.6 **Bidi** (N6). `dir="auto"` on message text, previews, composer and quotes. `unicode-bidi: plaintext`. | `chat-view.js:1510, 1527`, `app.js` row render, `index.html:168`, `main.css` | 0.25 |
| 3.7 **Locale** (N11). `lang` from `navigator.language`, and `format.js` uses the same locale. | `app/js/app.js` (boot), `format.js:40-57` | 0.25 |

- **Risks.** UI scale 2.0 can break fixed-height rows in the virtual
  scroller. Row height estimates have to scale with it (check the scroller's
  height cache). Contrast changes alter the theme look, so get design
  sign-off.
- **Acceptance.**
  - With reduced motion on, nothing moves more than an opacity fade.
  - In forced colors, every state is visible.
  - All text meets 4.5:1 (3:1 for large text and UI) in every theme, per
    axe and a token script.
  - Android at system font 200% gives 200% text with no horizontal
    scrolling.
  - Every tap target is at least 44 px.

### P4: Beyond DC, 4 days

| Task | Files | Days |
|---|---|---|
| 4.1 **Unread navigation.** Alt+Shift+↑/↓ goes to the previous/next unread chat. Shift+Esc marks the chat read. Shift+PageUp jumps to the first unread message, End to the newest. | `app/js/app.js`, `chat-view.js` | 0.75 |
| 4.2 **Search hit navigation.** Enter / Shift+Enter and F3 / Shift+F3 in the in-chat search, with the hit focused and announced ("3 of 12"). | `app/js/app.js:2793-2848`, `chat-view.js` | 0.5 |
| 4.3 **F6 / Shift+F6** cycle regions (sidebar ↔ history ↔ composer). | `keybindings.js`, `app.js` | 0.25 |
| 4.4 **Mod+K palette.** Chats, contacts and actions (`>` prefix for commands), each command showing its binding. Pin, mute, archive and mark read come from the existing context-menu actions (`app.js:1748-1777`). Replaces D8/D9 without taking Mod+P. | new `app/js/palette.js`, `main.css` | 1.25 |
| 4.5 **Custom bindings.** A rebinding UI in the help dialog, with conflict detection against the registry and the reserved list, saved per device, and reset/export. | `keyboard-help.js`, `keybindings.js` | 1 |
| 4.6 **Calls.** Mod+D toggles mute, Mod+Shift+E toggles the camera, Esc minimizes (doesn't hang up). | `app/js/calls.js` | 0.1 |
| 4.7 **Android hardware-keyboard QA.** Ctrl as `Mod`, no Meta bindings, TalkBack + keyboard (Alt reserved), the Esc/BACK double-fire check. | test notes only | 0.15 |

- **Risks.** The palette overlaps search. Keep one search backend. Custom
  bindings make the docs and help dynamic, so the help reads from the live
  registry.
- **Acceptance.**
  - The palette reaches every action that has a binding.
  - A rebound key shows up in the help dialog, `aria-keyshortcuts` and
    tooltips without a reload.

### P5: Tests and guards, 2.5 days

| Task | Files | Days |
|---|---|---|
| 5.1 Unit tests for the registry: platform `Mod`, layout-independent matching (Russian layout Ctrl+F), IME guard, scope resolution, repeat policy, reserved-key conflicts. | new `tests/keybindings.test.mjs` (same style as the existing `tests/*.test.mjs`) | 0.5 |
| 5.2 Playwright keyboard suite **generated from the registry**. For each binding: set up `when`, press it, check its effect. Plus the Esc-chain and roving-focus storm tests. | new `tests/a11y/keyboard.spec.mjs` (next to modal phase M6's specs). Playwright stays a test-only dependency outside `app/`, as WC plan phase 4 says | 1 |
| 5.3 axe matrix: 4 themes × (default, forced colors, reduced motion) × 3 screens, with 0 serious/critical as the gate. The CSP bypass stays in the test browser only. | `tests/a11y/` (shared with modal phase M6) | 0.5 |
| 5.4 Target-size and contrast checks, plus a source guard: CI fails on any new `addEventListener('keydown'` outside `keybindings.js`, the composer and the allow-list. | `tests/app-source-integrity.test.mjs` (extend), `tests/a11y/` | 0.5 |

- **Acceptance.** CI runs the keyboard and axe suites on every PR to
  `master`. Adding a binding without a test fails the generated suite.

**Total: P0 3 + P1 3 + P2 5 + P3 3.5 + P4 4 + P5 2.5 = 21 days.**

### 6.7 Overlap and sequencing with the other plans

| This plan | Overlaps with | Rule |
|---|---|---|
| P0.2 Esc chain | Modal plan **M3** (stack, `closeTop`, BACK), **M1** (`<dialog>` `cancel`) | Build the Esc chain *on* M3's `closeTop()`. If M3 isn't done yet, P0.2 adds a minimal stack that M3 then absorbs. Don't build two stacks. |
| P0.3 Help dialog | Modal plan **M1** dialog helper | Use the M1 helper. Ship after M1. |
| P0.5 Enter IME guard | Modal plan **M2** (forms) | If M2 has turned the prompts into `<form>`s, only the guard is needed. |
| P1.2 Search keys | native-elements **§4** (`type="search"`, `enterkeyhint`) | Do native §4 first. It gives a native Esc-to-clear, which P1.2 builds on. |
| P1.5 Lightbox keys | Modal plan **M5.1** (lightbox as a dialog) | Same PR or right after. |
| P1.6 Send-on-Enter | native-elements **§10** (composer `enterkeyhint`) | One change. |
| P2.1–2.2 Roving | WC plan **2.1/2.2** (focusable chat rows, focus survives recreation), **2.6** (history rows focusable + roving) | P2.1 *is* the roving engine that WC 2.1/2.2/2.6 need. Do it once and mark those parts of WC done by P2. **Key conflict:** WC 2.6 suggests Alt+Up from the composer into the history, but this plan uses Alt+↑/↓ for chat switching (DC parity, D1/D2). Enter the history with Shift+Tab (one stop) or F6 (P4.3) instead, and drop Alt+Up from WC 2.6. |
| P2.3 Context menu by keyboard | WC plan **2.5** (menus with `role="menu"`), modal plan **M5.3** (menus as popover) | Menu semantics and arrow keys come from WC 2.5 / M5.3. P2.3 only adds the invoking keys and message-scope bindings. |
| P2.5 Announcer | WC plan **2.6** (announcer) | One announcer module. Whichever lands first owns it. |
| P2.6 Call overlay | Modal plan **M5.2** (call `alertdialog`) | Same PR. |
| P3.1 Reduced motion | Modal plan **M4** (motion) | M4 covers overlays, P3.1 the rest. Use one media block. |
| P3.3 Contrast | WC plan **3.4** | Do it once, in whichever plan ships first. |
| P5 Tests | WC plan **phase 4**, modal plan **phase M6** (`tests/a11y/*.spec.mjs`) | One Playwright harness, one axe matrix. |

**Recommended order:**
1. P0.4 and P0.5 plus the N1 quick win (safe, small).
2. Modal plan M1 → M3.
3. P0.1–P0.3.
4. P1, with native-elements §4/§10 and M5.1.
5. WC phase 2 together with P2.
6. P3, sharing work with WC 3.4 and M4.
7. P4.
8. P5. Its checks grow alongside each phase; the CI gate goes in at the end.

### 6.8 Cross-plan risks

- **Three plans touch the same files** (`app.js`, `ui.js`, `chat-view.js`,
  `main.css`). Land them in small PRs in the order above, and re-run the
  account-isolation and event-storm tests (AGENTS.md §7.2) after each
  one.
- **Two Esc/BACK models** if P0.2 and M3 are built separately. Treat M3's
  stack as the single source of truth.
- **Shortcut creep.** Every new binding has to go through the registry and
  the reserved-key check, or it becomes the next K3.
- **Tauri upgrade.** `tauri-plugin-prevent-default` needs Tauri ≥ 2.12. If
  the upgrade slips, use wry's WebView2 setting directly on Windows.

---

## Appendix: method and how to reproduce

- **DC Desktop:** `git clone --depth 50 https://github.com/deltachat/deltachat-desktop /tmp/dcd`
  (HEAD `e03462844e0f67c4e82994be38e17683e72d574c`, 2026-10-03). Read
  `keybindings.ts`, `KeyboardShortcutHint.tsx`, `Message.tsx`,
  `useMultiselect.ts`, `RovingTabindex.tsx`, `ContextMenu.tsx`,
  `FullscreenMedia.tsx` and `target-electron/src/menu.ts`, and grepped the
  rest for `aria-keyshortcuts`, `aria-live`, `prefers-reduced-motion` and
  `forced-colors`.
- **DC Android:** `git clone --depth 50 https://github.com/deltachat/deltachat-android /tmp/dca`
  (HEAD `847c63a94566b3ca3e9b7928a2df1b9e8d99c8f7`, 2026-10-06).
- **Velta handlers:** `rg -n "keydown|keyup|keypress|isComposing|ctrlKey|metaKey|altKey" app/ velta-app/src-tauri`.
- **Headless probe** (outside the repo):
  1. `cd /tmp/a11y && npm i playwright-core axe-core`.
  2. Serve `app/` with `python3 -m http.server 8799`.
  3. Launch system Chrome with `bypassCSP: true` in the test context only,
     and set `localStorage["velta-mock"]="1"`.
  4. Viewports: 1280×800, 412×915, 320×640, 640×400. Emulations:
     `reducedMotion: "reduce"`, `forcedColors: "active"`. Contrast comes from
     computed colors in each theme (`data-theme`).

  The script lived at `/tmp/a11y/kb.mjs` and isn't committed, by design.
- **Not tested:** real NVDA, JAWS, VoiceOver and TalkBack sessions; the
  Tauri desktop builds (WebView2 accelerators are from Microsoft's docs and
  Tauri's config defaults); Android hardware keyboards. These belong in the
  P4.7/P5 QA passes.
