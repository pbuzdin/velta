# Landing checklist — wasm patches into production `core/`

**Status:** DRAFT (Day 9, burn-down Day 10–11, 2026-10-06). **Not green.** Nothing on this list
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
  (9/9, `verify-copy` OK) — Day 6–10.
- ✅ No spike leftovers in subjects/comments: Day 10 re-export with
  `wasm(<area>):` subjects, WASM-CORE ids and a "Native impact" line per
  patch; stale `/workspace/velta-wasm-port` path comment fixed.
- ✅ Warnings: `deltachat` lib on wasm32 **0** (was 4: unused `bail`, 3
  API-parity fns in `http_wasm.rs`); native lib+tests **0** (was 1: unused
  `sync_fs::read` re-export in `blob.rs`). Remaining warnings are in the
  vendored astral-tokio-tar only (2× `unused_braces`, upstream code — also in
  stock 0.6.4; Day 11 re-check after the rebase: still 0 in `deltachat`).
- ✅ rustfmt: series adds **no** new `cargo fmt --check` diffs (the 5
  remaining diffs exist on stock master too — `blob_tests.rs`,
  `scheduler.rs`, `smtp.rs` — and are not ours to fix here).
- ✅ Gating audit (Day 10, table below): every non-`cfg`-gated hunk is a
  target-neutral wrapper or call-site refactor.
- ✅ Each patch has a VENDORISSUES-style entry so re-apply on core bumps is
  possible — Day 11: [`wasm-patches/VENDORED.md`](wasm-patches/VENDORED.md)
  §B (files, anchors/re-apply risk, native impact per patch; 0002 and 0007
  flagged high-churn).
- ⬜ Licensing: only MPL-2.0 patch ideas + Velta-written code; no GPL
  slothfulchat-web UI; vendored crates keep their licences/NOTICE files;
  `ws-tcp-proxy` (Unlicense) still not vendored (CI fetches it pinned).
  Day 11 audit ([VENDORED.md](wasm-patches/VENDORED.md) §A): astral-tokio-tar,
  async-imap, mail-builder keep MIT/Apache files ✅. **Open:**
  `tokio-wasm-shim` says `MPL-2.0` only in its Cargo.toml; slothfulchat-web is
  GPL-3.0-or-later overall and its README licence table does not list the
  shim; no LICENSE file in the crate → get upstream confirmation or rewrite (A1).
- ✅ `tokio-wasm-shim` rustfmt diffs (9 files) documented as imported code
  (byte-identical to slothfulchat-web `452cd0d`; left unformatted to keep
  upstream diffs clean) — Day 11, VENDORED.md §A1. Re-decide if Velta rewrites it.

### Gating audit — hunks that are *not* behind `cfg(target_arch = "wasm32")`

| Patch | Non-gated change | Native effect |
|---|---|---|
| 0001 | `deltachat-time` gains `SystemTimeTools::now()` | none (std on native) |
| 0002 | Cargo: native deps moved to `cfg(not(wasm32))` table; `rusqlite` **0.37→0.40** + `fallible_uint` | **dependency bump** — see §2 |
| 0003 | `tokio` → `tokio-wasm-shim` in ffi / jsonrpc / repl / rpc-server | facade = `pub use tokio::*` with `full` (feature superset) |
| 0004/0008 | `[patch.crates-io]` async-imap, astral-tokio-tar (=0.6.4 since Day 11), mail-builder | **vendored sources used on native too** (Cargo `[patch]` cannot be per-target) — see §2 |
| 0005/0008 | `accounts`/`context`/`imex`: `path_exists`/`path_is_dir`/`path_is_file` | wrappers call `Path::exists/is_dir/is_file` on native |
| 0007 | `Time::now()` → `tools::time_now()` (context, imap, idle, key, quota, scheduler, smtp, migrations, wal_checkpoint), ratelimit `now()` | wrapper calls `Time::now()` on native |
| 0007 | `blob`: `image_metadata` takes `BufRead + Seek`; `sync_fs` facade | target-neutral refactor; recode output byte-identical (avatar golden `d57cb5ce…`) |
| 0009 | `blob_tests` call sites | test-only |

## 2. Lockfile / reproducibility

- ✅ Copy locks pinned under `docs/research/wasm-patches/support/locks/`
  with `PROVENANCE`; CI builds with `--locked` — Day 9.
- ⬜ Landing plan for `core/Cargo.lock`: the wasm series **changes native
  builds**, so that lock diff is its own review item (Day 10 analysis via
  `cargo tree -i` on the pinned copy for x86_64-linux, aarch64-android,
  x86_64-windows):

  | Crate (native graph) | Stock | With series | Implication |
  |---|---|---|---|
  | rusqlite | 0.37.0 | **0.40.2** | API bump (`fallible_uint` for u64 ToSql); full lib nextest green on copy |
  | libsqlite3-sys (`bundled-sqlcipher-vendored-openssl`) | 0.35.0 | **0.38.2** | bundled **SQLCipher 4.6.1 → 4.14.0** (SQLite 3.46.1 → 3.51.3). Same SQLCipher 4 file format. ✅ **Day 11 upgrade + rollback PASS** on a real-schema Velta DB (dbversion 167, WAL) created by stock core, plaintext (Velta default) **and** legacy passphrase mode: 4.6.1 create → 4.14.0 open/write → 4.6.1 reopen/write → 4.14.0 reopen, `integrity_check=ok` and all rows at every hop (harness: `wasm-patches/sqlcipher-harness/`). Remaining: same test on a copied **production** Android/desktop DB (older dbversion → migrations under the new engine) |
  | hashlink | 0.10.0 | 0.12.2 | rusqlite statement cache; internal |
  | tokio | 1.53.1 | 1.53.1 (via `tokio-wasm-shim`) | facade only; shim's `registry`/`durability`/`limits` modules compile on native |
  | async-imap | 0.11.3 crates.io | 0.11.3 **vendored** | 2 files / 10 lines, all `cfg`-gated (idle timeout import) |
  | astral-tokio-tar | 0.6.4 | **0.6.4 vendored** (Day 11 rebase) | ✅ downgrade removed: vendor = crates.io 0.6.4 + 61 wasm lines; native lock now 0.6.4 + rustix 1.1.4 like stock. Ungated: `canonicalize` via `tokio::fs` (same result, blocking pool). Day 11 nextest 1135/1135 |
  | mail-builder | 0.5.0 crates.io | 0.5.0 **vendored** | 3 files / 88 lines, `SystemTime` imports `cfg`-gated |
  | wasm-bindgen / js-sys / web-sys / sqlite-wasm-rs / wasmtimer / indexed_db_futures | 0.2.100 … | 0.2.129 … | **not in native graphs** (wasm-only) |

  Native crate bumps need release-notes mention and their own native test
  pass (§3) independent of the wasm work.
- ⬜ wasm-bindgen crate version == `wasm-bindgen-cli` in CI (derived from
  `PROVENANCE`, Day 9) and documented for local builds.
- ⬜ Pinned nightly (`nightly-2026-08-01`, needed for rusqlite `cfg_select!`)
  replaced by stable, or the nightly pin is accepted for the wasm target
  only and **never** affects Android/desktop builds.

## 3. Native parity ("stock hash parity")

Native builds must not change behaviour because of the wasm patches.

- ✅ Full `cargo nextest run -p deltachat --lib` on the copy:
  **1135/1135** (1 skipped) — Day 8; re-run Day 10 (hygiene) and Day 11
  (astral-tokio-tar 0.6.4 rebase): **1135/1135, 1 skipped, 0 warnings**.
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
- ⬜ Size budget agreed and enforced. **Proposal (Day 10)**, measured on the
  Day-9 pinned wasm-opt artifact (`-Os`, binaryen 120):

  | Encoding | Day-9 bytes | MiB | Proposed budget | Headroom |
  |---|---|---|---|---|
  | raw (wasm-opt `-Os`) | 18 524 339 | 17.67 | **20 000 000** | ~8 % |
  | brotli `-q 11` | 4 636 997 | 4.42 | **5 000 000** | ~8 % |
  | gzip `-9` | 7 201 173 | 6.87 | **7 800 000** | ~8 % |
  | (ref) raw `--no-opt` | 29 917 803 | 28.53 | — | — |
  | (ref) brotli-11 `--no-opt` | 4 940 377 | 4.71 | — | — |
  | (ref) JS glue `deltachat_wasm.js` | 54 742 (9 525 gz) | — | — | — |

  Transfer size is what matters for a PWA: serve the wasm **pre-compressed
  with brotli** (≈4.4 MiB first load, then Service-Worker cached); gzip-only
  hosts cost ≈6.9 MiB. CI step `Size budget (wasm-opt artifact)` checks all
  three (informational until landing). ⬜ Pavel to accept/adjust numbers.
- ⬜ wasm CI job is required (not `continue-on-error`) on the landing branch,
  still kept out of Release workflows until C2 ships.
- ✅ Copy builds are reproducible (`--locked`, pinned locks) — Day 9 CI run
  [`37384382279`](https://github.com/pbuzdin/velta/actions/runs/37384382279).

## 5. Networking e2e

- ✅ alice→bob over local `ws-tcp-proxy` → nine.testrun.org on the
  **in-repo** wrapper built from the pinned copy — Day 9 (see spike log).
- ⬜ Repeated e2e (≥ 3 consecutive passes on different days) incl.
  wasm-opt artifact. Day 9: 2/2 local; Day 10: 1 local with proxy
  `CHATMAIL_ALLOWLIST=nine.testrun.org`, plus CI.
- ✅ e2e runnable in CI: `workflow_dispatch` input `e2e=true` (manual only;
  proxy fetched pinned at `452cd0d`, allowlisted to nine.testrun.org) — Day 10.
- ⬜ e2e against relay-native websockify (`/imap`, `/smtp` + CORS, C3) on a
  test deploy of `pbuzdin/relay`.
- ⬜ Interop: wasm client ↔ native Velta (Android/desktop) message both ways,
  Autocrypt/SecureJoin verified.
- ⬜ Persistence (OPFS) restart test; storage-eviction backup path (C4).

## 6. Review

- ⬜ Review vendored crates against upstream (they ship on native too).
  Day 11 machine diff vs crates.io `src/`: astral-tokio-tar 0.6.4 **61**
  changed lines, async-imap 0.11.3 **6**, mail-builder 0.5.0 **17** (all
  listed in VENDORED.md §A). Human review still open.
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
