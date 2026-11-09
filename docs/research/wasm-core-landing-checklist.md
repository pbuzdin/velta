# Landing checklist — wasm patches into production `core/`

**Status (refreshed 2026-11-07): NOT GREEN.** The opt-in wasm PWA works, but
that does not authorize landing its patch series into production `core/`.
Nothing on this list authorises a merge by itself; Pavel signs off the final
box. Historical Day-number evidence below is retained as evidence, not as a
substitute for rerunning the gate on the landing checkout.

> **Production `core/` stays stock until this checklist is green.**
> "Stock" = upstream chatmail/core + Velta's production quilt
> (`python3 tools/apply-core-patches.py verify` → all ops present, currently
> **200/200 at 2.68.0**, plus `tree-check --fetch` green), with
> `core/Cargo.lock` unchanged by wasm work. Until then the wasm port lives
> only in the opt-in layer (`docs/research/wasm-patches/` +
> `tools/apply-wasm-core-patches.py apply-on-copy`) and in scratch copies.
> No `--i-know-this-writes-to-master-core` in CI, scripts or docs recipes.

Related: [patch home README](wasm-patches/README.md) ·
[spike log](wasm-core-mail-proxy-spike.md) ·
[port inventory](archive/wasm-core-port-inventory.md) ·
[archived PLAN-PWA-WEBSOCKET.MD §4b](archive/PLAN-PWA-WEBSOCKET.MD) ·
[COREUPDATE.md](../../COREUPDATE.md)

Legend: ✅ done on the opt-in copy (evidence linked) · ⬜ open · ⛔ blocker.
"Copy" = `apply-on-copy` workspace with the **pinned** locks.

## 0. Preconditions (decision)

- ✅ OQ-1 in `archive/PLAN-PWA-WEBSOCKET.MD` resolved in favour of Architecture C
  (non-custodial with addresses) — **decided by Pavel 2026-10-06**.
- ✅ C2/C4 browser consumer: `WorkerWasmTransport` boots the real app UI over
  the wasm core in a worker (no demo fallback), and the PWA dist sets
  `window.VELTA_PWA.wasmCore`. OPFS snapshot persistence and the single-tab
  Web Locks gate are implemented (#106/#123); restart and storage-eviction
  checks remain separately listed in §5. This makes the PWA a consumer of the
  opt-in build, not approval to modify production `core/`.
- ⬜ Decision recorded: land as cfg-gated patches in `core/` **vs.** keep the
  opt-in layer forever **vs.** upstream to chatmail/core first. Prefer
  upstream (`cfg(target_arch = "wasm32")`, track chatmail/core #8559).

## 1. Patch series hygiene

- ✅ Series is discrete and ordered: ten files — 0001–0008, 0010, 0011 — with
  an intentional 0009 gap. Current 2.66 attachment routing lives in 0011.
  Historical apply/verify runs are recorded in `wasm-patches/README.md`;
  rerun `apply-on-copy` and `verify-copy` on the actual landing checkout.
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
- ✅ Licensing: only MPL-2.0 patch ideas + Velta-written code; no GPL
  slothfulchat-web UI; vendored crates keep their licences/NOTICE files;
  `ws-tcp-proxy` (Unlicense) still not vendored (CI fetches it pinned).
  Day 11 audit ([VENDORED.md](wasm-patches/VENDORED.md) §A): astral-tokio-tar,
  async-imap, mail-builder keep MIT/Apache files. Day 12: the imported
  `tokio-wasm-shim` (licence unclear) is **replaced** by Velta-original
  `velta-tokio-wasm` (MPL-2.0, `LICENSE` + SPDX headers), written clean-room
  from consumer call sites + public tokio/wasmtimer/wasm-bindgen-futures
  APIs ([requirements + method](wasm-patches/velta-tokio-wasm-requirements.md)).
- ✅ tokio facade rustfmt: `velta-tokio-wasm` is rustfmt-clean (Day 12;
  supersedes the Day 11 "imported code, left unformatted" note).

### Gating audit — hunks that are *not* behind `cfg(target_arch = "wasm32")`

| Patch | Non-gated change | Native effect |
|---|---|---|
| 0001 | `deltachat-time` gains `SystemTimeTools::now()` | none (std on native) |
| 0002 | Cargo: native deps moved to `cfg(not(wasm32))` table; `rusqlite` **0.37→0.40** + `fallible_uint` | **dependency bump** — see §2 |
| 0003 | `tokio` → `velta-tokio-wasm` in ffi / jsonrpc / repl / rpc-server | facade = `pub use tokio::*` with `full` (feature superset) |
| 0004/0008 | `[patch.crates-io]` async-imap, astral-tokio-tar (=0.6.4 since Day 11), mail-builder | **vendored sources used on native too** (Cargo `[patch]` cannot be per-target) — see §2 |
| 0005/0008 | `accounts`/`context`/`imex`: `path_exists`/`path_is_dir`/`path_is_file` | wrappers call `Path::exists/is_dir/is_file` on native |
| 0007 | `Time::now()` → `tools::time_now()` (context, imap, idle, key, quota, scheduler, smtp, migrations, wal_checkpoint), ratelimit `now()` | wrapper calls `Time::now()` on native |
| 0011 | `blob`: `sync_fs` facade and memfs `open_blob` routing for the 2.66 attachment port | native re-exports `std::fs`; native `open_blob` is unchanged; wasm key-only paths fail closed |

## 2. Lockfile / reproducibility

- ✅ Copy locks pinned under `docs/research/wasm-patches/support/locks/`
  with `PROVENANCE`; CI builds with `--locked` — Day 9.
- ✅ Landing plan for `core/Cargo.lock`: the wasm series **changes native
  builds**, so that lock diff is its own review item — Day 24/25: the
  ordered review + merge steps live in
  [`wasm-core-lock-landing-plan.md`](wasm-core-lock-landing-plan.md)
  (Day 10 analysis via `cargo tree -i` on the pinned copy for
  x86_64-linux, aarch64-android, x86_64-windows is the evidence base):

  | Crate (native graph) | Stock | With series | Implication |
  |---|---|---|---|
  | rusqlite | 0.37.0 | **0.40.2** | API bump (`fallible_uint` for u64 ToSql); full lib nextest green on copy |
  | libsqlite3-sys (`bundled-sqlcipher-vendored-openssl`) | 0.35.0 | **0.38.2** | bundled **SQLCipher 4.6.1 → 4.14.0** (SQLite 3.46.1 → 3.51.3). Same SQLCipher 4 file format. ✅ **Day 11 upgrade + rollback PASS** on a real-schema Velta DB (dbversion 167, WAL) created by stock core, plaintext (Velta default) **and** legacy passphrase mode: 4.6.1 create → 4.14.0 open/write → 4.6.1 reopen/write → 4.14.0 reopen, `integrity_check=ok` and all rows at every hop (Day 11 scratch harness, removed). Remaining: same test on a copied **production** Android/desktop DB (older dbversion → migrations under the new engine) |
  | hashlink | 0.10.0 | 0.12.2 | rusqlite statement cache; internal |
  | tokio | 1.53.1 | 1.53.1 (via `velta-tokio-wasm`) | facade only: native build is `pub use tokio::*`, nothing else compiled (Day 12) |
  | async-imap | 0.12.0 crates.io (2.63) | 0.12.0 **vendored** | 2 files / 10 lines, all `cfg`-gated (idle timeout import); #112 re-vendor |
  | astral-tokio-tar | 0.6.4 | **0.6.4 vendored** (Day 11 rebase) | ✅ downgrade removed: vendor = crates.io 0.6.4 + 61 wasm lines; native lock now 0.6.4 + rustix 1.1.4 like stock. Ungated: `canonicalize` via `tokio::fs` (same result, blocking pool). Day 11 nextest 1135/1135. 2.63 note (#112): stock `core/` declares 0.7.0; the series pins `=0.6.4` — wasm-copy-only downgrade, production `core/` untouched |
  | mail-builder | 1.0.0 crates.io (2.63) | 1.0.0 **vendored** | 3 files / ~88 lines, `SystemTime` imports `cfg`-gated; #112 re-vendor |
  | wasm-bindgen / js-sys / web-sys / sqlite-wasm-rs / wasmtimer / indexed_db_futures | 0.2.100 … | 0.2.130 … | **not in native graphs** (wasm-only) |

  Native crate bumps need release-notes mention and their own native test
  pass (§3) independent of the wasm work.
- ✅ wasm-bindgen crate version == `wasm-bindgen-cli` in CI (derived from
  `PROVENANCE`, Day 9) and documented for local builds — Day 24: the pinned
  version (0.2.130) and the local-build matching requirement are documented
  in [`packages/velta-wasm/README.md`](../../packages/velta-wasm/README.md).
- ✅ Pinned nightly (`nightly-2026-08-01`, needed for rusqlite `cfg_select!`)
  replaced by stable, or the nightly pin is accepted for the wasm target
  only and **never** affects Android/desktop builds. **Day 25 — accepted
  for wasm-only, with evidence:** a full native `cargo check --locked -p
  deltachat --lib` of the copy workspace on **stable 1.98.1** (WSL LF
  clone → `apply-on-copy --dest` → check) finished green in 3m15s
  *including* rusqlite 0.40.2 — the nightly requirement is wasm32-only
  (`cfg_select!` resolves on stable for native compilation); the opt-in CI
  installs the nightly pin only in the wasm job, and production `core/`
  native builds stay stable.

## 3. Native parity ("stock hash parity")

Native builds must not change behaviour because of the wasm patches.

- ✅ Full `cargo nextest run -p deltachat --lib` on the copy:
  **1135/1135** (1 skipped) — Day 8; re-run Day 10 (hygiene) and Day 11
  (astral-tokio-tar 0.6.4 rebase): **1135/1135, 1 skipped, 0 warnings**.
- ✅ Avatar golden parity: copy and stock both produced `d57cb5ce…af.png`
  for `test_selfavatar_in_blobdir` in the historical Day 8 run. The retired
  0009 changed no golden; current 0011 leaves native `open_blob` unchanged.
  Rerun the parity check on the landing tree.
- ✅ Same nextest run with the **landed** lock (Day 13): `deltachat --lib`
  1135/1135 (1 skipped); `deltachat-jsonrpc` + `deltachat-rpc-server` 2/2.
  `deltachat_ffi` has no testable rust target (`cdylib, staticlib`; C-side
  tests out of nextest scope).
- ✅ Golden / fixture hashes unchanged vs. stock across the whole suite:
  the embedded golden/fixture expectations pass on both stock CI and the
  wasm-series copy (Day 13 run); no intentional golden changes.
- ⬜ `python3 tools/apply-core-patches.py verify` → **200/200 after** the
  wasm series is in `core/` (the two layers coexist). Adjust only if the
  production applicator itself changes before landing; never hardcode a lower
  historical count.
- ⬜ Android APK + Windows sidecar (`velta-core-service` archived 2026-10-20, out of scope) build from the
  landed tree; smoke per COREUPDATE.md §2 frontend contract (RPC/event
  surface unchanged). Sidecar done Day 12b. **Proposed waiver for the APK
  part (Pavel, pending):** aarch64 `cargo check` green (Day 12b) + Windows
  sidecar link+smoke green cover the native-breakage risk; release CI
  builds the APKs from the landed tree at the landing tag regardless.
- ✅ Binary-size check of native artifacts vs. previous release: Windows
  sidecar from the wasm-series copy is **+19 456 B (+0.086 %)** vs the
  committed stock prebuilt (22 514 176 vs 22 494 720 B) — Day 12b; no
  wasm-only deps leak into native targets. (Sidecar `get_system_info` smoke
  PASS; aarch64 `cargo check` PASS; full APK / `velta-core-service` APK
  builds still open.)

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
  | (ref) JS glue `velta_wasm.js` | 54 742 (9 525 gz) | — | — | — |

  Transfer size is what matters for a PWA: serve the wasm **pre-compressed
  with brotli** (≈4.4 MiB first load, then Service-Worker cached); gzip-only
  hosts cost ≈6.9 MiB. CI step `Size budget (wasm-opt artifact)` checks all
  three (informational until landing). ✅ Pavel accepted the Day-10 numbers
  2026-10-06; making the CI gate required (not informational) stays open
  until landing.
- ⬜ wasm CI job is required (not `continue-on-error`) on the landing branch,
  still kept out of Release workflows until C2 ships.
- ✅ Copy builds are reproducible (`--locked`, pinned locks) — Day 9 CI run
  [`37384382279`](https://github.com/pbuzdin/velta/actions/runs/37384382279).

## 5. Networking e2e

- ✅ alice→bob over local `ws-tcp-proxy` → nine.testrun.org on the
  **in-repo** wrapper built from the pinned copy — Day 9 (see spike log).
- ✅ Repeated e2e (≥ 3 consecutive passes on different days) incl.
  wasm-opt artifact. CI `e2e=true` PASS:
  [`37388272660`](https://github.com/pbuzdin/velta/actions/runs/37388272660),
  [`37392355171`](https://github.com/pbuzdin/velta/actions/runs/37392355171),
  [`37396231552`](https://github.com/pbuzdin/velta/actions/runs/37396231552)
  (2026-10-06),
  [`37531692405`](https://github.com/pbuzdin/velta/actions/runs/37531692405)
  (2026-10-07),
  [`37702314407`](https://github.com/pbuzdin/velta/actions/runs/37702314407)
  (2026-10-08). Networking e2e alice→bob green on each distinct day (#96).
- ✅ e2e runnable in CI: `workflow_dispatch` input `e2e=true` (manual only;
  proxy fetched pinned at `452cd0d`, allowlisted to nine.testrun.org) — Day 10.
- ⬜ Relay-native websockify interoperability (`/imap`, `/smtp` + CORS, C3)
  remains an open landing-checklist item and needs either a test-deploy e2e or
  Pavel's explicit waiver. It no longer blocks the **standalone** PWA proxy:
  that implementation uses approved `/dns/` and `/tcp/` tunnels plus
  authenticated WebSocket `/cm-new/` signup, so stock Chatmail `/new` CORS is
  not on the signup path. Full `wss://` URLs and private paths survive worker
  networking. Do not mark this relay-native item green merely because the
  standalone proxy works.
- ⬜ Interop: wasm client ↔ native Velta (Android/desktop) message both ways,
  Autocrypt/SecureJoin verified.
- ⬜ Persistence (OPFS) restart test; storage-eviction backup path (C4).
  Day 19: app-level restart PASS in the PWA dist rig
  (`scripts/verify-pwa-dist.mjs` — snapshot written, reload restores,
  SW active). Day 20: the storage-eviction backup path has a product
  surface (identity backup UX — export/restore modals, passphrase-wrapped
  bundle, 6/6 crypto tests, rig 10/10); UI-level restore against a live
  relay still needs a relay window (CI e2e covers the core-level order).

## 6. Review

- ⬜ Review vendored crates against upstream (they ship on native too).
  Day 11 machine diff vs crates.io `src/`: astral-tokio-tar 0.6.4 **61**
  changed lines, async-imap **6**, mail-builder **17** (all
  listed in VENDORED.md §A). Human review still open. #112 re-vendored
  async-imap 0.12.0 + mail-builder 1.0.0 with the same deltas.
- ⬜ Line-by-line review of the series by someone other than the author
  (agent-written patches need human review), focusing on: TLS clock
  provider, `ws_tcp` DNS/connect path, `http_wasm` fetch, blob memfs.
- ⬜ Security review: TLS stays in wasm (no proxy termination), proxy
  allowlist (never port 25), no credentials in logs, CSP
  `'wasm-unsafe-eval'` scope.
- ✅ Upstream status re-checked on **2026-11-07** (chatmail/core #8559, relay
  #1030): #8559 remains open with no merged client implementation; #1030
  remains an open draft. Nothing in the current wasm series can be dropped on
  the basis of those two entries. Separately, core #8711 merged on 2026-10-27
  and its `configured_addr` removal is already reflected in production 2.66.
  Recheck every entry per core bump and at landing.

## 7. Process

- ✅ COREUPDATE.md gains a "re-apply wasm series" step + per-bump rebase
  checklist — new §0b (Day 12b: `apply-on-copy` → `verify-copy`, merge-gate
  reference, `refresh-lock` pointer).
- ✅ Rollback plan: one revert commit restores stock `core/` — documented in
  COREUPDATE §0b (Day 12b); the series is discrete and `cfg`-gated.
- ⬜ Pavel's explicit **landing** go-ahead recorded in the spike log / issue.
  (Day 12 scope approval is recorded; this box is the final merge go-ahead.)

---

**Merge gate:** every ⬜ above is ✅ (or explicitly waived by Pavel in
writing with a reason). Until then: production `core/` stays stock.
