# VENDORISSUES.MD — vendored-code issues and upstream candidates

Issues we found in third-party code that Velta vendors or depends on. Each
entry records the evidence, the local workaround, and what an upstream fix
(or pull request) would look like. If you upgrade a vendored file, re-check
every entry marked "patched locally" — our patches are not carried upstream
and will be silently lost if the file is replaced.

---

## virtual-scroller (vendored `app/vendor/virtual-scroller.js`)

Upstream: catamphetamine/virtual-scroller (`virtual-scroller-dom` build,
minified UMD, no inline version — check `git log` for the vendoring date).

### 1. Layout math mixes coordinate spaces under CSS `zoom` (blank lists)

**Status: patched locally (the `__vsZoom` block at the top of the vendored
file) — re-apply when re-vendoring.**

`getBoundingClientRect()` returns zoom-scaled (visual) pixels, while
`scrollTop` / `offsetHeight` / `clientHeight` and the CSS pixel values the
scroller writes into its spacer paddings are unscaled (local) pixels. The
scroller measures item heights with the former and computes the visible
window with the latter, so inside a `zoom`ed subtree every layout pass mixes
two units. Observed with Velta's interface scale (CSS zoom on `<html>`):

- `paddingTop`/`paddingBottom` computed from rect heights render
  double-zoomed (rect px applied as CSS px inside the zoomed subtree again).
- Scrolling to the bottom of a deep history can land the viewport entirely
  inside the inflated bottom spacer — the chat renders blank (reproduced on
  Android at Interface scale ≠ Normal, and on desktop Chrome with a long
  mock history).
- Spurious `[virtual-scroller] Item index N height changed unexpectedly: it
  was X, but now it is Y` warnings whenever the zoom factor changes between
  measurements of the same row.

**Evidence:** `vendor/virtual-scroller.js` — `getNthRenderedItemTopOffset`,
`getNthRenderedItemHeight`, `ItemsContainer.getHeight` and
`getItemsContainerTopOffset` all read `getBoundingClientRect()`, while
`ScrollableContainer.getHeight` uses `offsetHeight` and
`ScrollableContainer.getVisibleAreaBounds` uses `scrollTop + getHeight()`.
Minimal repro: render a list taller than one viewport inside
`<div style="zoom: 1.15">`, scroll to the bottom, observe the viewport land
in the bottom padding.

**Local fix:** the vendored file defines `__vsZoom()` (computed `zoom` of
`document.documentElement`, defaulting to 1) and divides the four
rect-derived measurements by it, so all layout math runs in local pixels.
Upstream fix sketch: same normalization (read `getComputedStyle(root).zoom`),
or measure items with `offsetTop`/`offsetHeight` chains so rect values are
never involved.

### 2. `ignoreScrollEvents` never suppresses anything (race, minor)

**Status: report-only. No local workaround needed so far.**

`Scroll.scrollToY` sets `this.ignoreScrollEvents = !0`, performs the
programmatic scroll, and resets the flag to `undefined` — synchronously:

```js
{key:"scrollToY",value:function(e){this.ignoreScrollEvents=!0,
 this.scrollableContainer.scrollToY(e),this.ignoreScrollEvents=void 0}}
```

Scroll events dispatch asynchronously, so by the time `onScrollListener`
checks `!n.ignoreScrollEvents` the flag is already cleared: the guard is
dead code, and every programmatic scroll (initial position, prepend
corrections) is handled as if the user had scrolled. Mostly harmless — the
"scrolled far away → re-layout" path even papers over issue 1 in short
lists — but it makes scroll-position restoration unpredictable and looks
like an unintended async-ordering bug. Upstream fix: reset the flag from the
scroll listener (one-shot) instead of synchronously, or compare
`getScrollY()` against the requested value.

### 18. A viewport past the last measured row paints item 0 (blank history)

**Status: patched locally — re-apply when re-vendoring.**

When the height walk finishes and no measured row meets the viewport
(scroll resting in the estimated bottom spacer, or clamped into the
padding while a full rerender has detached the rows), stock
`getShownItemIndexes` returns null. The caller then paints only item 0
and warns `The list is supposed to be visible but no visible item has
been found`. Scroll stays at the bottom, so the screen is empty padding.
Sending a message does this: `setItems` rebuilds the rows, and one smooth
scroll to `scrollHeight` can stop in that spacer.

Prerender margin is one viewport (`getPrerenderMarginRatio` is hardcoded
to 1). Rows that end exactly where the viewport starts still count as
found, so the tail is rendered above the fold and nothing pins scroll
onto it.

**Local fix** in `getShownItemIndexes` / the layout pass:

- A hit whose top is at or below the visible bottom, or a finished walk
  with nothing on screen, returns a tail window through the last item
  with `snapToEnd`.
- After the last-item walk, if the shown window's bottom is at or above
  the visible top (`getBeforeItemsHeight(last + 1) - verticalSpacing <=
  visible.top`), return that same tail window and `snapToEnd`. A window
  that still intersects the viewport is left alone, and an unmeasured
  batch returns before this check.
- Layout calls `scrollToY(1e9)` after `updateState` when `snapToEnd` is
  set. The browser clamps that to the real end.

**Caller side** (not inside the vendored file): a near-bottom send calls
`_scrollBottomSettling()` rather than one smooth `_scrollBottom()`.
`onMsgUpdated` calls `onItemHeightDidChange` after `replaceWith`, because
the scroller measures the current list child. Notifying before the swap
keeps the old height; the next scroll then redoes layout. The same notify
follows a link-preview image, a group-call card swap, and the audio
failure box. Tests: `tests/virtual-scroller-tail.test.mjs`,
`tests/chat-msg-update-hardening.test.mjs`.

---

## elena (vendored `app/vendor/elena.js`, @elenajs/core 1.0.1)

### 3. A `null` prop default makes attribute values go through `JSON.parse`

**Status: worked around by convention (never declare a prop default as
`null` — see AGENTS.md §11). Upstream PR is a two-line fix.**

Elena decides how to coerce an attribute by `typeof` of the declared prop
default. `typeof null === "object"`, so a prop declared with a `null`
default routes every attribute value through the `JSON.parse` branch —
plain string attributes then log `Invalid JSON: …` warnings and coerce to
junk. Hit in practice with `VeltaAvatar`'s `addr` field (fixed by
declaring a string default; AGENTS.md §11 records the rule).

**Evidence:** `elena.js` attribute coercion —

```js
case"object":case"array":if(!s)return s;try{return JSON.parse(s)}catch{…}
```

— the switch is driven by the default's `typeof`. Upstream fix: guard with
`value !== null && typeof value === "object"` (and ideally treat
unparseable strings as the raw string rather than warning).

### 8. Re-render diff deletes the hydrated children of nested custom elements

**Status: worked around locally (the "self-heal" block in
`VeltaAvatar.connectedCallback`, `app/js/components.js:33` — re-check on
any elena re-vendor).**

Elena's re-render path re-parses the template string via `innerHTML` and
diffs the parsed children against the live tree. A custom element inside a
parsed template is bare (unhydrated — its connectedCallback has not run), so
the diff pass sees the live component's rendered children as extra nodes and
deletes them, leaving the element connected but empty. Triggered by
Velta's chat-list pattern: `<velta-chat-item>` / `<velta-chat-head>`
templates contain nested `<velta-avatar>` elements, so every re-render of a
row can strip its avatar. The self-heal block detects
`childElementCount === 0` and deletes Elena's render caches (`this.D`,
`this.F`) to force a full first-render on the next pass.

**Evidence:** `elena.js` re-render —

```js
…i=e.L.reduce(…).replace(/>\s+</g,"><").trim(),r=S();r.innerHTML=i,w(t,r.content.childNodes)…
```

— `w()` walks the freshly parsed (bare) clone against the live tree. Any
future Elena component nested inside another Elena component's `html`
template hits the same deletion. Upstream fix: make the diff hydrate-aware —
skip custom-element subtrees the template did not render itself, or
re-create and wait for hydration instead of pruning their children.

### 9. A prop with no declared default warns once per instance on every render

**Status: worked around by convention (declare a default for every prop —
extends the AGENTS.md §11 rules). Trivial upstream fix.**

A prop absent from the declared defaults (or without a literal default)
makes Elena log a warning on every render of every instance. In list
components that are re-created per render (`velta-avatar` in chat-list rows)
this is warning spam, not a signal. Observed with `VeltaAvatar`'s `addr`
(comment at `app/js/components.js:22`).

**Evidence:** `elena.js` render path warns when a prop value is `undefined`
against the expected-defaults table, once per instance per pass. Upstream
fix: warn once per class (module-level `Set` of warned tags/props), and skip
the warning when the caller supplied the attribute — an undeclared default
is then a non-event, not an error.

---

## wry / Tauri (framework, not vendored)

### 4. Tauri init scripts throw inside opaque-origin frames

**Status: worked around (`webxdc_serve` stubs `window.__TAURI_INTERNALS__`
into the served index.html — see lib.rs).**

Tauri's own core+plugin init scripts run in every frame, including
opaque-origin sandboxed iframes where `window.__TAURI_INTERNALS__` setup
didn't happen, producing
`Cannot read properties of undefined (reading 'plugins')` console noise
(webxdc mini-app frames). Details and the workaround are in AGENTS.md §11.
Upstream fix: skip (or guard) init scripts when `origin` is opaque.

### 5. Android WebView drops `target="_blank"` links

**Status: worked around (chat-view routes message links through
`plugin:opener|open_url` on Android).** Known wry limitation; filing an
upstream issue mainly helps tracking — a `setSupportMultipleWindows`
escape hatch would be the ask.

### 6. WebView2 media requests bypass custom-protocol interception

**Status: worked around (`app/js/media.js` keeps the loopback HTTP media
server running as the fallback path).** Chromium/WebView2: an `<img>` boot
probe proves custom protocols work, but media elements bypass the
interception for the same scheme — so media can never ride the
`blobfile:` protocol even when images can. Upstream (Chromium) issue; the
probe/fallback ladder in `media.js` documents the behavior.

---

## jsQR (vendored `app/vendor/jsQR.js`)

No issues found; vendored as a fallback for Android WebViews that ship no
`BarcodeDetector` (or one whose `detect()` hangs — see `qr-scan.js`).

The file is the upstream webpack dist build minified with
`esbuild --minify --target=es2015` (257 KB -> 131 KB, ~46 KB gzipped). Re-minify
the same way when updating; verified by decoding generated QR codes.

---

## Delta Chat core (vendored `core/`, upstream chatmail/core)

Re-vendor note: every Velta core change is an op in the quilt
`tools/apply-core-patches.py` (live: #10 -> velta#163, #11 -> velta#164, #12 -> velta#165, #13 -> velta#166, #14 -> velta#167, #15 -> velta#168; #16 extends #15, #17 -> velta#175, #18 -> velta#176; retired: #7) and
re-applies mechanically — `apply`, then `verify` and `tree-check --fetch`
must pass (COREUPDATE.md §0; CI `core-patches.yml` enforces both). Hand
edits to `core/` that are not quilt ops are lost on re-vendor — exactly how
#12 and #13 silently vanished in the 2.63.0 re-vendor (2aac743, v1.4.64).

### Upstream status (assessed 2026-10-29)

None of the core patches are implemented upstream, and the trackers
(#163–168, #175, #176) have no upstream comments. The one proposal that got
a real conversation — per-transport server metadata (#15/#16), filed as
upstream issue chatmail/core#8857 — was **closed**: hpk42 stated the
upstream trajectory for multi-relay is "fully automatic, where core
determines to replace failing relays, adds new relays", with API exposure
gated on Delta Chat's UX lead; link2xt doubted exposing that metadata level
but acknowledged a need for structured JSON connectivity output (Parla, the
GTK client, currently parses Velta's connectivity HTML reports). Velta's
upstream PRs — core #8182 (Iroh 1.0) and relay #1061 (iroh-relay 1.0
co-hosting) — are open with no reviews, each blocked on the other.

Upstream is nonetheless converging with several diagnoses, solving them
automatically instead: 2.64 switches transports after send rejections
(`smtp_failure`, the automatic cousin of #11's user pin), 2.66 removed
`configured_addr` (the auto-relay trajectory; #11 survives via its
`ui.velta.send_transport` re-key), and 2.65/2.66 refactored
`background_fetch_any`, markseen (one transaction) and scheduler start-waits
— the same latency territory as #12/#17/#18 without the lock-across-interrupt
bug fix.

Working posture: carry the quilt as the product differentiator (four
re-vendors 2.63→2.66 applied all ops clean); escalate #12/#17/#18 upstream
as small PRs rather than issues (issues went unanswered, and those diffs are
minimal with no API surface); reframe #15/#16 as the connectivity-JSON need
Parla shares; re-check #11/#16 assumptions whenever upstream's automatic
relay replacement lands.

### 7. Recoding an animated WebP strips its animation (static JPEG out)

> **RETIRED at core 2.63.0 (2026-10-09):** upstream chatmail/core **#8777**
> (merged 2026-10-09 as 81140d51, "do not reencode animated WebPs into
> JPEG") landed the fix natively — the real
> WebP decoder's `has_animation()` gates the recode, animated non-avatar
> images return byte-exact, and animated avatars are deliberately flattened
> (stricter than our header sniff, which skipped recoding unconditionally).
> The patch ops are removed from `tools/apply-core-patches.py` and the
> unfiled draft `docs/upstream/0001-*.patch` is deleted; do not re-add.

**Status (historical): patched locally (`core/src/blob.rs` —
`is_animated_webp()` early
exit in `check_or_recode_to_size`; re-apply on every core upgrade, the call
site is the `Velta patch` block right before the `ImageReader`
construction). Kept through 2.62.0.**

`check_or_recode_to_size()` decodes every Image-viewtype attachment with the
`image` crate when it exceeds the media-quality byte limit or carries Exif,
then re-encodes as JPEG. The `image` crate decodes only the first frame of an
animated WebP, and JPEG has no alpha — so a large (or Exif-carrying) animated
webp sent as a photo arrives as a static, opaque JPEG. Upstream knows: the
recode block carries a TODO about lost animation/transparency.

Patch: before the decode, sniff the first 4 KiB of the container; a
RIFF/WEBP header containing an `ANMF` chunk (animation-frame chunk, only
present in animated webps) returns the blob unchanged — byte-exact send,
animation and transparency intact. Static webps keep the normal recode path
(Exif stripping, downscale). Trade-off: an animated webp above the byte limit
stays above it (chatmail's own size ceiling still applies server-side), and
Exif metadata is not stripped from animated webps.

Upstream fix: handle animation (or at least skip recoding for formats the
`image` crate cannot re-encode losslessly) inside
`check_or_recode_to_size()` — then drop this patch.

### 10. The SMTP loop's bound transport is not exposed to clients (#79)

**Tracker: pbuzdin/velta#163.**

**Status: patched locally (`core/src/smtp.rs` + `core/src/scheduler.rs` +
`core/src/scheduler/connectivity.rs` — all blocks carry the `Velta patch
(#79)` marker; quilt ops "#10 …"). Since 2.63.0 upstream #8797 resets
`transport_id`/`from` in `disconnect()` itself, so the op there only clears
the shared handle. Pinned by `test_velta_disconnect_clears_sending_transport`
in `smtp_tests.rs`.**

The SMTP loop tries every configured transport on (re)connect (newest first)
and uses whichever connects, but `configured_addr` is only re-elected when a
transport is REMOVED — and nothing tells clients which transport actually
won. UIs that mark "the sending relay" (Velta's envelope) key off
`configured_addr` and lie during failover. Upstream direction: selection is
"moving to the authority of the SMTP loop" (chatmail/core#8619).

Patch: `Smtp` carries a shared `sending_transport: Arc<AtomicU32>` set on
connect success and cleared in `disconnect()`; `SmtpConnectionState` clones
the handle out of the loop-owned connection; `get_connectivity_html` emits
`<span class="smtp-via">{addr}</span>` in the Outgoing-messages `<li>` when
a transport is bound. Velta's `parseConnectivityHtml` reads it and keys the
envelope/dashes to it (`relaySmtpVia`), falling back to `configured_addr`
for unpatched cores. Upstream fix: expose the bound transport properly
(e.g. an RPC or event per chatmail/core#8619) — then drop this patch.

> **Upstream status (2026-10-10):** feature request chatmail/core **#8798**
> ("Client-facing signal for which SMTP transport actually sent a message")
> is open; a maintainer asked for the use case (2026-10-06) and Pavel
> answered (user-facing "Sent via <relay>" + delivery debugging); no API
> agreed yet. Removal series: #8619/#8705/#8703/#8709/#8797 merged, **#8771
> merged 2026-10-06 and shipped in 2.63.0** (most recently successful SMTP
> transport first), **#8711** ("refactor: remove ConfiguredAddr") still an
> open draft; umbrella #8572. When a core carrying the #8798 API ships, port
> Velta's consumer (`relaySmtpVia`) to it and drop this patch.

### 11. "Use for sending" does not pin the sending transport (core/src/smtp.rs)

**Tracker: pbuzdin/velta#164.**

**Status: patched locally (quilt ops "#11 …", `core/src/smtp.rs` +
`smtp_tests.rs`). Re-keyed 2026-10-10** from `configured_addr` to the
Velta-owned ui key `ui.velta.send_transport`, because upstream **#8711**
(open draft) deletes `Config::ConfiguredAddr` — the old patch read it in
`sorted_transports()` and would stop compiling, and the JS wrote it.

Upstream 2.63 `Smtp::connect_configured()` tries transports in
`sorted_transports()` order — most-recent-SMTP-success first (#8771),
insertion id as tie-break. Nothing lets the user choose; Pavel's
requirement: "I need to select relay for sending myself."

Patch:
- `VELTA_SEND_TRANSPORT_KEY = "ui.velta.send_transport"` holds the chosen
  transport's addr (`ui.*` = stored verbatim via `get_ui_config`, per
  device, not synced). Unset/empty/unknown addr = no pin.
- `velta_pin_first()` moves the pinned transport to the front of
  upstream's order (`upstream_sorted_transports()`, body unchanged).
- Dead-pin backoff: `Smtp::velta_connect_failed` remembers connect failures
  (in memory, cleared on success); a pin that failed within
  `VELTA_PIN_BACKOFF` (5 min) goes second, behind the most recently
  successful transport — at most one connect timeout per window instead of
  one per reconnect (the regression #8771 fixed for unpinned cores).
- Return to the pin: if a live connection is on another transport and the
  pin is not backing off, `connect_configured` disconnects so the next
  connect tries the pin first (also makes a fresh pin take effect on the
  next send).
- From: 2.63 renders queued mail with the bound transport's addr
  (2.64: `Connection.from`), so From follows the pin/failover. JS keeps writing
  `configured_addr` on cores that have it (self-contact/"primary" address,
  core-side validation) and ignores "unknown key" after #8711.

Core 2.64.0 (2026-10-20): upstream switches transport when the server
rejects a send (`record_failure` → `smtp_failure` row, disconnect; d766641ce)
and moved `transport_id`/`from`/`last_success` into `smtp::Connection`.
Decision (Pavel, 2026-10-20): **the pin must not override an active
failure.** Op "#11 send rejection backs the pin off" puts the transport in
`velta_connect_failed` on Permanent/Transient SMTP errors (same 5-min
`VELTA_PIN_BACKOFF`), so the next connect uses upstream's fallback and the
"live connection yields to the pin" step does not pull it back. The pin is
retried when the backoff expires, or earlier if the fallback cannot
connect; a successful send on it clears `smtp_failure`. After a restart the
in-memory map is empty, so `velta_seed_send_failure()` starts a fresh
backoff if the pin still has an `smtp_failure` row.

Tests: `test_smtp_candidates` (upstream, unpinned order unchanged),
`test_velta_pinned_send_transport`, `test_velta_pin_backoff`,
`test_velta_pin_yields_to_send_failure` (2.64) in
`smtp_tests.rs`; JS contract in `tests/send-relay-pin.test.mjs`. Drop when
upstream grows a first-class preferred-transport API.

### 12. A push wake-up waits out a dead IDLE socket (core/src/context.rs)

**Tracker: pbuzdin/velta#165.**

**Status: patched locally (quilt op "#12 …"). Originally 78df479 (#42/#25
P8); dropped by the 2.63.0 re-vendor (it was a hand edit), restored
2026-10-10.** `Context::background_fetch` interrupts IDLE and waits for the
fetch; on a half-open socket (NAT timeout, Doze freezer) the read blocks up
to `net::TIMEOUT` (60 s). Patch: bound `wait_for_work_done` at 10 s, then
`restart_io_if_running()` and wait again, so the wake-up reconnects on fresh
sockets. Upstream fix: a bounded fetch / stale-session detection in
`background_fetch`.

2026-10-28: the restart runs in a spawned task. `Accounts::background_fetch`
wraps the call in a timeout (Velta: 15 s), the restart starts at 10 s and
its stop can take 30 s, so the timeout dropped it between stop and start
and left IO stopped (chat list frozen until a manual core restart).

### 13. Push-token registration is invisible to the UI (core/src/imap.rs)

**Tracker: pbuzdin/velta#166.**

**Status: patched locally (quilt op "#13 …"). Originally f133237 (1.4.29);
dropped by the 2.63.0 re-vendor, restored 2026-10-10.**
`Session::register_token` only logs. Patch: emit `EventType::Info`
("Transport N: push notifications registered — …") on SETMETADATA success
and `EventType::Warning` ("… relay did not accept the push token …") on
failure; the Diagnostics chat (app.js, rpc-core Info/Warning → diagnostic)
shows them. Upstream fix: a structured push-registration status API.

#110 (2026-10-15): the event texts now carry the relay addr (`Transport N (addr): …`, via a `velta_transport_addr` SELECT on `transports`) so the Relays modal can show a "(U)" mark per relay.


**Tracker: pbuzdin/velta#167.**

#14 (2026-10-22): reply-thread queries for the chat view's "N replies" chip and
thread overlay: `get_reply_counts(account_id, chat_id)` (quoted msg id -> reply
count, one GROUP BY over `mime_in_reply_to`) and `get_reply_ids(account_id,
message_id)` (reply ids, oldest first). jsonrpc-only for now — the wasm surface
needs the same two methods when the PWA picks the feature up. Until a core
build ships them, the chat view falls back to exact counts over the loaded
window only (chip hidden while older pages are unloaded).
2026-10-22 follow-up: both the replies and the quoted message are scoped to
`chat_id` (`AND quoted.chat_id=?`), the SQL is a Rust `\`-continued literal
(no embedded whitespace runs), and the chat.rs op anchors on the
`/// Returns true if device message…` doc line so that comment stays on
`was_device_msg_ever_added`. `get_reply_ids` also takes `chat_id`. No index on
`mime_in_reply_to`: it would need a migration/dbversion bump inside the
vendored core (collides with upstream's numbering on re-vendor); the query is
a per-chat scan through the existing chat_id index. UI: docs/reply-threads.md.
2026-10-22 fix (Android report: no counts in a group): incoming replies store
the raw `In-Reply-To` header (`<id@host>`) while `rfc724_mid` is bare, so the
join matched none of them; and every message carries In-Reply-To (the chat's
latest message), so plain messages after a parent would count as replies.
Both queries now match `TRIM(mime_in_reply_to, '<> ')` and require a quote
param (`q`) on a non-forward (no `a`) row.

### 15. Relay capabilities are invisible to clients (core/src/transport.rs)

**Tracker: pbuzdin/velta#168.**

**Status: patched locally (`core/src/transport.rs` +
`core/deltachat-jsonrpc/src/api.rs` +
`core/deltachat-jsonrpc/src/api/types/login_param.rs` — quilt ops "#15
…").**

The scheduler already fetches per-transport IMAP METADATA on every connect
(`/shared/vendor/deltachat/turn`, `/shared/vendor/deltachat/appversions`,
the iroh relay URL) and caches it in `context.metadata`, keyed by transport
id — that is how calls get their TURN credentials and push decides whether
to write a device token. None of it is exposed: a UI cannot show which of
the user's relays supports calls, push, iroh or (by probing) the C3 web
endpoints. cmcall detects the same TURN signal behaviorally by placing a
real call; a UI needs the static capability, not a measurement.

Patch: `Context::get_server_metadata()` joins the `transports` table
(id -> addr) with the metadata cache and returns, keyed by the transport's
email address: `iroh_relay`, `supports_push`, `has_turn` (true only when
the metadata carried a REAL `UnresolvedIceServer::Turn` — the core
fabricates fallback STUN servers when metadata is missing, and those are
not call support), `app_versions`, `comment`, `admin`. jsonrpc
`get_server_metadata(account_id)` wraps it for the UIs (camelCase JSON);
the Relays modal renders one-letter flags per relay row (C/I/P/W, silver =
not offered / not known yet, green = advertised). Transports the scheduler
has not connected to yet are absent — the UI shows "not known yet" rather
than "not offered".

Upstream fix: a public per-transport server-metadata accessor (or folding
the fields into `list_transports`) — then drop the patch. Proposed upstream
as chatmail/core#8857; **closed 2026-10** — hpk42: multi-relay is heading
"fully automatic", exposure gated on DC's UX lead; link2xt doubted exposing
this level but wants structured JSON connectivity output (Parla parses the
HTML reports). Reframe there if retried.

### 16. IDLE / COMPRESS / recipient limit per relay are invisible to clients (core/src/imap.rs, transport.rs)

Extends #15. `update_metadata` (runs after every IMAP connect) records the
session's IDLE and COMPRESS=DEFLATE capabilities into `ServerMetadata`
(`velta_can_idle` / `velta_can_compress`, `None` until the first
connection); `get_server_metadata` returns them as `canIdle` /
`canCompress` plus the already-parsed `maxSmtpRcptTo`
(`/shared/vendor/deltachat/maxsmtprecipients`). The relays modal shows D
(instant delivery) as a flag and the limit/compression in the details
line. Quilt ops `#16 …` in tools/apply-core-patches.py; must stay after the
#15 ops (anchored on their inserted text). The wasm copy inherits it (the
wasm series applies on top of the quilted core). Same upstream picture as
#15 (chatmail/core#8857 closed; see the upstream-status note above). Drop
when upstream exposes
per-transport capabilities.

### 17. `maybe_network` holds the account manager lock across interrupts (deltachat-jsonrpc/src/api.rs)

**Tracker: pbuzdin/velta#175.**

**Status: patched locally (quilt op "#17 …", 1.4.85).** Upstream fix: interrupt outside the accounts lock in `maybe_network`.

`maybe_network` awaited every scheduler interrupt while holding
`accounts.read()`. An IO restart (push/background fetch patch #12, proxy
change) holds the scheduler lock while tasks stuck on a dead proxy wind down
(`Scheduler::stop` waits up to 30 s per task). A `start_io`/`stop_io` writer
queued behind that reader then blocked every other RPC (tokio's RwLock is
fair), so `get_chat`/`get_messages` stalled until the UI's 30 s RPC timeout:
chat switching "did nothing" on Android after a send. The op clones the
contexts under the lock and interrupts after releasing it.

### 18. Scheduler interrupts wait behind an IO restart (core/src/scheduler.rs)

**Tracker: pbuzdin/velta#176. Status: patched locally (quilt ops "#18 …").**
`SchedulerState::interrupt_{inbox,smtp,ephemeral_task,location,recently_seen}`
awaited `inner.read()`. An IO stop/restart holds `inner.write()` while the
IMAP/SMTP tasks wind down (30 s each, more over a dead proxy). The lock is
fair, so `send_msg` (chat.rs) and `markseen_msgs` (opening a chat) queued
behind it: `rpc timeout: send_msg`, and chats would not open. Patch: use
`try_read()` and skip when a start or stop holds the lock. A starting
scheduler fetches and sends on its own, and a stopping one would ignore the
signal. Upstream fix: non-blocking interrupts.

**Follow-up (#181 harness):** `interrupt_inbox_idle` (behind `maybe_network`
and background fetch) and `maybe_network_lost` still awaited `inner.read()`;
`tests/core-stall/stop_io_stall.py` showed `maybe_network` blocked for the
whole IO stop. Two more ops ("#18 interrupt_inbox_idle …", "#18
maybe_network_lost …") switch them to `try_read()`.

### 19. Admin groups (port of ArcaneChat/core; chat.rs, receive_imf.rs, securejoin.rs, qr.rs, …)

**Tracker: pbuzdin/velta#177. Status: patched locally (quilt ops "#19 admin groups …", 46 ops, 12 files incl. tests).**
Port of ArcaneChat/core c9b9666 ("add group with admin"), a2683e9 ("allow
admins to remove messages from others") and 9aa16dc ("ignore pinned messages
changes from non-admins"); same wire format, so Velta ↔ ArcaneChat interoperate.
The group ID is `ADMINFINGERPRINT:randomid`; the admin is the contact whose key
fingerprint is the prefix. Every receiving core enforces: member add,
removing others (self-leave stays allowed), name/description/avatar,
ephemeral timer and pins only from the admin; delete-for-everyone of others'
messages only by the admin; an admin grpid creating a group from a non-admin
is ignored. Invites carry the base id in `x=` and the name in `z=` (stock
clients see a plain contact invite); a non-admin aborts the securejoin.
jsonrpc: `create_group_with_admin`, `FullChat.groupAdminId`.
Deviations from ArcaneChat (security): `validate_group_id` requires a 40/64
hex fingerprint (ArcaneChat accepts an EMPTY prefix, which made `get_admin_contact_id`
match address contacts with an empty fingerprint); admin delete-for-everyone
is limited to messages of that same admin group, and the request must carry
that group's ID (ArcaneChat's a2683e9 let ANY member delete ANY message in
regular groups, and it checked the trash chat's grpid so admin deletes never
matched on 2.66); `delete_msgs_ext` keeps the own-messages check for
non-admins instead of commenting it out; no broadcast secret on creation.
Rust tests: `test_velta_*` in chat_tests.rs / tools_tests.rs. Plan, interop
with stock Delta Chat and limits: docs/core-patches/admin-groups-plan.md.
Single admin only (the creator); multiple admins need a new header that
ArcaneChat would ignore.

### 20. Database encryption at rest: keyed open (core/src/accounts.rs)

**Tracker: pbuzdin/velta#178. Status: patched locally (quilt ops "#20 keyed …", 3 ops, 1 file).**
Upstream deprecated db encryption (chatmail/core#7403) but 2.66 still ships
`Context::open`/`change_passphrase` on SQLCipher. `Accounts` however always
opened with an empty passphrase (`load_accounts`, `add_account`), so an
encrypted dc.db stayed closed and a fresh one was created plaintext. The ops
read `VELTA_DB_KEY` (raw SQLCipher key `x'<64 hex>'`) and open with it when
set — existing encrypted databases unlock, fresh ones are encrypted at
creation, and a wrong key returns `Ok(false)` (account closed, never an
error). Unset env keeps upstream behavior byte-for-byte, so the wasm build
and stock rpc-server users are unaffected. The velta-app desktop shell
generates the DEK into the OS keychain and migrates plaintext databases
BEFORE the core opens anything (`velta-app/src-tauri/src/db_key.rs`:
desktop passes the key to the sidecar's env, Android sets it in-process
with the DEK from AndroidKeyStore via org.velta.VeltaKeystore); the
guard test `test_velta_keyed_open_roundtrip` rides the quilt and fails to
compile if a core bump removes `Context::open`. Plan and phases (Android
Keystore, PWA snapshot encryption): docs/security/db-encryption-plan.md.

### 21. IO start/stop for all accounts holds the account manager write lock (deltachat-jsonrpc/src/api.rs)

**Tracker: pbuzdin/velta#181. Status: patched locally (quilt ops "#21 …").**
`start_io_for_all_accounts` / `stop_io_for_all_accounts` awaited each
scheduler start/stop under `accounts.write()`. `Scheduler::stop` waits up to
30 s per IMAP/SMTP task, and every other RPC takes `accounts.read()` in
`get_context`, so `get_chat`, `get_message_ids` and
`get_chatlist_items_by_entries` hung for N × 30 s (the UI's 30 s chat-open
timeouts). A start queued behind a stop held the same lock. The op clones
the contexts under a short read lock and starts/stops them with no lock
held (stops in parallel). A test hook, `VELTA_TEST_STOP_IO_DELAY_MS`
(no-op when unset), stretches `Scheduler::stop` so
`tests/core-stall/stop_io_stall.py` (real deltachat-rpc-server, CI
`core-patches`) reproduces the stall: before the patch 7 chat reads took
7.7 s, after it 3–4 ms. Upstream fix: no `Accounts` lock across IO
start/stop.
