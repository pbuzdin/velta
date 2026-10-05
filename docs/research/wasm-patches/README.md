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
| `series/*.patch` + `SERIES` (this dir) | **Extracted** discrete patches (Day 6) from side-tree commits after baseline `0a10087` (= Velta master `core/` at extract time). `Cargo.lock` hunks stripped — regenerate lock via cargo |
| `support/{crates,vendor-crates}/` | `tokio-wasm-shim` + vendored async-imap / astral-tokio-tar / mail-builder |
| `tools/apply-wasm-core-patches.py` | **Opt-in** applicator — **apply-on-copy only** by default |

Master `core/` stays on Velta’s 13 patches (`tools/apply-core-patches.py`).

## Apply on a copy (Day 6)

```sh
# from repo root — NEVER touches master core/ by default
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
python3 tools/apply-wasm-core-patches.py verify-copy --dest /tmp/velta-wasm-copy

cd /tmp/velta-wasm-copy/core
CC=clang cargo check -p deltachat --lib \
  --target wasm32-unknown-unknown --no-default-features
```

Bare `apply` is refused. Applying onto master `core/` requires an explicit
dangerous flag (not for CI). Default dest `.wasm-core-apply/` is gitignored.

**Verified Day 6:** 8/8 patches apply cleanly onto a copy of master `core/`;
`cargo check` wasm lib **PASS** on that copy.

## Patch series (commit order)

See [`SERIES`](SERIES). Rough mapping to inventory WASM-CORE ids:

| Series | Intent |
|---|---|
| 0001 | deltachat-time JS clock (prototype 0002) |
| 0002–0004 | Cargo target gates, tokio shim, `[patch.crates-io]` |
| 0005–0006 | http/proxy stubs, blob ReadDir, vendors |
| 0007–0008 | ws_tcp, clocks, blob sync_fs, fetch, path_exists, connect_tcp |

## Long-term patch home

**Near-term (chosen):** this opt-in layer. **Longer-term:** upstreamable
`cfg(target_arch = "wasm32")` / chatmail upstream.

## CI sketch (opt-in)

[`.github/workflows/wasm-core-opt-in.yml`](../../../.github/workflows/wasm-core-opt-in.yml)
runs on `workflow_dispatch`, `wasm-core/**` branches, or PRs touching this
tree. It **apply-on-copies** then `cargo check` wasm. It does **not** hook
Release workflows. Full `wasm-pack` + Playwright smoke stays side-tree until
the MPL wrapper is in-repo.

## Artifact path

Spike host (Day 4):  
`/workspace/velta-wasm-port/packages/core-wasm/wasm-dist/deltachat_wasm_bg.wasm`  
(~29 MB `--no-opt`; ~18 MB after `wasm-opt -Os`).

## See also

- Spike log: [`../wasm-core-mail-proxy-spike.md`](../wasm-core-mail-proxy-spike.md)
- Inventory: [`../wasm-core-port-inventory.md`](../wasm-core-port-inventory.md)
