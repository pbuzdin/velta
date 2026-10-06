# VENDORED.md — wasm opt-in layer: vendored crates + per-patch re-apply notes

VENDORISSUES-style register for everything the wasm series pulls in that is
**not** stock chatmail/core (Day 11, 2026-10-06). Scope: the opt-in layer
only (`docs/research/wasm-patches/`); production `core/` stays stock.

Re-check every entry when (a) chatmail/core is bumped, (b) a vendored crate
is re-vendored, or (c) `refresh-lock` changes a pinned lock. Our local
changes are **not** upstream and are silently lost if a directory is
replaced wholesale.

Native-impact reminder: Cargo `[patch.crates-io]` cannot be per-target, so
the three `vendor-crates/` below are compiled into **native** builds too
once the series lands. Only `cfg(target_arch = "wasm32")` hunks are
wasm-only.

---

## A. Support / vendored crates

| Crate | Path | Upstream base | Licence | Local delta (src) | Native effect |
|---|---|---|---|---|---|
| tokio-wasm-shim 1.0.0 | `support/crates/tokio-wasm-shim` | experintellia/slothfulchat-web `crates/tokio-wasm-shim` @ `452cd0d` (byte-identical) | `MPL-2.0` per its Cargo.toml — ⚠ see A1 | n/a (imported as-is, 2 418 lines) | `pub use tokio::*` (feature `full`); `registry`/`durability`/`limits` modules compile everywhere |
| astral-tokio-tar **0.6.4** | `support/vendor-crates/astral-tokio-tar` | crates.io 0.6.4 / [astral-sh/tokio-tar](https://github.com/astral-sh/tokio-tar) | MIT OR Apache-2.0 (LICENSE-MIT, LICENSE-APACHE kept) | 61 changed lines (header.rs, entry.rs, builder.rs) | `canonicalize` via `tokio::fs` (= `spawn_blocking(std::fs::canonicalize)`); rest gated |
| async-imap 0.11.3 | `support/vendor-crates/async-imap` | crates.io 0.11.3 / [async-email/async-imap](https://github.com/async-email/async-imap) @ `24b5aa3` | MIT OR Apache-2.0 (kept) | 6 lines `extensions/idle.rs` + wasm-only `wasmtimer` dep; drops tokio `net` feature | none (all gated) |
| mail-builder 0.5.0 | `support/vendor-crates/mail-builder` | crates.io 0.5.0 / [stalwartlabs/mail-builder](https://github.com/stalwartlabs/mail-builder) | Apache-2.0 OR MIT (`LICENSES/` kept) | 17 lines (`headers/date.rs`, `mime.rs`) + wasm-only `web-time` dep | none (imports gated) |

### A1. tokio-wasm-shim — licence provenance ⚠ open

**Status: imported as-is; licence needs upstream confirmation before landing.**

The crate's `Cargo.toml` declares `license = "MPL-2.0"`, but the
slothfulchat-web repo is GPL-3.0-or-later as a whole and its README
licensing table lists `patches/core`, `packages/core-wasm` (MPL) and
`packages/ws-tcp-proxy` (Unlicense) — **not** `crates/tokio-wasm-shim`. The
crate directory has no LICENSE file. The `license` field is a reasonable
signal of intent but not an explicit grant we can point a reviewer at.

Options (pick one before landing): (1) ask the slothfulchat-web author to
add the shim to the README table / a LICENSE file (MPL-2.0); (2) Velta
rewrites the shim (it is a facade: ~2.4 k lines, most in `fs.rs`/`opfs.rs`).
Rustfmt: 9 files differ from `rustfmt --edition 2021` — leave as imported
code until A1 is decided (formatting it makes upstream diffs noisier).

### A2. astral-tokio-tar — rebased onto stock 0.6.4 (Day 11) ✅

**Status: patched locally (`// ponytail:` comments) — re-apply on re-vendor.**

Day 10 found the vendor at 0.6.3 while stock core resolves 0.6.4 (native
**downgrade**: lost 0.6.4's 32-bit Unix `subsec_nanos() as _` fix,
`truncate(0)`→`clear()`, rustix 0.38→1.0). Day 11 replayed the upstream
0.6.3→0.6.4 delta onto the vendor (2 src lines + rustix 1.0 + version) and
bumped the series pin (0004) to `=0.6.4`. `diff -ru` vs crates.io 0.6.4
`src/` is now **only** the wasm hunks:

- `builder.rs`, `header.rs`: `Metadata` from `tokio::fs` on wasm32.
- `header.rs`: `fill_platform_from` for wasm32 synthesises uid/gid 0 and
  0644/0755 (upstream: `unimplemented!()`); `DETERMINISTIC_TIMESTAMP` also on wasm32.
- `entry.rs`: `FileTimes`/`set_file_times` + `preserve_mtime` gated native-only;
  `unpack_in` / `validate_inside_dst` use `fs::canonicalize(..).await`
  instead of `Path::canonicalize()` (**ungated** — same result on native,
  but now via tokio's blocking pool).

Native lock effect (pinned core lock): astral-tokio-tar 0.6.4 + rustix 1.1.4,
identical to stock. Wrapper lock drops rustix 0.38.44 / linux-raw-sys 0.4.14.
Upstream candidate: wasm32 `fill_platform_from` + `tokio::fs::canonicalize`
are both upstreamable (no wasm deps needed).

Known warnings: 2× `unused_braces` in `header.rs` 1715/1718 — upstream code,
present in stock 0.6.4 as well.

### A3. async-imap 0.11.3

**Status: patched locally — re-apply on re-vendor.** IDLE `timeout` comes
from `wasmtimer::tokio` on wasm32 (tokio timers panic on
`wasm32-unknown-unknown`); tokio `net` feature dropped (pulls mio). Stock
core resolves the same version. Upstream candidate: a `wasmtimer` cfg in
`idle.rs`.

### A4. mail-builder 0.5.0

**Status: patched locally — re-apply on re-vendor.** `SystemTime`/`UNIX_EPOCH`
from `web_time` on wasm32 (`std::time::SystemTime::now()` panics there). Stock
core resolves the same version (0008 bumps the declared dep to 0.5). Upstream
candidate: `web-time` behind `cfg(target_arch = "wasm32")`.

### A5. Not vendored

- `ws-tcp-proxy` (Unlicense): CI fetches slothfulchat-web `452cd0d` and installs
  `ws@8.22.0` pinned; never copied into Velta.
- slothfulchat-web GPL web app / desktop patches: never copied.

---

## B. Series patches — re-apply notes

All patches: `git format-patch --zero-commit`, Cargo.lock hunks stripped,
locks pinned in `support/locks/`. On a core bump: `apply-on-copy` → fix rejects
in a scratch repo → re-export → `refresh-lock` → nextest + avatar golden +
wasm-pack + smoke + e2e (see checklist §7).

| # | Subject (short) | Files | Anchors / re-apply risk | Native impact |
|---|---|---|---|---|
| 0001 | time: `deltachat-time` reads `js_sys::Date` on wasm32 | deltachat-time/{Cargo.toml,src/lib.rs} | tiny; low | none |
| 0002 | cargo: target-gate native-only deps, add shim, **rusqlite 0.40** | .cargo/config.toml, Cargo.toml, jsonrpc/Cargo.toml | **high** — rewrites `[dependencies]` table; conflicts on every core dep bump | rusqlite 0.37→0.40.2 ⇒ SQLCipher 4.6.1→4.14.0 (Day 11 upgrade/rollback ✅) |
| 0003 | cargo: route `tokio` through shim in every crate | ffi/jsonrpc/repl/rpc-server Cargo.toml | low (one line each) | facade only |
| 0004 | cargo: `[patch.crates-io]` async-imap + astral-tokio-tar | Cargo.toml | medium — pin `=0.6.4` must track stock tar version | vendored sources on native (see A2/A3) |
| 0005 | net/accounts: `http_wasm`/`proxy_wasm` + cfg stubs | accounts, net, net/{http_wasm,proxy_wasm,session,tls}, qr | medium — `net/tls.rs` churns upstream | none (gated) |
| 0006 | blob/cargo: `ReadDir` cfg for memfs, serde_urlencoded | Cargo.toml, blob.rs | low | none |
| 0007 | net/blob/time: `ws_tcp`, wasm clocks, blob `sync_fs`, fetch | 18 files (blob, tools, net/*, imap, smtp, sql/migrations, ratelimit…) | **high** — `Time::now()`→`tools::time_now()` sweep touches many call sites; re-grep `Time::now()` after each bump | mechanical refactors; avatar golden unchanged |
| 0008 | fs/net/tls: `path_exists`/`is_dir`, wasm `connect_tcp`, JsClock, mail-builder 0.5 | Cargo.toml, accounts, context, imex, net, tools | medium | wrappers = `Path::exists/is_dir` |
| 0009 | tests: blob_tests use `BufRead + Seek` `image_metadata` | blob/blob_tests.rs | low | test-only |

Upstream tracking: chatmail/core #8559 (wasm32 target), relay #1030
(websockify). Drop any patch upstream covers.
