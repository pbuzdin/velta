# Landing checklist — wasm patches into production `core/`

**Status:** DRAFT (Day 9, 2026-10-06). **Not green.** Nothing on this list
authorises a merge by itself; Pavel signs off the final box.

> **Production `core/` stays stock until this checklist is green.**
> "Stock" = upstream chatmail/core 2.62.x + Velta's 13 production patches
> (`python3 tools/apply-core-patches.py verify` → 13/13), with
> `core/Cargo.lock` unchanged by wasm work. Until then the wasm port lives
> only in the opt-in layer (`docs/research/wasm-patches/` +
> `tools/apply-wasm-core-patches.py apply-on-copy`) and in scratch copies.
> No `--i-know-this-writes-to-master-core` in CI, scripts or docs recipes.

Related: [patch home README](wasm-patches/README.md) ·
[spike log](wasm-core-mail-proxy-spike.md) ·
[port inventory](wasm-core-port-inventory.md) ·
[PLAN-PWA-WEBSOCKET.MD §4b](../../PLAN-PWA-WEBSOCKET.MD) ·
[COREUPDATE.md](../../COREUPDATE.md)

Legend: ✅ done on the opt-in copy (evidence linked) · ⬜ open · ⛔ blocker.
"Copy" = `apply-on-copy` workspace with the **pinned** locks.

## 0. Preconditions (decision)

- ⬜ OQ-1 in `PLAN-PWA-WEBSOCKET.MD` resolved in favour of Architecture C
  (non-custodial with addresses) — otherwise there is no reason to land.
- ⬜ C2 (worker-wasm transport in `app/js`) has a consumer ready to use the
  landed core; landing without a consumer only adds maintenance cost.
- ⬜ Decision recorded: land as cfg-gated patches in `core/` **vs.** keep the
  opt-in layer forever **vs.** upstream to chatmail/core first. Prefer
  upstream (`cfg(target_arch = "wasm32")`, track chatmail/core #8559).

## 1. Patch series hygiene

- ✅ Series is discrete, ordered, applies cleanly onto current master `core/`
  (9/9, `verify-copy` OK) — Day 6–9.
- ⬜ Every patch is `cfg(target_arch = "wasm32")`-gated or provably
  target-neutral; review lists each non-gated hunk with a reason
  (current known non-gated: 0007 `image_metadata` BufReadSeek refactor,
  0009 test call sites, Cargo target tables).
- ⬜ No spike leftovers: "spike" subjects renamed, dead stubs removed,
  `unused import` warning in `blob.rs` fixed.
- ⬜ Each patch has a WASM-CORE id + VENDORISSUES-style entry so
  `apply-core-patches.py`-style re-apply on core bumps is possible
  (or the series is converted into anchor-based blocks in that script).
- ⬜ Licensing: only MPL-2.0 patch ideas + Velta-written code; no GPL
  slothfulchat-web UI; vendored crates keep their licences/NOTICE files;
  `ws-tcp-proxy` (Unlicense) still not vendored or attributed if it is.

## 2. Lockfile / reproducibility

- ✅ Copy locks pinned under `docs/research/wasm-patches/support/locks/`
  with `PROVENANCE`; CI builds with `--locked` — Day 9.
- ⬜ Landing plan for `core/Cargo.lock`: the wasm deps (rusqlite 0.40,
  libsqlite3-sys 0.38, wasm-bindgen 0.2.129, sqlite-wasm-rs, …) **will**
  change the production lock. That diff must be reviewed as its own item:
  native crate bumps (rusqlite 0.37→0.40, libsqlite3-sys 0.35→0.38,
  hashlink) need their own native test pass and release-notes mention.
- ⬜ wasm-bindgen crate version == `wasm-bindgen-cli` in CI (derived from
  `PROVENANCE`, Day 9) and documented for local builds.
- ⬜ Pinned nightly (`nightly-2026-08-01`, needed for rusqlite `cfg_select!`)
  replaced by stable, or the nightly pin is accepted for the wasm target
  only and **never** affects Android/desktop builds.

## 3. Native parity ("stock hash parity")

Native builds must not change behaviour because of the wasm patches.

- ✅ Full `cargo nextest run -p deltachat --lib` on the copy:
  **1135/1135** (1 skipped) — Day 8.
- ✅ Avatar golden parity: copy and stock both produce `d57cb5ce…af.png`
  for `test_selfavatar_in_blobdir`; 0009 changes no golden — Day 8.
- ⬜ Same nextest run with the **landed** lock (after §2 bumps), plus
  `deltachat-jsonrpc`, `deltachat-rpc-server`, `deltachat-ffi` crates.
- ⬜ Golden / fixture hashes unchanged vs. stock across the whole suite
  (any intentional change documented per test with the cause).
- ⬜ `python3 tools/apply-core-patches.py verify` → 13/13 **after** the
  wasm series is in `core/` (the two layers coexist).
- ⬜ Android APK + Windows sidecar + `velta-core-service` build from the
  landed tree; smoke per COREUPDATE.md §2 frontend contract (RPC/event
  surface unchanged).
- ⬜ Binary-size check of native artifacts vs. previous release
  (no unexpected growth from wasm-only deps leaking into native targets).

## 4. wasm build, size, smoke

- ✅ Opt-in CI green: apply-on-copy → wasm `cargo check` → wasm-pack
  (in-repo MPL wrapper) → Playwright smoke → wasm-opt → smoke on optimized
  artifact — run 37380548362 (Day 8), re-run with pinned locks Day 9.
- ✅ Size: ~29.9 MB `--no-opt` → ~18.5 MB `wasm-opt -Os` (binaryen 120).
- ⬜ Size budget agreed (e.g. ≤ 20 MB optimized, ≤ 6 MB brotli) and CI
  fails above it.
- ⬜ wasm CI job is required (not `continue-on-error`) on the landing branch,
  still kept out of Release workflows until C2 ships.

## 5. Networking e2e

- ✅ alice→bob over local `ws-tcp-proxy` → nine.testrun.org on the
  **in-repo** wrapper built from the pinned copy — Day 9 (see spike log).
- ⬜ Repeated e2e (≥ 3 consecutive passes on different days) incl.
  wasm-opt artifact.
- ⬜ e2e against relay-native websockify (`/imap`, `/smtp` + CORS, C3) on a
  test deploy of `pbuzdin/relay`.
- ⬜ Interop: wasm client ↔ native Velta (Android/desktop) message both ways,
  Autocrypt/SecureJoin verified.
- ⬜ Persistence (OPFS) restart test; storage-eviction backup path (C4).

## 6. Review

- ⬜ Line-by-line review of the series by someone other than the author
  (agent-written patches need human review), focusing on: TLS clock
  provider, `ws_tcp` DNS/connect path, `http_wasm` fetch, blob memfs.
- ⬜ Security review: TLS stays in wasm (no proxy termination), proxy
  allowlist (never port 25), no credentials in logs, CSP
  `'wasm-unsafe-eval'` scope.
- ⬜ Upstream status re-checked (chatmail/core #8559, relay #1030) — drop
  any patch upstream already covers.

## 7. Process

- ⬜ COREUPDATE.md gains a "re-apply wasm series" step + per-bump rebase
  checklist (`refresh-lock`, nextest, golden parity, e2e).
- ⬜ Rollback plan: one revert commit restores stock `core/`; documented.
- ⬜ Pavel's explicit go-ahead recorded in the spike log / issue.

---

**Merge gate:** every ⬜ above is ✅ (or explicitly waived by Pavel in
writing with a reason). Until then: production `core/` stays stock.
