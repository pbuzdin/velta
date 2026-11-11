# Velta KMP client — agent notes

Native Android + Desktop client (Kotlin Multiplatform + Compose Multiplatform).
Tracking issue: **#192**. Phase status + honest gaps: **docs/PHASES.md**.
Read this file before touching anything in this folder.

**2026-11-12: this folder is the Android delivery track** (flip decision —
the Rust UI preview is a lab, verdict in #314; public write-up
velta.cc/news/rust-ui-take.html). Phase plan in #192: N1 design port
(Prism + identity matrix — shipped, see PrismIdentityTest), N2
conversation notifications + RPC hardening, N3 AGSL glass, N4 release.

## Layout

```
composeApp/src/
  commonMain/    Compose UI + AppModel + VeltaCore facade (PURE Kotlin — no java.*: compile fails even for JVM-only targets)
  jvmCommon/     shared JVM layer: process + socket transports, java.time formatters
  androidMain/   MainActivity (FragmentActivity: BiometricPrompt; NO registered-launcher
                 startActivityForResult — 16-bit crash, use startActivity + AppHolder),
                 AppHolder (process-wide model), VeltaForegroundService, push/VeltaPushService,
                 scan/ScanActivity (CameraX + ZXing), VeltaKeystore + VeltaLock (app lock,
                 dbkey.wrap + dbkey.bio), RpcShim (JNI), CorePlatform impl, MediaAndroid
  desktopMain/   DesktopCorePlatform (sidecar spawn), Main (window + FileDialog),
                 MediaDesktop, PlatformBack actual
  desktopTest/   all tests (scripted transports + real-binary IT)
native/rpc-shim/ Rust cdylib: in-process core for Android (JSON Lines on 127.0.0.1);
                 size-tuned release profile (lto + codegen-units=1 + opt-level=s + strip)
composeApp/proguard-rules.pro — R8 keeps: RpcShim native methods, serialization, UnifiedPush
composeApp/keystore.properties — release signing (gitignored; absent → debug-key fallback)
```

Expect/actual lives in commonMain + one actual per target; anything JVM-only
that BOTH targets need goes in jvmCommon (wire it with `dependsOn(commonMain.get())`).
⚠️ expect/actual files must NOT share a FILE NAME across source sets — the
JVM facade classes collide (Media.kt → MediaAndroid.kt/MediaDesktop.kt).
⚠️ ANY source change (including renames) needs the tar-sync below; renames
also need explicit `rm` of the old file in the WSL copy (overlay keeps it).
⚠️ The tar-sync only OVERLAYS: files deleted on the Windows side linger in
~/velta-kmp-build forever (a stale Chrome.kt from Nov 2 survived until it
broke the build with duplicate declarations). `rm` such files explicitly.
⚠️ Every Kotlin file MUST carry its `package` line — a package-less file
lands in the default package and its symbols are unresolvable from
org.velta.kmp.*; the errors appear in the CONSUMING files, not the culprit.
⚠️ FragmentActivity traps: (1) registered ActivityResult launchers crash
with "lower 16 bits for requestCode" — route results through AppHolder
instead; (2) biometric 1.1.0 drags fragment < 1.3 (breaks ActivityResult)
— explicit `fragment-ktx` 1.8.x is in the catalog, keep it.
⚠️ Release builds run lintVitalRelease, which catches what debug builds
don't — run `assembleRelease` locally before shipping build-file changes.

## Ground rules

- The JSON-RPC contract is frozen: deltachat **JSON Lines over stdio/socket**,
  **positional params** (`#[rpc(all_positional)]`), one yerpc session per
  connection. Never introduce a second API surface.
- The PWA (`/app`) stays build-less and untouched — different client, same core.
- `.so` files are NEVER committed (`jniLibs/**` gitignored; same rule as the
  Tauri `binaries/`). Build per machine/CI.
- Repo-wide: no private relay hostnames/IPs in tracked files or issues.
- Parallel sessions work in this repo: `git status` first, commit named paths
  only, never stash. Pushes go through a temp worktree cherry-pick onto
  `origin/master` (local master runs behind with duplicate commits).

## Build & verify (WSL is the build host)

Every gradle run MUST start with a fresh tar-sync — skipping it once shipped
stale jniLibs and cost an hour:

```sh
wsl.exe -e bash -lc 'export JAVA_HOME="$HOME/.local/jdks/temurin-21"; export PATH="$JAVA_HOME/bin:$PATH"; export ANDROID_HOME="$HOME/Android/Sdk"
tar --exclude=velta-kmp/.gradle --exclude=velta-kmp/build --exclude=velta-kmp/native -cf - -C /mnt/c/Users/pave/Velta/velta velta-kmp | tar -xf - -C ~/velta-kmp-build/
cd ~/velta-kmp-build/velta-kmp
./gradlew --no-daemon :composeApp:desktopTest :composeApp:assembleDebug :composeApp:packageDistributionForCurrentOS'
```

Full local gate = desktopTest + assembleDebug + desktop package, then CI green
(`gh run list --workflow build-kmp.yml`). The real-binary IT needs
`VELTA_KMP_RPC_SERVER=~/velta-core-build/core/target/release/deltachat-rpc-server`
(linux build lives in `~/velta-core-build/core/`).

### Android shim rebuild (only when native/rpc-shim changes)

The Cargo.toml carries a size-tuned release profile (lto +
codegen-units=1 + opt-level=s + strip): 56/64 MB → 25.9/28.7 MB per ABI.
⚠️ The FIRST build after a profile/dependency change recompiles the whole
core under LTO (~10 min in WSL); after that, shim-only edits are ≈ 11 s.

```sh
export NDK=$HOME/Android/Sdk/ndk/29.0.13846066; export TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
export RANLIB=$TC/llvm-ranlib AR=$TC/llvm-ar PATH="$TC:$PATH"
export CC_aarch64_linux_android=$TC/aarch64-linux-android24-clang AR_aarch64_linux_android=$TC/llvm-ar
export CC_x86_64_linux_android=$TC/x86_64-linux-android24-clang AR_x86_64_linux_android=$TC/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$TC/aarch64-linux-android24-clang
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER=$TC/x86_64-linux-android24-clang
cargo build --release --target aarch64-linux-android --target x86_64-linux-android
$TC/llvm-strip <so> -o <stripped>   # 80 MB → 56/64 MB
# copy into composeApp/src/androidMain/jniLibs/{arm64-v8a,x86_64}/libvelta_rpc_shim.so
```

Ring's cc-probe needs the `CC_<target>`/`AR_` vars — NDK 29 ships only
API-suffixed wrappers, no bare `aarch64-linux-android-clang`.

### Emulator flow

Windows-side JDK is 26 (too new for Gradle 8.14) — build the APK in WSL,
copy it to `C:/Users/pave/Velta/build-artifacts/`, install via the
android-emulator plugin (⚠️ Windows adb cannot read `/mnt/c/...` paths; the
plugin handles it), then raw adb
(`C:/Users/pave/AppData/Local/Android/Sdk/platform-tools/adb.exe`):

```sh
adb -s emulator-5554 shell "am force-stop org.velta.kmp; input keyevent KEYCODE_WAKEUP"
adb -s emulator-5554 shell "am start -n org.velta.kmp/.MainActivity"
adb -s emulator-5554 logcat -d | grep velta-kmp     # println only; shim stderr is INVISIBLE
```

Debugging on-device: shim stderr never reaches logcat — rely on the shim's
distinct return codes (-1 generic, -2 bind, -3 accounts), the Kotlin
`velta-kmp:` println lines, and the connect-ok line
(`velta-kmp: connect ok — core v2.66.0, ...`) that lands on every successful
handshake.

Android lifecycle (P4): `AppHolder` holds ONE process-wide `AppModel`
shared by the UI and `VeltaForegroundService`; `connect()` is idempotent.
Verification recipes:

```sh
# Foreground service held after backgrounding:
adb shell "input keyevent KEYCODE_HOME; sleep 2; dumpsys activity services org.velta.kmp" | grep isForeground
# Restart-on-kill: crash the process, the sticky service rebuilds the core:
adb logcat -c; adb shell "am crash org.velta.kmp"; sleep 12
adb shell pidof org.velta.kmp            # NEW pid
adb logcat -d | grep "connect ok"        # service-side handshake line
```

Gotchas: a fresh install shows the POST_NOTIFICATIONS dialog which BLOCKS
everything (`GrantPermissionsActivity` on top) —
`adb shell pm grant org.velta.kmp android.permission.POST_NOTIFICATIONS` +
BACK clears it; `pidof`/`ps` read empty during that transition; emulator
`/tmp` does not survive between wsl.exe calls; Windows-side JDK is 26 —
never run Gradle on the Windows side.

## Protocol facts (verified against vendored core 2.66)

- `get_system_info` → map; version key is **`deltachat_core_version`**.
- Responses carry `"jsonrpc":"2.0"`; errors are `{"id","error":{"code","message"}}`.
- Events = **long-poll `get_next_event`** driven in a loop (BaseDeltaChat pattern).
- Persistence = the accounts dir (`DC_ACCOUNTS_PATH`): `get_all_account_ids`,
  `get_account_info(id).isConfigured`; **the core's selected account persists
  across restarts** (`get_selected_account_id` / `select_account`) — resume
  prefers it; `get_all_accounts` returns every Account in one call;
  `add_account` auto-selects the new account.
- Modern write path is draft-based:
  `misc_set_draft(accountId, chatId, text?, file?, filename?, quotedMessageId?, viewType?)`
  → `misc_send_draft(accountId, chatId)`; `get_draft`/`remove_draft` alongside.
  The core dedups attachment files into its blobdir itself
  (`set_file_and_deduplicate`) — never copy blobs client-side.
- `send_reaction(accountId, messageId, [emoji])` (re-send toggles off).
- Invites: `check_qr(accountId, qr)` parses OFFLINE — kind-tagged oneOf
  ("text" for garbage, "account"+domain for `DCACCOUNT:` invites,
  "askVerifyContact/Group/Broadcast" for secure-join); `secure_join` needs io;
  `add_transport_from_qr` onboards relays.
- Relays: `list_transports` → Vec<EnteredLoginParam> (sending transport
  first, quilt #11), `get_server_metadata` → map addr→metadata (quilt #15),
  `delete_transport(addr)`. ⚠️ `set_transport_enabled` does NOT exist yet
  (quilt #24, issue #189).
- Push: **`velta_set_push_device_token` is a SHIM-ONLY RPC** —
  `Accounts::set_push_device_token` is not on the JSON-RPC surface; the
  shim intercepts it before yerpc dispatch (desktop sidecar rejects it).
  Token = `webpush:<url>|<pubKey>|<auth>`; `background_fetch(timeout_s)`
  IS on JSON-RPC. End-to-end push still needs the relay side
  (PLAN-UNIFIEDPUSH.MD items 1–3).
- Invites/QR: `check_qr(accountId, qr)` parses OFFLINE — kind oneOf
  ("text" for garbage, "account"+domain for `DCACCOUNT:`,
  "askVerifyContact/Group/Broadcast" for secure-join). The KMP scan flow
  hands the decoded payload straight to the model (no ActivityResult).
- App lock (phase-4 port): lock ON → cold start refuses the core
  (`getOrCreateDek` returns null); the DEK lives in an auth-window wrap
  (`dbkey.bio`, 30 s Keystore validity after a prompt); unlock = prompt →
  `unlockDek` inside the window → `spawnRpcServerWithKey(dir, dek)`.
  PIN/Argon2id fallback deferred.
- Message timestamps on the RPC surface are unix SECONDS, not millis —
formatTimestamp/formatDateHeader must use Instant.ofEpochSecond (reading
them as millis rendered every day header as Jan 1970; TimestampTest
guards it).
- Message state numbers (core/src/message.rs): 10=InFresh, 13=InNoticed,
  16=InSeen, 19=OutDraft, 20=OutPending, 24=OutFailed, 26=OutDelivered,
  28=OutMdnRcvd. Wire casing: `MessageLoadResult` kind is **"message"**
  (enum-level camelCase) — a PascalCase filter silently drops every real
  message; `ChatListItemFetchResult` kinds ARE PascalCase ("ChatListItem").
- The server exits when stdin reaches EOF (sidecar); the in-process shim has
  no such trap. Probe a real binary with `(printf '...'; sleep 3) | binary` —
  instant EOF skips the answer.
- `--openrpc` prints the whole method spec — ground truth for signatures.

## Test conventions

- `runBlocking`, never `runTest`, for anything touching real threads/processes
  (virtual time fires timeouts while real IO waits).
- Calls under test go in a **SupervisorJob scope** — a plain `async` child
  failing cancels the `runBlocking` parent before `assertFailsWith` can run.
- Never assert on request ORDER across coroutines; map method → id from the
  recorded sent lines. Poll loops must RE-COMPUTE their indexes each pass
  (a captured `-1` before the coroutine runs = eternal timeout).
- `ScriptedRpcTransport` (method → result JSON) for client/facade tests; a
  method missing from the script never answers = realistic long-poll. When a
  poll times out, check SCRIPT COVERAGE first — a missing entry hangs the
  call silently. Dump requests/status on timeout (DIAG pattern).
- Fixture JSON must match the WIRE, not the Rust struct names: probed truth
  is `kind:"message"` (lowercase) vs `kind:"ChatListItem"` (PascalCase) —
  reading serde attributes instead of probing shipped a silent drop-everything
  bug once. Raw-string JSON concatenation doubles quotes — write one string.
- `runBlocking` + real PNG fixtures for the decoders (DecodeImageTest).
- Prism/identity parity vectors (PrismIdentityTest) come from the WEB
implementation (name-color.js / avatar.js) — the web is the source of
truth. If a vector fails, suspect the port, never the vector: hashing
must feed only the high UTF-16 surrogate for astral code points, and the
identity used-color rule is NAME-based (Magenta and Fuchsia share an RGB
but are distinct pool entries). Re-derive vectors with node when in doubt.

## Desktop run

```
VELTA_KMP_RPC_SERVER=<path to deltachat-rpc-server> ./gradlew :composeApp:run
```
Accounts land in `~/.velta-kmp/accounts`. The Tauri repo's 2.63 exe
(`velta-app/src-tauri/binaries/`) covers every method the client uses today.
