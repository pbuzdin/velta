# VENDOR-REVIEW.MD — fit assessment: elena + virtual-scroller

Review date: 2026-10-02. Scope: the two UI libraries Velta vendors,
`app/vendor/elena.js` (@elenajs/core 1.0.1) and
`app/vendor/virtual-scroller.js` (catamphetamine/virtual-scroller, DOM
build). Companion to VENDORISSUES.MD, which holds the per-issue evidence;
this file answers the broader questions — are the two libraries the right
tools for what Velta does, and what should be improved in them (upstream)
or around them (locally).

---

## 1. elena (@elenajs/core 1.0.1, vendored 2026-08-18, 7.8 KB minified)

Upstream: github.com/arielsalminen/elena (monorepo, `packages/core`).
192 stars, last push 2026-08-03, single-maintainer project. We are on the
latest published version (1.0.1, 2026-07-27); there is nothing to upgrade
to. The vendored file carries zero local patches.

### What Velta actually uses

Four leaf components, all in `app/js/components.js`: `VeltaAvatar`,
`VeltaVideo`, `VeltaChatItem`, `VeltaChatHead` (contacts rows in
`app.js:1131` reuse `<velta-avatar>`). The API surface consumed is four
exports: `Elena(HTMLElement)`, `static props`, `html`, `unsafeHTML`.
Importantly, the two hottest render paths in the app do NOT go through
Elena: the message list (`chat-view.js` hand-renders rows into its own
VirtualScroller) and the chat-list row bodies (assembled as HTML strings
via `unsafeHTML`). Elena renders the avatar tiles, the video card, and the
row/heading wrappers around those strings.

### Fit verdict: good, and deliberately small

Elena is doing the job we gave it: a ~8 KB zero-dependency base class for a
handful of leaf components, with reactive attribute props and tagged-template
HTML. It is not load-bearing for chat performance — the message history never
touches it, and the chat list only uses it as a component shell around
hand-built strings. Its worst real cost (below) is measured in one leaf
component's render path, not in any list. Escape cost is also low: four small
classes, one API surface — if Elena stalled, porting to plain custom elements
with `innerHTML` + a tiny props helper is under a day. Small-maintainer risk
is therefore acceptable for the role it plays.

The one architectural rule to keep: do not grow Elena's role into the message
list. `chat-view.js` intentionally renders rows by hand (string/DOM), and the
library's re-render mechanics (next section) would make per-message Elena
components a measurable regression.

### Library findings — what can be improved in elena

All of these were confirmed against the minified vendored source, and all are
upstreamable. None is fixed locally except by convention or workaround.

**E1. Every re-render re-parses the full template via `innerHTML` — no
parsed-template cache, no clone fast path.** The re-render path re-assembles
the template string, runs it through `innerHTML` on a fresh `<template>`, and
diffs the parsed children against the live tree; the cache (`t.D/t.I`)
stores the assembled *string*, not parsed content. The file contains no
`importNode`/`cloneNode`/`content.cloneNode()` fast path at all. Consequence:
any component that re-renders pays a full HTML-parse + tree-diff every pass,
and `unsafeHTML` values additionally re-parse their string each time
(`avatar.js:168` records this as the 🐴 ceiling). Upstream fix (the classic
lit-style shape): cache `template.content` per template-strings identity and
render by cloning it, diffing clones; cache parsed `unsafeHTML` fragments per
raw value. This is the single most valuable improvement in the library.

**E2. The re-render diff deletes hydrated children of nested custom
elements.** The diff compares live children against a freshly parsed
template clone — but a custom element inside a parsed (unhydrated) template
is bare, so a diff pass deletes the component's rendered children and leaves
it connected but empty. We work around this with the "self-heal" block in
`VeltaAvatar.connectedCallback` (`components.js:33-40`): detect
`childElementCount === 0` and delete Elena's render caches to force a full
first-render. That is a correctness bug papered over in user code, and it
will bite every future Elena component nested inside another Elena
component's `html` template — which is exactly our chat-list pattern.
Upstream fix: make the diff hydrate-aware (skip custom-element subtrees it
did not render, or re-create and hydrate them). Recorded as VENDORISSUES #8.

**E3. Attribute coercion dispatches on `typeof` of the declared prop
default; `null` default routes string attributes through `JSON.parse`.**
Already recorded as VENDORISSUES #3 (hit in practice with `VeltaAvatar`'s
`addr`). Upstream fix is two lines: guard `value !== null && typeof value ===
"object"`, and treat unparseable strings as the raw string instead of warning.

**E4. A prop with no declared default produces a warning "once per instance
on every render"** (see the `addr` comment, `components.js:22`). Warning spam
as a nudge toward declaring defaults is unhelpful in list components that are
re-created per render. Upstream fix: warn once per class (a module-level
Set), and don't warn at all for props intentionally defaulted at the
call site. Recorded as VENDORISSUES #9.

### Recommendations for elena

1. Keep vendoring as-is; stay on 1.0.1. No local patches to maintain.
2. File E2 and E4 into VENDORISSUES.MD — done 2026-10-02 (#8, #9).
3. Upstream PR candidates, ranked by value/effort: E3 (two lines), E2
   (correctness, medium), E1 (perf, larger — propose as an issue first with
   the avatar repaint numbers), E4 (trivial).
4. Keep the rule: Elena for leaf components only; message list stays
   hand-rendered.

---

## 2. virtual-scroller (catamphetamine, vendored 2026-08-18, 80 KB minified UMD)

Upstream: gitlab.com/catamphetamine/virtual-scroller, DOM build
(`virtual-scroller-dom`), latest release 1.16.4 (2026-03-07, last repo
activity 2026-05-16). The vendored file has no inline version string; it was
vendored 2026-08-18, after the last upstream activity, so it is
latest-or-near-latest (all options we pass — `getPrerenderMarginRatio`,
`onItemHeightDidChange`, `preserveScrollPositionOnPrependItems` — exist in
the vendored build). One local patch (`__vsZoom`, applied 2026-09-19 in
1.4.14).

### What Velta actually uses

Two instances: the chat history (`chat-view.js:1167` — keyed rows via
`getItemId`, 48 px estimate, prerender ratio 3, `onItemHeightDidChange`
bridged from the `velta-row-resized` event so late-reporting media rows keep
the layout math fresh) and the contacts side view (`app.js:1148`). Message
history prepends ride `preserveScrollPositionOnPrependItems`. This is the
library doing the app's heaviest work: windowed, keyed, prepend-safe chat
history on both Android WebView and WebView2, under interface-scale zoom.

### Fit verdict: good — right tool, correctly integrated

Windowing is mandatory for chat histories and the library provides exactly
the features we rely on (keyed diffing so rows survive re-renders, estimated
heights with correction, post-mount height changes, prepend position
preservation). Replacing it with a hand-rolled virtualizer is not warranted:
our two known bugs are understood, one is already patched locally, and the
integration glue (row-resize bridge, scroll restoration) is ours, not the
library's. 80 KB minified (~20 KB gzipped) is immaterial next to the app
bundle.

### Library findings — what can be improved in virtual-scroller

**V1. Layout math mixes zoom-scaled and unscaled coordinate spaces under CSS
`zoom`.** Blank lists at interface scale ≠ Normal on Android and desktop
Chrome. Patched locally since 1.4.14: the `__vsZoom()` block at the top of
the vendored file divides the four `getBoundingClientRect()`-derived
measurements by the root zoom so all math runs in local pixels
(VENDORISSUES #1 has the full evidence and the upstream fix sketch: read
`getComputedStyle(root).zoom` and normalize, or measure via
`offsetTop`/`offsetHeight` chains). **This is the highest-value upstreamable
fix in either library** — any web app with a zoom/UI-scale feature hits it,
and we already ship the reference implementation.

**V2. `ignoreScrollEvents` is dead code — programmatic scrolls are
indistinguishable from user scrolls.** `Scroll.scrollToY` sets the flag and
clears it synchronously; scroll events dispatch async, so the guard never
holds (VENDORISSUES #2). Mostly harmless, but it makes scroll-position
restoration unpredictable — relevant to Velta's open scroll-restore work
(issue #18 area). Upstream fix: clear the flag from the scroll listener, or
compare `getScrollY()` against the requested value.

**V3. No inline version in the vendored UMD.** Not a bug — a hygiene gap
that cost us an archaeology pass this review. Two-sided fix: upstream, emit
the version into the UMD banner; locally, stamp the vendored version + date
into the header comment when vendoring (do this at the next re-vendor; also
stamps elena for symmetry).

### Recommendations for virtual-scroller

1. Keep the vendored file and the `__vsZoom` patch; re-apply on any
   re-vendor (VENDORISSUES header already warns this).
2. Upstream PR candidate: V1, with our `__vsZoom` diff as the reference.
   Second candidate: V2 (small, clear). V3's local half costs one comment
   line.
3. No replacement, no fork. If upstream ever goes quiet while a zoom-adjacent
   bug appears, the fallback is carrying the patch, which we already do.

---

## 3. Our-side follow-ups surfaced by this review (not library bugs)

- E2 (self-heal hack) and E4 (warn spam) filed into VENDORISSUES.MD as
  #8/#9 (2026-10-02); ledger now covers every elena workaround we carry.
- Stamp vendored version + date in both vendor file headers at next touch.
- The chat-list string-assembly pattern (`unsafeHTML` row bodies containing
  nested `<velta-avatar>`) is what triggers E2 and the avatar re-parse
  ceiling. If profiling ever flags chat-list renders: build rows as DOM with
  real `<velta-avatar>` elements instead of strings — that removes the
  re-parse and the diff bug in one move, without waiting on upstream.
- Known our-side scroller debt stands (not re-litigated here): prepends do
  not update `msgIndex` (search-jump heuristic works around it), tail-window
  follow-ups from the PR #17 review.

## 4. Bottom line

Both libraries suit Velta's needs. Elena is deliberately scoped small (leaf
components only) and stays out of the hot paths; its improvements are
upstream quality fixes, not fit problems. Virtual-scroller does the heavy
lifting well; its one serious bug is patched locally and is also its best
upstream contribution. Neither should be replaced, and Elena's role should
not grow into the message list.
