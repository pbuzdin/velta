# Running two isolated Velta desktop instances for testing

Two desktop builds with separate identities give you two real profiles on one
machine — the standard setup for 1:1 tests: Velta Dash transfers, previews,
cross-relay behavior, pair/invite flows — without touching your daily
profile.

The whole trick is the app **identifier**: profiles live under
`%LOCALAPPDATA%\<identifier>\accounts`, and single-instance locking is keyed
on the identifier too. Patch it per build and every exe is its own app.

## 1. Patch the identity (per instance)

Work from a throwaway worktree, never from your main checkout:

```
git worktree add ../velta-test-a master
```

Edit `velta-app/src-tauri/tauri.conf.json`:

| field       | instance A     | instance B      |
|-------------|----------------|-----------------|
| productName | `Velta Test`   | `Velta Test 2`  |
| identifier  | `org.velta.test` | `org.velta.test2` |
| window title| `Velta Test`   | `Velta Test 2`  |

**One identifier per build** — the config is baked in at compile time. Two
instances running side by side = two builds. Never commit this patch.

## 2. Build the sidecar once

The core ships as a sidecar binary that both instances share (each spawns its
own process):

```
cd velta-kmp/native/rpc-shim
# PATH needs perl + nasm (the openssl build uses both)
cargo build --release --bin velta-rpc-server
mkdir -p ../../velta-app/src-tauri/binaries
cp target/release/velta-rpc-server.exe \
   ../../velta-app/src-tauri/binaries/velta-rpc-server-x86_64-pc-windows-msvc.exe
```

The copy is required: tauri validates bundle resources even with
`--no-bundle`.

## 3. Build + stage an instance

```
cd velta-app/src-tauri
cargo tauri build --debug --no-bundle
mkdir -p ../../run-a
cp target/debug/velta-app.exe ../../run-a/
cp <sidecar build output>/velta-rpc-server.exe ../../run-a/
```

`velta-rpc-server.exe` must sit next to `velta-app.exe` — the sidecar lookup
falls back to the exe's directory. Then flip `tauri.conf.json` to the second
identity, rebuild, and stage a second directory (`run-b`). Rebuilding after a
config flip is incremental (~30 s).

## 4. Launch

```
cd run-a
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9224" ./velta-app.exe
```

Use a **unique debug port per instance** (9224, 9225, …) — that also gives
you CDP access for automation (below).

## 5. Register + pair

- Instance A: onboarding → *Create an account* → enter a chatmail relay
  address → a fresh profile is registered on it.
- Instance B: same, a **different relay** if you want to exercise the
  cross-relay path (Dash routes over the peers' own relays either way).
- Pair the profiles: invite QR / invite link from one, accept on the other.
  Open the 1:1 chat and exchange one message — Dash proves the peer via a
  capability header that rides normal encrypted messages.

## 6. A Velta Dash run

- Setting **Velta Dash** on (both sides, on by default).
- 1:1 chat only; the file must be **strictly over 6 MB** (photos may compress
  below the threshold before routing).
- Attach → File: the pending strip shows the route (*"Velta Dash: direct to
  <peer>"*). Send — the receiver's card auto-fetches over iroh and flips to
  *Received*. The diagnostics chat logs each step with an `iroh xfer:` prefix.

## Automation (CDP)

With the debug port up, the page is scriptable over
`http://127.0.0.1:<port>/json/list` — connect to the page WebSocket and use
`Runtime.evaluate` (a ~25-line helper script is enough; keep one per port).
`Page.captureScreenshot` gives per-instance screenshots without window
fiddling.

The native file-open dialog can be driven too: find the `#32770` window,
bring it to the foreground, send the full path + ENTER (PowerShell
`SendKeys` is enough). Scope the search to the right process when two apps
are up.

## Gotchas

- **Wrong identifier → silent instant exit.** If an exe was built with an
  identifier another running instance already uses, single-instance forwards
  the launch there and the new process exits 0 with no window. Keep one
  identity per build directory.
- **Close before restaging.** Windows locks a running exe — kill the app
  before copying a new build over it.
- **Kill by path, not by name.** Both instances share the exe name; kill the
  process whose `ExecutablePath` matches the run directory.
- **Logs are shared.** All instances (and your real install) write the same
  `%LOCALAPPDATA%\Velta\logs\velta.log`. Per-instance logging is toggled in
  Diagnostics → Logging.
- **Account databases are encrypted at rest** — read account state from the
  UI/diagnostics, not from the sqlite files.
- **Profiles persist** across restarts in
  `%LOCALAPPDATA%\<identifier>\`. Delete that directory to reset an instance
  completely.
- Debug builds use a PIN instead of Windows Hello for the database key (the
  dev binary isn't signed) — expect the PIN prompt, not Hello.

## Bench: cold-open sync A/B on one profile

The rig can measure a sync-speed change against the same backlog with two
builds (PR #562's harness):

1. **Fill once.** On the working instance, send the backlog to yourself
   (Saved messages): attachments FIRST, then texts — mailbox order is what
   the fetch walks, so attachments-first is the stall scenario. Self-mail
   reaches the mailbox over the relay (bcc_self) and stays there for ~7
   days, server-side.
2. **Snapshot.** Quit the app, copy
   `%LOCALAPPDATA%\<identifier>\accounts\` somewhere safe. That snapshot is
   the client state BEFORE the backlog existed.
3. **Per variant.** Restore the snapshot, boot the variant's exe, measure
   from the UI: first text visible, all texts, media terminal. The server
   mailbox survives the restores; only the client resets, so every variant
   sees an identical true cold open.

Rules learned the hard way (2026-11-28):

- **A missing or empty `accounts\` dir deadlocks the app-spawned sidecar** —
  `getAccount` never returns and no `accounts.toml` is created. Run the
  sidecar once by hand
  (`VELTA_ACCOUNTS_DIR=... velta-rpc-server.exe < /dev/null`) so it writes
  `accounts.toml` + `accounts.lock`, then the app boots into onboarding.
- **The keychain DEK credential is scoped per identifier**
  (`chat.velta.dbkey.<identifier>`). A fresh keyless dir under an identifier
  that already holds a credential collides with it — the app shows the
  "Velta is locked" overlay (the #178 gate). Bench under its own identifier
  (patch `tauri.conf.json` before the build) instead of deleting anything
  from the keychain: removing that credential bricks the profile it belongs
  to.
- **Every boot can re-wrap the keychain credential.** A snapshot restored
  after any intervening boot of the same profile fails with
  `sqlcipher hmac check failed` and the app falls back to mock. Never boot
  the profile between the snapshot and the measured run — kill-verify
  first (processes by `ExecutablePath`), one instance at a time.
- **A CDP port must be unique per boot.** Two instances launched with the
  same `--remote-debugging-port` leave the eval tools attached to the older
  one, which may hold the profile you just replaced.
- Keep CDP evaluations short and poll from the outside — a long
  `await` inside the page plus a 12 MB upload can wedge the renderer, and
  Windows clamps small `setTimeout`s to ~30 ms, so wall-clock waits in
  automation scripts are not reliable.
