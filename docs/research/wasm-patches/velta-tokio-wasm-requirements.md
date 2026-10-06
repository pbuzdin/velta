# velta-tokio-wasm — clean-room requirements (Day 12, 2026-10-06)

Pavel's decision (Day 12): replace the imported `tokio-wasm-shim` (identical
to experintellia/slothfulchat-web's copy; repo GPL-3.0-or-later; MPL only in
its Cargo.toml; no LICENSE file) with a **Velta-original** crate,
`velta-tokio-wasm`, MPL-2.0.

## Clean-room method

- The old shim's `src/` was **not** used as input: it was deleted from the
  tree before the new crate was written, and no code, structure or comments
  were carried over or paraphrased.
- Inputs used: (1) the *consumer side*, i.e. which `tokio::…` paths the
  patched core, `deltachat-jsonrpc`, the vendored astral-tokio-tar and Velta's
  `packages/deltachat-wasm` wrapper reference when compiled for
  `wasm32-unknown-unknown` (grep of an apply-on-copy + `cargo check` errors
  against an empty facade); (2) tokio's public API docs (signatures and
  semantics to mirror); (3) public APIs of permissively licensed crates:
  `wasmtimer` (MIT), `wasm-bindgen-futures` / `js-sys` (MIT OR Apache-2.0),
  `futures` (MIT OR Apache-2.0).
- Known prior exposure, recorded for honesty: during Day 1–11 reviews the
  author saw the old shim's Cargo.toml (dependency list, MPL field) and the
  top-of-file doc comment of its `lib.rs` (facade idea: re-export tokio on
  native). The facade *idea* is dictated by Cargo (one source per dependency
  name across targets; see patch 0003) and is not copyrightable expression.

## Why a facade exists

Core's crates depend on `tokio` by name. Cargo cannot pick a different
package for the same dependency name per target, so patches 0002/0003 rename
`tokio` → this crate everywhere. Therefore:

- **native** (`not(target_arch = "wasm32")`): must be *exactly* tokio —
  `pub use tokio::*` with feature `full` (macros `#[tokio::test]`/`main`,
  `runtime`, `fs`, `net`, … all unchanged). Zero behaviour change.
- **wasm32-unknown-unknown**: tokio's `rt`/`sync`/`io-util`/`macros` compile
  there, but `fs`, `net`, `time`, `spawn`, `spawn_blocking`, `block_in_place`
  either don't exist or panic. The facade supplies browser-backed versions.

## Required surface on wasm32 (consumer-derived)

Re-exported from tokio unchanged: `io` (traits, `duplex`, `BufReader`,
`BufWriter`, `BufStream`, `copy_bidirectional`, …), `sync` (`Mutex`,
`RwLock` + guards, `OnceCell`, `Notify`, `Semaphore`, `oneshot`, `watch`,
`mpsc`, `broadcast`), macros `select!`, `join!`, `try_join!`, `pin!`,
`task_local!`.

| Module | Items | Semantics on wasm32 |
|---|---|---|
| `time` | `sleep`, `sleep_until`, `timeout`, `interval`, `Instant`, `Duration`, `Sleep`, `Interval`, `error::Elapsed` | JS timers (via `wasmtimer`) |
| `task` (+ root `spawn`) | `spawn`, `spawn_local`, `spawn_blocking`, `block_in_place`, `yield_now`, `JoinHandle` (await → `Result<T, JoinError>`, `abort`, `is_finished`, `abort_handle`), `JoinError` (`is_cancelled`, `is_panic`), `JoinSet` (`new`, `spawn`, `join_next`, `abort_all`, `shutdown`, `len`, `is_empty`), `AbortHandle` | tasks run on the JS microtask queue (`wasm_bindgen_futures::spawn_local`); "blocking" closures run inline (there is one thread) |
| `fs` | `read`, `read_to_string`, `write`, `remove_file`, `remove_dir`, `remove_dir_all`, `rename`, `copy`, `create_dir`, `create_dir_all`, `metadata`, `symlink_metadata`, `try_exists`, `canonicalize`, `read_dir` → `ReadDir::next_entry` → `DirEntry` (`path`, `file_name`, `metadata`, `file_type`), `File` (`open`, `create`, `metadata`, `set_len`, `sync_all`, `sync_data`; `AsyncRead`/`AsyncWrite`/`AsyncSeek`), `OpenOptions` (`read`/`write`/`append`/`truncate`/`create`/`create_new`/`open`), `Metadata` (`is_dir`, `is_file`, `is_symlink`, `len`, `modified`, `accessed`, `created`, `file_type`), `FileType` | process-wide **in-memory** filesystem (blobdir, accounts dir, imex temp files). std-like error kinds (`NotFound`, `AlreadyExists`, `NotADirectory`, `IsADirectory`, `DirectoryNotEmpty`). Relative paths resolve against `/`. No persistence (OPFS is checklist §5, C4 — out of scope). |
| `fs` (sync helpers, Velta API) | `sync_read`, `sync_write`, `sync_remove`, `sync_exists`, `sync_is_dir`, `sync_is_file`, `sync_create_dir_all` | same store, synchronous; used by core `tools.rs` (`path_exists`/`path_is_dir`/`path_is_file`, patch 0005/0008) and the wrapper's JS file side channel |
| `net` | `TcpStream`, `lookup_host`, `ToSocketAddrs` | compile-compatible only; every call returns `io::ErrorKind::Unsupported`. Real transport is core's `net::ws_tcp` (patch 0007) |
| `runtime` | whatever wasm-compiled core still names (compiler-driven) | minimal; no multi-thread runtime |

Not required (consumer has no use): OPFS persistence, SQLite VFS (rusqlite
brings `sqlite-wasm-rs` with its own memory VFS), account-registry sweeping,
crypto offload. The wrapper's own doc states it has no OPFS.

## Requirements discovered while implementing (consumer-driven)

Found by compiling the patched copy against the new crate and by running the
smoke/e2e harnesses — each traced to a concrete call site:

| Requirement | Call site |
|---|---|
| `fs::sync_copy`, `fs::sync_rename` (std signatures) | core `blob.rs` `mod sync_fs` (wasm arm, patch 0007) |
| `fs::ReadDir: futures::Stream<Item = io::Result<DirEntry>>` | core `blob.rs` `BlobDirContents::new` (wasm arm skips `ReadDirStream`) |
| `runtime::Handle::current().spawn_blocking(..)` | core `key.rs` `generate_keypair` |
| `fs::read_link`, `fs::hard_link` | vendored astral-tokio-tar `builder.rs` / `entry.rs` |
| `File::open(<dir>)` succeeds read-only, `sync_all()` ok | core `accounts.rs` `Config::sync` fsyncs the parent dir after `rename` (boot failed with `is a directory: /accounts` until fixed) |
| `fs::sync_write` creates missing parents | wrapper `fs_write` side channel; `example/index.html` and the smoke harness write `/t/x/hello.bin` with no mkdir |

## Acceptance

Same gates as Day 11 with the new crate: refresh-lock, apply-on-copy +
verify-copy, wasm `cargo check --locked` (0 `deltachat` warnings), native
nextest 1135/1135 (native path is plain tokio), wasm-pack + smoke (memfs
roundtrip), local alice→bob e2e, CI `e2e=true`.
