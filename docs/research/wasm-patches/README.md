# Velta wasm core patches — home and ownership

**Answer (Pavel / Day 5):** yes — Velta will have its **own fresh wasm core**,
meaning a **Velta-owned forward-port of chatmail/core 2.62+** targeting
`wasm32-unknown-unknown`, not a fork or submodule of
`experintellia/slothfulchat-web`.

| We do | We do not |
|---|---|
| Port MPL-2.0 (or dual MPL/GPL) **ideas** from the prototype’s WASM-CORE patches | Copy the GPL web app / desktop frontend into Velta |
| Keep a Velta-built `deltachat-wasm` wrapper (MPL) + Unlicense-style WS→TCP bridge pattern | Depend on slothfulchat-web as the long-term source tree |
| Gate Android/desktop so they stay on the native path | Apply wasm patches in production CI by default |

## Where the code lives

| Location | Role |
|---|---|
| Spike side tree `/workspace/velta-wasm-port` | Proven Day 3–5 workspace (artifact + e2e) |
| `series/*.patch` + `series.txt` (this dir) | **Extracted** discrete patches (Day 6) from side-tree commits after baseline `0a10087` (= Velta master `core/` at extract time). `Cargo.lock` hunks stripped — regenerate lock via cargo |
| `support/{crates,vendor-crates}/` | `tokio-wasm-shim` + vendored async-imap / astral-tokio-tar / mail-builder |
| [`VENDORED.md`](VENDORED.md) | Day 11 register: vendored crates (upstream base, licence, local delta, native effect) + per-patch re-apply notes |
| `sqlcipher-harness/` | Day 11 scratch harness: SQLCipher 4.6.1↔4.14.0 upgrade/rollback on a real-schema DB (not built by CI) |
| `support/locks/` | **Pinned** copy lockfiles (Day 9): `core.Cargo.lock`, `deltachat-wasm.Cargo.lock`, `PROVENANCE` |
| `tools/apply-wasm-core-patches.py` | **Opt-in** applicator — **apply-on-copy only** by default |
| `packages/deltachat-wasm/` (MPL) | Minimal JSON-RPC wasm wrapper; copied into apply-on-copy dest |
| `scripts/smoke-deltachat-wasm.mjs` | Headless `get_system_info` smoke (`PACKAGE_ROOT` supported) |
| `scripts/e2e-deltachat-wasm-network.mjs` | alice→bob e2e over a local `ws-tcp-proxy` → public chatmail (`PACKAGE_ROOT`, `WS_TCP_PROXY`) |
| [`../wasm-core-landing-checklist.md`](../wasm-core-landing-checklist.md) | What must be green before **any** merge into production `core/` |

Master `core/` stays on Velta’s 13 patches (`tools/apply-core-patches.py`).
**Production `core/` stays stock until the
[landing checklist](../wasm-core-landing-checklist.md) is green.**

## Apply on a copy (Day 6)

```sh
# from repo root — NEVER touches master core/ by default
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
python3 tools/apply-wasm-core-patches.py verify-copy --dest /tmp/velta-wasm-copy

cd /tmp/velta-wasm-copy/core
CC=clang cargo check --locked -p deltachat --lib \
  --target wasm32-unknown-unknown --no-default-features

cd ../packages/deltachat-wasm/rust
CC=clang wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist -- --locked
```

Bare `apply` is refused. Applying onto master `core/` requires an explicit
dangerous flag (not for CI). Default dest `.wasm-core-apply/` is gitignored.

**Verified Day 6:** 9/9 patches apply cleanly onto a copy of master `core/`;
`cargo check` wasm lib **PASS** on that copy.

## Pinned lockfiles (Day 9)

The series strips `Cargo.lock` hunks, so an unpinned copy re-resolves ~37
crates to "latest compatible" on every run. That is how `png` 0.18.1 drifted
into the side tree (Day 7 golden scare), and a `wasm-bindgen` 0.2.130 release
would silently break the pinned `wasm-bindgen-cli`. So:

| File | Installed into the copy as |
|---|---|
| `support/locks/core.Cargo.lock` | `<dest>/core/Cargo.lock` |
| `support/locks/deltachat-wasm.Cargo.lock` | `<dest>/packages/deltachat-wasm/rust/Cargo.lock` |
| `support/locks/PROVENANCE` | inputs + output hashes, `wasm_bindgen_version` |

- `apply-on-copy` installs both locks by default and writes
  `core/.velta-wasm-pinned-lock`; `verify-copy` fails on drift. Build with
  `cargo … --locked` / `wasm-pack build … -- --locked`.
- `PROVENANCE` hashes master `core/Cargo.lock`, the series and the support /
  wrapper manifests. If any changed, `apply-on-copy` **refuses** (exit 3)
  until the locks are regenerated:
  ```sh
  python3 tools/apply-wasm-core-patches.py lock-status        # OK / STALE + reasons
  python3 tools/apply-wasm-core-patches.py refresh-lock --dest /tmp/velta-wasm-lock
  git add docs/research/wasm-patches/support/locks/
  ```
  `refresh-lock` does a fresh apply-on-copy, lets cargo re-resolve the core
  copy **starting from master `core/Cargo.lock`** (minimal: only the ~37
  wasm-related crates move), then seeds the wrapper lock from that core
  lock so shared crates (png, rusqlite, wasm-bindgen, …) are identical.
  `--no-pinned-lock` gives an exploratory unpinned copy.
- Master `core/Cargo.lock` is never written (CI asserts `git diff --exit-code -- core/`).
- CI installs `wasm-bindgen-cli` at `wasm_bindgen_version` from `PROVENANCE`.

Pinned Day 9 against master `core/Cargo.lock` sha256 `03978ad9…7ea5`:
wasm-bindgen 0.2.129, rusqlite 0.40.2, libsqlite3-sys 0.38.2, png 0.18.0
(both locks).

## Patch series (commit order)

See [`series.txt`](series.txt). Rough mapping to inventory WASM-CORE ids:

| Series | Intent |
|---|---|
| 0001 `wasm(time)` | deltachat-time JS clock (prototype 0002) |
| 0002–0004 `wasm(cargo)` | Cargo target gates + rusqlite 0.40, tokio shim, `[patch.crates-io]` |
| 0005–0006 `wasm(net,accounts)`, `wasm(blob,cargo)` | http/proxy wasm modules + cfg stubs, blob ReadDir |
| 0007–0008 `wasm(net,blob,time)`, `wasm(fs,net,tls)` | ws_tcp, clocks, blob sync_fs, fetch, path_exists, connect_tcp, JsClock |
| 0009 `wasm(tests)` | blob_tests ↔ `image_metadata` BufReadSeek call sites (test-only; avatar golden unchanged from master) |

Day 10 hygiene: subjects carry WASM-CORE ids + a "Native impact" line;
0 warnings (wasm + native), no new rustfmt diffs. Gating audit and the
native dependency implications are in the
[landing checklist](../wasm-core-landing-checklist.md) §1–§2.
To edit the series: `git am` it onto a scratch git copy of master `core/`,
amend/fixup, `git format-patch --zero-commit -N`, replace `series/`, update
`series.txt`, then `refresh-lock`.

## Long-term patch home

**Near-term (chosen):** this opt-in layer. **Longer-term:** upstreamable
`cfg(target_arch = "wasm32")` / chatmail upstream.

## CI sketch (opt-in)

[`.github/workflows/wasm-core-opt-in.yml`](../../../.github/workflows/wasm-core-opt-in.yml)
runs on `workflow_dispatch`, `wasm-core/**` branches, or PRs touching wasm
patches / wrapper. Steps: `lock-status` → **apply-on-copy** (pinned locks) →
wasm `cargo check --locked` →
`wasm-pack` (MPL wrapper) → Playwright `get_system_info` smoke → `wasm-opt -Os`
(binaryen 120) → smoke on optimized artifact. First green run: Day 8;
pinned-lock `--locked` run: Day 9.
`continue-on-error: true`; does **not** hook Release workflows.
Day 10: `Size budget` step (raw ≤ 20 000 000, brotli-11 ≤ 5 000 000,
gzip-9 ≤ 7 800 000 bytes) and optional networking e2e via
`gh workflow run wasm-core-opt-in.yml -f e2e=true` (manual only; pinned
Unlicense proxy, `CHATMAIL_ALLOWLIST=nine.testrun.org`, 2 throwaway accounts).

## Artifact path

Spike host (Day 4):  
`/workspace/velta-wasm-port/packages/core-wasm/wasm-dist/deltachat_wasm_bg.wasm`  
(~29 MB `--no-opt`; ~18 MB after `wasm-opt -Os`).
In CI the in-repo wrapper builds to `$RUNNER_TEMP/velta-wasm-copy/packages/deltachat-wasm/wasm-dist/`.

## See also

- Spike log: [`../wasm-core-mail-proxy-spike.md`](../wasm-core-mail-proxy-spike.md)
- Landing checklist: [`../wasm-core-landing-checklist.md`](../wasm-core-landing-checklist.md)
- Inventory: [`../wasm-core-port-inventory.md`](../wasm-core-port-inventory.md)
