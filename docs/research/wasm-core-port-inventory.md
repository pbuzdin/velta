# Wasm core port inventory — slothfulchat → Velta 2.62.0

**Date:** 2026-10-05. Side-tree work only (`/workspace/velta-wasm-port/` on the
spike host). **Nothing from this port is in Velta `master` `core/` yet.**

Licensing: prototype core patches are dual `MPL-2.0 OR GPL-3.0`; the
`tokio-wasm-shim` and `core-wasm` wrapper are MPL-2.0; `ws-tcp-proxy` is
Unlicense. Do **not** copy the GPL web app / desktop frontend into Velta.

## Prototype patch categories (35 total @ core `446cdabd` / 2.54.0-dev)

| Category | Patches | Approx. +lines | For Velta wasm slice? |
|---|---|---:|---|
| **WASM-CORE** | 0001–0007, 0010 | ~1093 | **Yes** — minimal compile + WS mail + fetch |
| **WASM-EXTRA** | 0008–0009, 0019, 0029, 0032–0033 | ~907 | Later (backup / OPFS / crypto offload) |
| **webimap** | 0011–0013 | ~983 | No (madmail; not chatmail) |
| **FEATURE** | 0014–0018, 0020–0028, 0030–0031, 0034–0035 | large | No for wasm spike |

### WASM-CORE detail
| Patch | Intent |
|---|---|
| 0001 | Target-gate native-only deps; `tokio-wasm-shim`; rusqlite 0.37→0.40; getrandom/uuid js; `[patch.crates-io]` async-imap + astral-tokio-tar |
| 0002 | `deltachat-time` via `js-sys` `Date.now()` |
| 0003 | Stub `http`/`proxy` on wasm; rustls provider/time; gate native-tls / socks / shadowsocks |
| 0004 | fs shim integration (`path_exists`, ReadDir Stream, no lockfile on wasm) |
| 0005 | IMAP/SMTP via WebSocket–TCP (`ws_tcp.rs`) |
| 0006 | JS clock everywhere `SystemTime` panics |
| 0007 | Blob sync fs via memfs shim |
| 0010 | HTTP via browser `fetch()` (replaces http stubs for real use) |

## Apply attempt on Velta 2.62.0 (mechanical `git apply`)

| Patch | Result |
|---|---|
| 0001 | **FAIL** (Cargo.toml drifted: edition 2024, rusqlite path, tokio-rustls `brotli`, mail-builder 0.5, async-imap 0.11.3) |
| 0002 | **CLEAN** |
| 0003 | FAIL (tls.rs / danger.rs reshaped) |
| 0004 | FAIL (imex.rs / tools.rs) |
| 0005 | FAIL (Cargo.toml / lock) |
| 0006 | FAIL (7 files) |
| 0007 | FAIL (blob.rs — Velta animated-WebP patch nearby) |
| 0010 | FAIL (needs http_wasm from 0003; Cargo.toml) |

**Plan:** do **not** dump raw patches into Velta’s anchor-based
`tools/apply-core-patches.py` yet. Keep a **side tree** + documented manual
port (target `cfg` + small new files). Eventually: either a second patch
layer (`docs/research/wasm-patches/` or `tools/apply-wasm-core-patches.py`)
that is **opt-in** for wasm CI only, or upstreamable `cfg(target_arch =
"wasm32")` gates so Android/desktop stay on the unpatched native path.

## Side-tree progress (`/workspace/velta-wasm-port`)

Layout: `core/` (copy of Velta 2.62 + Velta’s 13 patches), `crates/tokio-wasm-shim`,
`vendor-crates/{async-imap,astral-tokio-tar,mail-builder}`, `patches/` (reference).

### What was ported manually
1. **0001-equivalent Cargo.toml:** target-gated deps; `tokio` →
   `tokio-wasm-shim`; rusqlite workspace **0.40** + `fallible_uint`;
   `[patch.crates-io]` async-imap + astral-tokio-tar; wasm getrandom/uuid/pgp/ws deps.
2. **0002** applied cleanly.
3. **0003-ish:** copied `http_wasm.rs` / `proxy_wasm.rs`; gated `net.rs`,
   `session.rs`, `tls.rs` (native-tls), `qr.rs` (shadowsocks), `accounts.rs`
   lockfile (`ios|wasm32`).
4. **blob ReadDir** cfg (0004 fragment).
5. **Vendor async-imap refreshed to 0.11.3** (keeps `login_with_capabilities`),
   `tokio/net` feature dropped; IDLE timeout via `wasmtimer` on wasm.

### Build results (spike host)
| Check | Result |
|---|---|
| `cargo check -p deltachat --lib --target wasm32-unknown-unknown --no-default-features` | **PASS** (~28s incremental after deps) |
| Same for host `--no-default-features` | FAIL env: missing `pkg-config`/OpenSSL (not a master regression; master `core/` untouched) |
| `wasm-pack` / browser smoke on 2.62 | **Not yet** — needs 0005 (`ws_tcp`), 0006 (clock minefield), 0007, 0010 (fetch), jsonrpc wrapper |

### Coexistence with Velta’s 13 patches
Side-tree baseline started from Velta `core/` with all 13 present
(`apply-core-patches.py verify` on master still **13/13**). blob.rs wasm
ReadDir edit is adjacent to Velta’s animated-WebP helpers — rebase carefully.

### Version traps vs 2.54 prototype
- edition **2024**, rust-version **1.89**
- rusqlite **0.40** required for `sqlite-wasm-rs`
- async-imap **0.11.3** (vendor must match; 0.11.2 lacked `login_with_capabilities`)
- mail-builder **0.5.0** (prototype fork is 0.4.4 — clock patch may need redo)
- tokio-rustls native features: **`brotli`** (not aws-lc-rs as in 2.54 patch text)
- `[patch.crates-io]` is mandatory; without it, `mio` returns and wasm dies at dep compile

## Recommended Day 4
1. Port **0005** (`ws_tcp.rs` + connect path) and **0006** (clock sites) on the
   side tree; re-run `cargo check` wasm.
2. Add a minimal `deltachat-wasm` cdylib (MPL) wrapping jsonrpc like the
   prototype; `wasm-pack` + Day-1-style `get_system_info` smoke.
3. Only then consider networking e2e on 2.62 (ws-tcp-proxy → nine.testrun.org).
4. Still **no** merge into Velta `master` `core/` until: wasm check green **and**
   full native `cargo check`/`nextest` with Velta’s usual features green on a
   properly tooled host.
