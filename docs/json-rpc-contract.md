# JSON-RPC is the core contract

Four shells talk to the same vendored Delta Chat core (`core/`, 2.66). The
only supported core API is **JSON-RPC 2.0** from `core/deltachat-jsonrpc`
(yerpc `CommandApi` / `RpcSession`). Method names and positional params
are those in `core/deltachat-jsonrpc/src/api.rs` (`#[rpc(all_positional)]`);
`deltachat-rpc-server --openrpc` dumps the spec.

A new core capability is a new JSON-RPC method (or a row in the exception
table below). It is not a new `deltachat::` call from a shell, a new env
var, or a new JNI/wasm export that skips the session.

UI code (`app/js/rpc-core.js`, `velta-kmp/…/VeltaCore.kt`) must keep using
that surface. Demo mode (`app/js/mock-core.js`) implements the same
methods.

---

## Allowed surface per shell

### 1. Desktop Tauri — sidecar stdio

`velta-app` does **not** link the core. It spawns `deltachat-rpc-server`
(`SIDECAR_NAME`) with cwd = the accounts dir and speaks JSON Lines on
stdio.

- Page: `app/js/transport.js` `tauriTransport` → `invoke("rpc", { request })`.
  `rpc` in `velta-app/src-tauri/src/lib.rs` writes one line to sidecar
  stdin (`write_rpc_stdin`). Desktop (#49) parks the JSON-RPC id in
  `RpcState.web_pending` and **returns** the matching response line; the
  `velta-rpc` event carries only what the core pushes (notifications).
- Shell itself: `sidecar_call` (ids `velta-shell-*`) — same stdin/pending
  path. `proxy_desktop.rs` uses it for `get_config` / `set_config` /
  `start_io` / `maybe_network`.
- webxdc protocol handler: JSON-RPC with ids `wxdc-*`, routed into
  `RpcState.wxdc_pending` (`webxdc_serve.rs`). Still JSON-RPC.

**Known reach-around:** sidecar respawn swaps stdin. `spawn_sidecar`
kills the previous child (`SIDECAR_CHILD`), starts a new process (the
SQLCipher key rides `VELTA_DB_KEY` on the process env, so re-keying
means a new process), and replaces only `RpcState.stdin`. The reader
thread is tied to that spawn's stdout; in-flight `web_pending` waiters
see "rpc response channel dropped (sidecar restart?)". Lock/unlock
(`unlock_with_pin`) depends on this. Do not "simplify" by writing to a
dead child's stdin.

### 2. Android Tauri — in-process yerpc

Same JSON-RPC methods, no sidecar. `init_android_core` builds
`deltachat_jsonrpc::api::Accounts` + `CommandApi` + `yerpc::RpcSession`
inside `libvelta_app.so`. Requests arrive on an mpsc (`RpcState.tx`);
`session.handle_incoming` runs them; responses/events emit `velta-rpc`.

- Page: the same `invoke("rpc")` command (write-only on Android; the
  forwarder emits every line).
- Headless (push / `CoreService` / job / alarm): `ensure_android_core`
  reuses the one `ANDROID_CORE` so two `Accounts` never share a
  directory. `bg_rpc` (`bg-*` ids, `bg_events.rs`) is still JSON-RPC —
  `background_fetch` and `get_next_event_batch` go through the session.

The crate **does** link `deltachat` (`Cargo.toml` android target) so the
shell can hold `ANDROID_ACCOUNTS` and call `Context` methods. That is
the in-process exception, not a second API. See the table.

### 3. PWA wasm — worker JSON-RPC

No native shell. `transport.js` (only when `VELTA_PWA.wasmCore` /
`?wasm=1` and no `__TAURI__` / `VeltaBridge`) boots
`WorkerWasmTransport` → module worker `app/js/worker-wasm.js` →
`packages/velta-wasm` `init` / `DeltaChat.receive`.

The wrapper is the same `Accounts` + `CommandApi` + `RpcSession`. JS
sends a JSON-RPC line; `on_message` posts one back. File/blob reads for
the page (`readCoreFile`, identity backup, `/blob?p=`) are memfs/sqlite
VFS helpers on the wrapper, not core mail methods.

### 4. KMP — JNI/FFI JSON-RPC (not direct core types)

Kotlin never imports core Rust types.

- **Android:** `RpcShim.startCore` (`native/rpc-shim`) loads
  `libvelta_rpc_shim.so`, which mirrors `deltachat-rpc-server` (Accounts
  + CommandApi + RpcSession) and serves **JSON Lines on 127.0.0.1**.
  `SocketRpcTransport` is the byte pipe; `RpcClient` / `VeltaCore` are
  the typed facade.
- **Desktop:** spawn `deltachat-rpc-server` (`ProcessRpcTransport`,
  `DC_ACCOUNTS_PATH`). Same JSON Lines.

The shim's only extra method is `velta_set_push_device_token` (intercept
before yerpc). That is listed as **fix** below.

---

## Known exceptions

| Exception | Shells | Keep / fix | One-line reason |
|---|---|---|---|
| Sidecar respawn stdin-swap (`SIDECAR_CHILD` → `RpcState.stdin`) | Desktop Tauri | **keep** | DEK is process env; lock/unlock must replace the child without dropping the managed `RpcState`. |
| `VELTA_DB_KEY` env (`x'<64 hex>'`) | Desktop sidecar spawn; Android `init_android_core`; KMP shim `start_core` | **keep** | Quilt #20: SQLCipher open inside `Accounts::load_accounts` / `add_account`. JSON-RPC has no `open` / `change_passphrase`. Unset = upstream empty passphrase. |
| Pre-open SQLCipher migrate (`db_key.rs`) | Desktop + Android Tauri | **keep** | Plaintext `dc.db` must be rewritten before `Accounts::new` opens the files. |
| `ANDROID_ACCOUNTS` + `deltachat::Context` (`proxy_android.rs`; headless `start_io`; `stop_background_fetch`; UnifiedPush `set_push_device_token`) | Android Tauri | **keep** (narrow) | In-process owner for headless proxy/push/IO. Desktop twin already uses JSON-RPC (`proxy_desktop` / `sidecar_call`). Do not add more `Context` calls — use `bg_rpc` or a new method. |
| `Accounts::set_push_device_token` not on JSON-RPC | Android Tauri JNI; wasm `DeltaChat.set_push_device_token`; KMP `velta_set_push_device_token` intercept | **fix** | Same Accounts method, three wrappers. Add a real jsonrpc method and drop the intercept/wasm-only export/JNI apply. |
| Wasm memfs + sqlite VFS (`vfs_*`, `sqlite_*`, OPFS checkpoint) | PWA | **keep** | Persistence for an in-memory core; not chat/mail state. |
| Wasm `deltachat::net::ws_tcp::set_ws_proxy_url` | PWA `init` | **keep** | Browser cannot dial IMAP/SMTP; the tunnel URL is process config, set once before the session. |
| PWA snapshot KEK (`dbKey` / `db-crypt.js`) | PWA | **keep** | Encrypts the OPFS snapshot. Not `VELTA_DB_KEY` / SQLCipher. |
| Attachment encrypt + Range serve (`velta-attachment`, `ATTACHMENT_KEY`, `blobfile://`, `write_attachment`) | Desktop + Android Tauri | **keep** | Shell-side media protocol (WebView Range). Core quilt #22 already encrypts blob writes inside the core. |
| Other Tauri commands (p2p, proxy *store*, ws_transport, scheduled, lufi, cryptex, notify, share, lock, media, battery, …) | Tauri shells | **keep** | OS/shell capabilities. They must not grow a second copy of core mail state. Core-visible proxy *settings* on desktop already go through JSON-RPC. |

Shell-side state that *mirrors* core state (saved SOCKS5 list, scheduled
outbox, notify prefs) is allowed only as a cache or a queue the shell
owns. The source of truth for accounts, chats, messages, and transports
is the JSON-RPC session.

---

## Rule for new features

1. **New core capability** → new method on `CommandApi` (quilt op on
   `core/` if the implementation is not already there) + `rpc-core.js` +
   `mock-core.js`. KMP adds a `VeltaCore` wrapper if that client needs it.
2. **New OS/shell capability** (picker, notification, protocol handler,
   biometric) → a Tauri/JNI/Compose API that does **not** call
   `deltachat::` types.
3. **New bypass** (env var, JNI into `Accounts`, wasm export that holds
   `Accounts` besides `receive`) is forbidden unless this table gets a
   **keep** / **fix** row with a one-line reason.

Reviewers of KMP slices and core patches: if a change is not expressible
as JSON-RPC on every shell, it is not done.
