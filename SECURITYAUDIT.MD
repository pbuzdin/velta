# Security Audit — Mimosa Deep Scan

- **Scan date:** 2026-10-01
- **Scope:** `C:\Users\pave\Velta` (full repository)
- **Tool:** Mimosa security scan, depth `deep` (mimosa 0.1.0), static analysis only, no runtime execution
- **Scan ID:** `scan-2026-10-01T06-57-48.525Z-7fe6d128b0cb`
- **Seal:** `sha256:f65bee0e5ab809f861f098ead2ae1f74dc8dcec636a8fc53baf2d19de0038390`
- **Run status:** `inconclusive` — verdict effect `none`
- **Artifacts:** `C:\Users\pave\.mimosa\security-scans\project-f43d6f8841d3fe7c55a572d4\scan-2026-10-01T06-57-48.525Z-7fe6d128b0cb\` (`scan-manifest.json`, `findings.json`, `coverage.json`, `report.md`)

## Executive summary

The scan emitted **2,738 raw static findings (1,264 high / 1,472 medium / 2 low)** but self-assessed as
**`inconclusive` with partial coverage and zero validated findings**. Every finding carries the
`static-finding` evidence state, and the tool's own report states that static advisories require human
confirmation of the real data flow and exploitability. This document is a faithful summary of a
first-pass static sweep — **it is not an audit verdict, and no "secure / insecure" conclusion is drawn.**

Roughly 92% of the volume (2,506 findings) comes from `test-rig/edge-profile/` — a checked-in Edge
browser profile whose bundled extension code and jQuery/Sizzle internals were scanned as if they were
product code. That is fixture noise, not Velta code. The slices that actually touch Velta are small
and are detailed below.

## Coverage & limitations (why `inconclusive`)

- Threat-model phase produced **0 entry points / principals / authorization surfaces** (status: partial).
- Call graph is **partially incomplete** (dynamic dispatch and analysis-scale limits; cross-file
  reachability may be missing).
- Deep-mode business-logic review found **0 candidates**.
- Validation phase **investigated 0 findings** (0 queries) — nothing was triaged or confirmed.
- Path analysis covered 2,002 functions / 3,230 call edges, 0 full traces.

## Dependency risk summary

- 901 packages scanned.
- Offline advisory database matched **1 package against 1 advisory** (4 packages unresolvable offline).
- The job result does not name the matched package and the sealed artifacts contain no CVE/GHSA/RUSTSEC
  identifiers, so the match was identified by running `cargo audit` (RustSec DB) against both shipped
  lockfiles on 2026-10-02 — results in the triage section below.

## Findings by area

| Area | High | Medium | Low | Total |
|---|---:|---:|---:|---:|
| `test-rig/edge-profile/` (browser-profile fixture) | 1,208 | 1,298 | – | 2,506 |
| `velta/app/` (Velta UI) | 34 | 121 | – | 155 |
| `debug-memleak/served-app.js` (dev tool) | 6 | 51 | – | 57 |
| `velta/core/` (vendored Delta Chat core) | 11 | 2 | 2 | 15 |
| root/test-rig dev servers | 4 | – | – | 4 |
| `velta/tools/` | 1 | – | – | 1 |
| **Total** | **1,264** | **1,472** | **2** | **2,738** |

### `test-rig/edge-profile/` — 2,506 findings (fixture noise)

An Edge browser profile with an installed third-party extension
(`kagpabjoboikccfdghpdlaaopmgpgfdc/2.70.0.35_0`, `api.v1.js`–`api.v5.js`) is committed under
`test-rig/`. Scanning it produces dominated-by-library hits: "$ is a command-injection entry" (609),
jQuery/Sizzle internals (`css`, `curCSS`, `buildFragment`, `adjustCSS`, `matcherFromTokens`, …) flagged
as command-injection sinks, plus per-file "code injection" / "command injection" labels. None of this
is Velta product code. Practical impact: it buries real findings (~30× noise amplification) and bloats
every future scan.

### `velta/app/` — 155 findings (34 high / 121 medium) — the code that matters

**High (34):**

- 31 are "X is an SSRF entry" heuristic flags on plain JSON-RPC wrappers in `velta/app/js/app.js`
  (`getContact`, `deleteChat`, `acceptChat`, `checkQr`, `secureJoin`, `importBackup`, `forwardMessages`,
  `leaveGroup`, …). These label functions as taint entry points; they are **not** demonstrated
  SSRF paths.
- 2 worth genuine triage: **`handleDeeplinkFromUrl` reaches a command-injection sink in one hop**
  (`velta/app/js/app.js:2730` and `velta/app/js/app.js:3922`). Deeplink input is attacker-influenced,
  so this deserves a manual look.
- 1 worth genuine triage: **`query` flagged as a SQL-injection entry** (`velta/app/js/app.js:3650`).

**Medium (121):**

- 72 "suspected cross-file taint" (`疑似跨文件污点`).
- XSS-entry flags on the modal system: `showModal` (17), `confirmModal` 1-hop (11), `addStep` (7),
  `acquireCode` (4), `pickContactModal` (3), `showInvite` (3), and single hits on `askText`,
  `openEphemeralDialog`, `openMuteDialog`, `showProgressModal`. Consistent with the app's known
  `unsafeHTML` usage; unvalidated by the scanner.

### `velta/core/` — 15 findings (11 high / 2 medium / 2 low) — vendored test & build tooling

All inside the vendored Delta Chat core's dev tooling, not the runtime attack surface:

- `deltachat-rpc-client/src/deltachat_rpc_client/pytestplugin.py:330,376` — `eval` code execution (test plugin).
- `deltachat-repl/src/main.rs:307,476` — path traversal, 2 hops (REPL tool).
- `deltachat-rpc-server/npm-package/index.js:83` — untrusted command-argument vector.
- `deltachat-rpc-server/npm-package/scripts/src/make_package.py:32`, `python/src/deltachat/_build.py:66,94`,
  `scripts/set_core_version.py:35,60,120` — path traversal in packaging/build scripts.
- `api.rs:1881,1884` — suspected cross-file taint (medium).
- `pytestplugin.py:82`, `python/src/deltachat/testplugin.py:323` — insecure randomness (low, test plugins).

### Dev-only servers — ~61 findings

- `serve-no-cache.js:7` and `test-rig/serve.js:16` — path traversal in localhost static file servers.
- `test-rig/bridge.js:6`, `test-rig/rpc-client.js:1` — command injection (high).
- `debug-memleak/served-app.js` — 57 findings, including URL input reaching `child_process` via
  `Tokenized-Card/tokenized-card.bundle.js`.

Local development tools only; not part of the shipped app.

## Recommended next steps

1. ~~Triage `handleDeeplinkFromUrl` → command-injection~~ **Done 2026-10-02 — false positive** (see triage section).
2. ~~Triage the `query` SQL-injection entry flag~~ **Done 2026-10-02 — false positive** (see triage section).
3. ~~Shrink scan noise~~ **Done 2026-10-02** — `test-rig/edge-profile` moved to
   `C:\Users\pave\fixtures-out-of-scan\edge-profile`, fully outside the scan root
   `C:\Users\pave\Velta`. (A first move to `Velta\fixtures-out-of-scan\` left it inside the scanned
   folder — the 2026-10-02 rescan `scan-2026-10-02T02-30-52.229Z-729c29af5a56` still showed 2,506
   fixture findings until the second move.)
4. ~~Identify the matched dependency~~ **Done 2026-10-02** — `cargo audit` run against both shipped
   lockfiles; `h2` and `rustls` upgraded in the core-service lockfile, remainder recorded as accepted risk.
5. Optional: re-run the scan after the fixture move and compare via Mimosa's seal/compare semantics.

## Triage verdicts (2026-10-02)

Scope policy: only **user-facing** (app UI) and **relay-facing** (transport, TLS, shipped dependencies)
issues are acted on. Everything else is recorded as accepted risk.

### User-facing surface (velta/app) — all 34 high findings cleared, no code changes needed

| Finding | Verdict | Evidence |
|---|---|---|
| 2× `handleDeeplinkFromUrl` reaches command-injection in one hop (app.js) | **False positive** | The "sink" is `RegExp.exec()` in `extractBackupLink` (app.js:2675) and `extractInviteLink` (app.js:2623) — pure regex parsers. No process exec, no `spawn`, nothing executes input. The scanner confused regex `.exec()` with process execution. |
| 1× `query` flagged as SQL-injection entry (app.js:3650) | **False positive** | The taint chain names `js/vapi-background.js` as the sink's definition — that is **uBlock Origin inside the edge-profile fixture** (`test-rig/edge-profile/.../odfafepnkmbhccpbejgmiehpchacaeak/js/vapi-background.js`). The file does not exist anywhere in the app; the scanner linked the functions by name collision. |
| 31× "X is an SSRF entry" on RPC wrappers (`getContact`, `deleteChat`, `acceptChat`, `secureJoin`, …) | **By design** | These are JSON-RPC wrappers calling the local Delta Chat core over a loopback WebSocket (127.0.0.1). Localhost RPC to the app's own core is the app's core transport, not server-side request forgery. |

### Relay-facing surface (shipped Rust) — cargo audit 2026-10-02

`cargo-audit v0.22.2` (RustSec DB) against both shipped lockfiles:

**`velta-core-service/rust/Cargo.lock` — 9 vulnerabilities found, 2 fixed:**

- **Fixed (lockfile-only, semver-compatible `cargo update`):** `h2` 0.4.15 → 0.4.19
  (RUSTSEC-2026-0258, unbounded empty DATA frames) and `rustls` 0.23.43 → 0.23.45
  (RUSTSEC-2026-0285, TLS 1.3 handshake across encryption levels). Windows `cargo check` cannot
  verify (pre-existing `openssl-sys`/perl environment failure, unrelated to the bump); verification
  rides the WSL build / release pipeline on next push.
- **Accepted risk (7):** `hickory-proto` ×2 (RUSTSEC-2026-0118, -0119 — fix requires the 0.26 line),
  `rustls-webpki` ×4 (RUSTSEC-2026-0049, -0098, -0099, -0104 — fixes are in 0.103.x, but the affected
  0.102.8 copy is pinned by `iroh 0.35.0` inside vendored deltachat 2.62.0), `rsa` RUSTSEC-2023-0071
  (Marvin timing attack — no upstream fix exists), `ml-dsa` RUSTSEC-2025-0144 (fix is a 0.1.0-rc).
  All except `rsa` are rooted in the vendored deltachat/iroh dependency tree, so the upgrade path is
  the next vendored-core bump, tracked there — not a Velta patch.

**`velta-app/src-tauri/Cargo.lock` — 8 vulnerabilities, all accepted risk:** `hickory-proto` ×2,
`rustls-webpki` ×4, `ml-dsa`, `rsa` (same advisory IDs as above; same vendored-tree root, same
upgrade path). Warnings (unmaintained `instant`/`paste`/`proc-macro-error`/`unic-*`, unsound `lru`,
yanked `chacha20`) are recorded but not acted on.

### Accepted risk — outside the user/relay-facing scope (per project policy)

- `serve-no-cache.js:7` and `test-rig/serve.js:16`: real path traversal in localhost-only dev file
  servers (no root containment check / `startsWith(ROOT)` prefix bypass). Not in any git repo, not
  user/relay-facing.
- `test-rig/bridge.js:6` command-injection flag: false positive — static `require` path; `spawn` uses
  a hard-coded sidecar constant.
- 11× high in `velta/core`: vendored Delta Chat test/build tooling (pytest `eval`, packaging-script
  path traversal) — not shipped runtime code.
- `debug-memleak/served-app.js` (57 findings): a saved debug snapshot of the app, same false-positive
  classes as above.

---

*Generated from the sealed Mimosa scan artifacts listed above. Findings marked `static-finding` are
unvalidated static alerts; exploitability must be confirmed manually before acting on any individual item.*
