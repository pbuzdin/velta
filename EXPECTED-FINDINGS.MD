# Expected findings — next Mimosa scan baseline

Written 2026-10-02, after `test-rig/edge-profile` moved fully out of the scan root
(now `C:\Users\pave\fixtures-out-of-scan\edge-profile`). The 2026-10-01 scan produced
2,738 findings of which **2,506 (92%) were the checked-in Edge browser profile fixture**
(scanned third-party extension code + jQuery internals). With the fixture gone, the next
deep scan should land at roughly **230 findings** — the non-fixture remainder of the
baseline scan. This file records what those ~230 are expected to be and whether, per the
project scope policy, they touch **user-facing** or **relay-facing** surface.

Reference baselines: `scan-2026-10-01T06-57-48.525Z-7fe6d128b0cb` (seal `f65bee0e…`,
2,738 findings) and the interim rescan `scan-2026-10-02T02-30-52.229Z-729c29af5a56`
(seal `c57b6e83…`, 2,736 — the fixture was still inside the scanned folder for that run).

## Expected ~230, by area and scope

| Area | Findings | Scope per policy | Expected disposition |
|---|---:|---|---|
| `velta/app` (the shipped UI) | ~155 (34 high / 121 medium) | **User-facing** | All 34 highs already triaged as false positives or by-design (see SECURITYAUDIT.MD triage ledger): 2× `RegExp.exec()` misread as process exec, 31× "SSRF entry" labels on localhost JSON-RPC wrappers. The ~121 mediums are the `showModal`/`confirmModal`/`addStep` "XSS entry" heuristic class plus "suspected cross-file taint" — unvalidated sink labels with no demonstrated sink. Expect the cross-file taint subset to shrink further now that the uBlock Origin fixture (the false taint source) is out of the scan. |
| `velta/core` (vendored Delta Chat) | ~15 (11 high / 2 medium / 2 low) | **Mostly neither** | 13 of 15 sit in vendored test/build tooling (pytest `eval`, packaging-script path traversal, insecure randomness in test plugins) — accepted per policy. The 2 `deltachat-jsonrpc/src/api.rs` mediums are runtime code adjacent to the relay RPC surface — the only relay-facing flags expected here; unvalidated taint labels, no demonstrated path. |
| `debug-memleak/served-app.js` (dev snapshot) | ~57 (6 high / 51 medium) | **Neither** | A saved debug copy of the app; same false-positive classes as `velta/app` (SSRF labels on RPC wrappers, cross-file taint into bundles that aren't in the tree). Local tooling, accepted. |
| root/test-rig dev servers | ~4 high | **Neither** | `serve-no-cache.js` / `test-rig/serve.js` path traversal (real bugs, localhost-only rigs, accepted), `bridge.js` static-require false positive. |
| `velta/tools` | ~1 high | **Neither** | `generate-icons.py` path traversal in a build script; accepted. |
| **Total** | **~232** | | |

## Direct answers

**Are the expected findings related to user interactions?**
The largest block (~155, all in `velta/app`) targets the user-facing surface, yes — but
none of it is a confirmed user-facing issue: the highs are verified scanner artifacts and
the mediums are unvalidated "entry point" labels on functions that render already-escaped
content. Nothing new is expected to need action.

**Are they related to relay interactions?**
Only marginally: the 2 `api.rs` runtime mediums (relay RPC surface) and — outside these
counts — the dependency advisories already tracked in issue **#55** (iroh-pinned
`rustls-webpki`/`hickory-proto`, `ml-dsa`, `rsa` Marvin), which is where all relay-facing
work is recorded. The relay *transport* code itself (`transport.js`, connectivity, sending
dashes) appears in the findings only as the localhost-RPC "SSRF" labeling class.

**What would make the next scan differ from ~230?**
New/changed code since 2026-10-01 (category bar, swipe, relay chips — all UI additions
that could add a handful of heuristic labels); removal of the uBlock/fixture cross-file
name collisions (should *lower* the app count); and Mimosa's own line-number drift on
edited files. Treat any large NEW cluster with a real sink as the signal worth triaging —
not the total.

As before: static findings are unvalidated alerts, the scans remain `inconclusive` /
partial-coverage, and no secure/insecure conclusion is drawn from counts alone.
