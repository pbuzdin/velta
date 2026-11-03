# Android: native chat list + history, rest in the WebView? (research)

Status: research only, 2026-11-04. No code changes. Question from Pavel: can
the Tauri Android app render the chat list and chat history natively (Kotlin,
Compose or RecyclerView) and keep every other screen in the WebView?

**Short answer:** yes, it is technically feasible, but it means building the
two most feature-dense screens a second time while the rest stays web. Do the
WebView optimisation pass first (cheap, helps desktop and PWA too). If native
is still wanted, take the screens from `velta-kmp/`, which already has a
Compose chat list and chat view on the same JSON-RPC core, rather than writing
a third implementation.

## 1. What the repo looks like today

- **Android shell:** `velta-app/src-tauri/gen/android/app/src/main/java/org/velta/`
  holds about 3.1k lines of Kotlin in roughly 24 files. `MainActivity : TauriActivity`
  (the Wry WebView), `VeltaCore` (JNI into `velta_app.so`, headless core start),
  `CoreService`, `Notifications`, `UnifiedPush*`, `VeltaLock`/`VeltaKeystore`,
  `InAppBrowser` (a second WebView overlay), `CallAudio`, `Share` and others.
  None of these are Tauri `@TauriPlugin` classes. They are app-module classes
  reached through JNI from `lib.rs` (for example `Java_org_velta_VeltaCore_startHeadless`).
  No native UI draws anything except the system prompts and the browser overlay.
- **Core:** the vendored chatmail core runs in-process as a Rust library.
  `lib.rs` holds `ANDROID_ACCOUNTS: Arc<RwLock<deltachat_jsonrpc::api::Accounts>>`.
  The UI talks JSON-RPC 2.0. `app/js/rpc-core.js` (2.5k lines) builds
  `{jsonrpc, id, method, params}` lines and sends them through the Tauri `rpc`
  command (`lib.rs` `async fn rpc`, `send_rpc` → `write_rpc_tx`). Events come back
  as Tauri events. On Android the shell owns `get_next_event_batch`
  (`get_event_reader_mode` = `"rust"`). There are about 155 `#[tauri::command]`s.
- **Chat list:** `renderChatList()` in `app/js/app.js` (~line 2319). The list is
  not virtualised. The first `CHAT_ITEM_FULL_ROWS = 40` rows mount as full
  `<velta-chat-item>` custom elements. All other rows mount as fixed-height ghost
  divs, and an IntersectionObserver upgrades them as they come into view
  (#44: 301 full rows took ~85 ms and 210 KiB). Data comes from one bulk RPC.
- **Chat history:** `app/js/chat-view.js` (6k lines). It uses
  `vendor/virtual-scroller.js` with an estimated height of 48 px and a
  prerender margin of 3 viewports, plus a 120-row rendered-row LRU. Pages are
  40 messages (`rpc-core.getMessages` = `get_message_ids` once (cached), then
  `get_messages` for the page, then `_hydrateServicePeople`).
  `_renderMsgItem` runs from line 2267 to about 3986, so roughly 1.7k lines build
  one row: bubbles, quotes, reactions, link previews, media, webxdc, calls,
  invite and article cards, mentions, read markers and thread counts.
- **Existing native client:** `velta-kmp/` is a Kotlin Multiplatform + Compose
  client (issue #192, P4/P5). It has its own JSON-RPC bridge (`native/rpc-shim`,
  a JNI `.so` that starts the core and serves JSON-RPC on loopback) and
  `RpcClient`/`RpcModels`, plus a chat list, a chat view, a composer, quotes,
  reactions and media in about 1.8k lines of UI. This matters a lot for this
  question, because it is already a native implementation of exactly these screens.

## 2. What Tauri 2 offers on Android

- **Kotlin plugins:** a class extending `app.tauri.plugin.Plugin` with
  `@TauriPlugin`. `@Command` methods are callable from JS and Rust, and
  `load(webView)` receives the WebView. Commands run on the main thread, so
  heavy work must move off it.
  https://v2.tauri.app/develop/plugins/develop-mobile/
- **Native view next to the WebView:** nothing in Tauri does layout for you,
  but the plugin has the `Activity` and can `addView` into `android.R.id.content`
  as a sibling of the WebView. The official barcode-scanner plugin does this, and
  so does a Compose example:
  https://github.com/ensombl/tauri-plugin-rekognition-liveness
- **Plugins load after `TauriActivity.onCreate`.** Early activity setup still
  belongs in `MainActivity`, which Velta already customises:
  https://github.com/tauri-apps/tauri/issues/14695
- **Multiple activities:** Tauri 2 supports more activities on mobile, each one
  a `TauriActivity` with its own WebView:
  https://v2.tauri.app/learn/mobile-multiwindow/
  An open PR adds webview or activity context to plugin invokes:
  https://github.com/tauri-apps/tauri/pull/16193
- **Sharing the core:** no Tauri API exists for this. It is plain JNI into the
  same `.so`. Velta already does this (`VeltaCore`), so a
  `external fun rpcCall(json: String): String` plus an event callback is a
  small Rust addition over the existing `Accounts` handle.

## 3. Architecture options

**(a) Native overlay or fragment over the WebView.** A Compose or RecyclerView
layer is added as a sibling of the WebView in the same activity and shown for
the list and history routes. The WebView stays alive underneath for everything
else.
- Pros: one activity, one WebView that never reloads, and web screens open
  instantly behind the overlay.
- Cons: two layers fight over insets, IME, back and focus. TalkBack sees both
  trees unless you toggle `importantForAccessibility`. The composer is part of
  the history screen, so it either goes native too (more duplication) or stays
  as a web strip under a native list (awkward IME handling).

**(b) Native activity that hosts the WebView for the remaining screens.**
A native `MainActivity` shows list and history, then starts a `TauriActivity`
for settings, profile, webxdc and calls.
- Pros: clean ownership of back stack and insets.
- Cons: a second WebView boots its page cold (seconds on low-end phones), or
  you keep one alive in the background. Tauri state and plugins are per webview.
  This option also changes the most of today's app lifecycle (lock overlay,
  foreground service handoff, intents for share and notifications).

**(c) Compose root with the WebView inside Compose (`AndroidView`).** The
activity's content is Compose. The Tauri WebView is reparented into an
`AndroidView` and shown for the web routes.
- Pros: one navigation model (Compose Navigation), shared theming and insets,
  and the WebView survives route changes.
- Cons: reparenting Wry's WebView is not supported and needs care (the
  existing `findWebView` hack shows the WebView is created by Tauri, not by us).
  The Compose runtime adds roughly 3–5 MB to the APK.

If going native, (c) is the best long-term structure and (a) is the cheapest
spike. Avoid (b).

## 4. How native code would reach the core

1. **Preferred:** a JNI `rpcCall(request)` / `rpcEvents(callback)` pair into the
   existing in-process `Accounts` (the same path as `fn rpc`). No socket and no
   second core. The events reader must fan out to both the WebView and the
   native listener, because today the shell owns `get_next_event_batch`.
2. Reuse `velta-kmp`'s `RpcClient` + `RpcModels` (commonMain) on top of that
   transport. They already parse chatlist entries and messages.
3. Do not start a second core (for example the loopback `rpc-shim`) inside the
   Tauri app. The core holds a lock on the accounts dir.

## 5. Navigation and state handoff

- A single route owner: native decides list, chat or web. Web screens get
  opened by a command (`openWebRoute("settings")` or `location.hash`).
- State that both sides need: the selected account, the active chat id, drafts,
  the unread or "read up to here" marker, the selection, the search query and the
  app-lock state. The core already holds most of this (drafts, the selected
  account, the fresh count). UI-only state (scroll position, local hidden chats,
  the queued local-chat tray, `localStorage` settings such as chat appearance)
  has to move into the core config or be synced over a bridge.
- Back: one `OnBackPressedDispatcher` owner. Today `MainActivity` re-enables
  WebView-history back, and that must route to whichever layer is on top.
- Deep links and notification taps (`onNewIntent`) must land in the native
  layer first.

## 6. Theming

- `app/css/main.css` holds about 134 custom properties. Themes: dark (default),
  `html[data-theme="light"]`, and brutal (see `design/experiment-soviet-brutalism.html`).
  `docs/design-tokens.html` documents them.
- Port: generate a Kotlin `VeltaTokens` object (colours, radii, spacing, type
  scale) from the CSS with a script, so the two sides cannot drift. Map it onto
  a Material 3 `ColorScheme` plus custom extras (bubble in/out, name colours,
  day chip). `velta-kmp/.../ui/Theme.kt` is a starting point.
- WCAG AA: the CSS comments record measured contrast pairs (for example brutal
  `#d7d7de` on `#2a2a35` at 9.9:1). Re-check every pair on the native side with a
  unit test that computes contrast from the generated tokens. Font scaling: the
  web side owns its zoom (`ui-scale.js`, the text-zoom fix in `MainActivity`), so
  native must follow the same user scale and honour Android `fontScale` too.

## 7. What gets built twice

Chat list: avatars and initials colours, pins, mute, archive link, unread and
mention badges, last-message preview with drafts and "You:", delivery ticks,
search, category tabs, local chats and the queued tray, diagnostics chat, the
relay status line and long-press menus.

History: text with markdown, bare links, hashtags and **mention chips**; quotes
and **reply threads with reply counts** plus the thread panel; **reactions**
(chips and picker); **link previews**; **article cards** (`article.js`);
**invite cards** and language cards; **webxdc rows** (icon, name, summary, open);
the **call chip** and group-call card; images, video, GIF, sticker, audio and
voice players (`media-park` decoder recycling); files, Lufi large files and
attachment crypto; day chips, the unread separator and the read marker; edit,
delete and info; selection mode; the go-down button; scheduled messages;
service messages; the composer (drafts, attachments, mention autocomplete,
recording, edit and quote preview). Every new web feature then has to land in
both places.

## 8. Performance to expect

- Native lists (LazyColumn or RecyclerView) keep scrolling at 60/120 fps with
  thousands of rows and need much less memory than DOM rows. Expect smoother fast
  scroll and faster chat open on low-end devices, where the WebView pays for
  style recalculation and layout.
- Not gained: core and RPC time (the same `get_messages` calls), image decode
  (it moves, it doesn't disappear) and cold start (the WebView must still boot for
  the other screens).
- Measure before deciding: `_openStats` (`firstPaintMs`, `vsUpdates`,
  `heightChanges`) already exists in `chat-view.js`. Capture Perfetto or Chrome
  DevTools traces on a low-end device with 300 chats and a 5k-message chat.

## 9. Risks

- Feature drift and double maintenance (the biggest risk).
- Two UIs with one event stream means duplicate side effects (mark-seen,
  notifications, typing) unless one side is clearly in charge.
- IME, insets and back bugs at the native/web boundary. TalkBack order across
  two trees.
- Wry/Tauri upgrades breaking WebView reparenting or overlay tricks.
- Security parity: app lock overlay, `FLAG_SECURE`, the encrypted attachment
  paths and the in-app browser trust rules must cover native screens too.
- Desktop, PWA and Android diverge. Tests (the e2e harness drives the web UI)
  no longer cover Android's main screens.

## 10. Cheaper first step: optimise the WebView screens

Hotspots found in the code:

1. **Message rows are heavy, and too many are prerendered.** `_renderMsgItem`
   (~1.7k lines) builds every row through `innerHTML` plus listeners. The
   scroller prerenders 3 viewports (~30 extra rows) with a 48 px height estimate,
   so media rows cause repeated `onItemHeightDidChange` relayouts. Fixes: margin
   1–1.5; better height estimates per viewtype (cache measured heights by msg id
   in the LRU); reserve media aspect ratio from `dimensionsWidth`/`Height` before
   load; delegate events on `listEl` instead of per-row listeners.
2. **Chat list is not virtualised.** Every chat beyond 40 is still a DOM node
   (a ghost div), and each `ChatlistChanged` re-walks every child and compares
   `chatItemUpToDate`. Fixes: real windowing for the list (the same
   virtual-scroller), or at least `content-visibility: auto;
   contain-intrinsic-size: <row height>` on the ghosts and full rows; coalesce
   chat-list events into one rAF; update only the changed `ChatlistItemChanged`
   rows.
3. **Polling and refetch churn.** `startLive()` refetches the tail every 20 s
   (2 RPCs + a remap of 40 messages; every 5th tick rebuilds all ids), and
   `onMsgsChanged` refetches pages on each event. `getMessages` also runs
   `_hydrateServicePeople` per page. Fixes: rely on events (the poll is only a
   self-heal; stretch it to 60 s or more and skip it while events are flowing);
   diff by id and only re-render rows whose signature changed (`_rowSigCache`
   exists, so make sure the event path uses it).

Also: `content-visibility: auto` is not used anywhere. The CSS comment near
`main.css:626` forbids it on message rows because of clipping, but it is safe on
chat-list rows and off-screen panels. Make sure images use `loading="lazy"` and
`decoding="async"` (only a few occurrences today), and give thumbnails decoded
size limits. Check animation and `backdrop-filter` cost (4 uses) on low-end GPUs.
Pre-warm the WebView in `VeltaApp`.

Effort: about **1–2 weeks**, and it benefits Android, desktop and the PWA.

## 11. Phased plan, if going native

0. Baseline: a trace harness and numbers (chat open, scroll jank %, memory) on 2
   devices. 2–3 days.
1. JNI RPC + event fan-out in `lib.rs`, plus reuse of the `velta-kmp` models.
   About 1 week.
2. **Chat list only**, native (option (a) as a spike, then (c)). Tap opens the
   existing web chat view. Tokens generator, themes and the a11y check.
   About 3–4 weeks.
3. **Measure** against the baseline. Stop here unless the gains are clear.
4. **History**, read-only rows first (text, quotes, reactions, media), then cards
   (link preview, article, invite, webxdc, call), then composer and selection.
   Unsupported rows fall back to "open in web". About 8–12 weeks.
5. Parity hardening, TalkBack and e2e coverage. 2–3 weeks.

Total about **4–5 months** for one developer to reach full list + history parity,
and then ongoing double cost for every chat feature. Reusing `velta-kmp` Compose
code could cut phases 2 and 4 by roughly a third.

## 12. How the Delta Chat apps split it

- **Delta Chat Android** is fully native Java (RecyclerView, the classic
  Signal-derived UI) with the core over JNI. Only webxdc runs in a WebView. It
  gives smooth lists but needs a separate team to keep parity with desktop.
- **Delta Chat Desktop** is a web UI (React in Electron or Tauri) talking JSON-RPC to
  the same core, which is the same split as Velta's web UI.
- Neither ships a hybrid native list + web screens. Each platform picks one UI
  stack, and parity costs a full second client. A hybrid gets that cost for two
  screens and also a boundary to maintain.

## 13. Recommendation

Don't start a hybrid now. First spend 1–2 weeks on the WebView hotspots above
and measure on a low-end phone. If the list or history still janks, go native
for the chat list only (phase 2), reusing `velta-kmp`'s Compose screens and RPC
models over a JNI bridge to the in-process core, and decide on history after
measuring. Longer term, choose one of two paths: Tauri with web UI everywhere,
or `velta-kmp` as the full native Android client. A permanent half-and-half
doubles the work on the screens that change most.
