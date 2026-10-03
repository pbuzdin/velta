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

---

## Delta Chat core (vendored `core/`, upstream chatmail/core)

### 7. Recoding an animated WebP strips its animation (static JPEG out)

**Status: patched locally (`core/src/blob.rs` — `is_animated_webp()` early
exit in `check_or_recode_to_size`; re-apply on every core upgrade, the call
site is the `Velta patch` block right before the `ImageReader`
construction).**

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

**Status: patched locally (`core/src/smtp.rs` + `core/src/scheduler.rs` +
`core/src/scheduler/connectivity.rs` — all blocks carry the `Velta patch
(#79)` marker; re-apply on every core upgrade).**

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
