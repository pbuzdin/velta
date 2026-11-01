# Velta KMP client — agent notes

Native Android + Desktop client (Kotlin Multiplatform + Compose Multiplatform).
Tracking issue: **#192**. Phase status + honest gaps: **docs/PHASES.md**.
Read this file before touching anything in this folder.

## Layout

```
composeApp/src/
  commonMain/    Compose UI + AppModel + core facade (PURE Kotlin — no java.*: compile fails even for JVM-only targets)
  jvmCommon/     shared JVM layer: RpcClient's process transport, socket transport, java.time formatters
  androidMain/   MainActivity, AndroidCorePlatform (JNI shim), manifest
  desktopMain/   DesktopCorePlatform (sidecar spawn), window entry
  desktopTest/   all tests (scripted + real-binary IT)
native/rpc-shim/ Rust cdylib: in-process core for Android (JSON Lines on 127.0.0.1)
```

Expect/actual lives in commonMain + one actual per target; anything JVM-only
that BOTH targets need goes in jvmCommon (wire it with `dependsOn(commonMain.get())`).

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

### Android shim rebuild (only when native/rpc-shim changes; deps cached ≈ 11 s)

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

Windows-side JDK is 26 (too new for Gradle 8.14) — build in WSL, copy the APK
to `C:/Users/pave/Velta/build-artifacts/`, then the android-emulator plugin or
raw adb (`C:/Users/pave/AppData/Local/Android/Sdk/platform-tools/adb.exe`):

```sh
adb -s emulator-5554 shell "am force-stop org.velta.kmp; input keyevent KEYCODE_WAKEUP"
adb -s emulator-5554 shell "am start -n org.velta.kmp/.MainActivity"
adb -s emulator-5554 logcat -d | grep velta-kmp     # println only; shim stderr is INVISIBLE
```

Debugging on-device: shim stderr never reaches logcat — rely on the shim's
distinct return codes (-1 generic, -2 bind, -3 accounts) and the Kotlin
`velta-kmp:` println lines.

## Protocol facts (verified against vendored core 2.66)

- `get_system_info` → map; version key is **`deltachat_core_version`**.
- Responses carry `"jsonrpc":"2.0"`; errors are `{"id","error":{"code","message"}}`.
- Events = **long-poll `get_next_event`** driven in a loop (BaseDeltaChat pattern).
- Persistence = the accounts dir (`DC_ACCOUNTS_PATH`): enumerate with
  `get_all_account_ids`, check `get_account_info(id).isConfigured`.
- Modern write path is draft-based:
  `misc_set_draft(accountId, chatId, text?, file?, filename?, quotedMessageId?, viewType?)`
  → `misc_send_draft(accountId, chatId)`; `get_draft`/`remove_draft` alongside.
  `send_reaction(accountId, messageId, [emoji])` for reactions.
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
  recorded sent lines.
- `ScriptedRpcTransport` (method → result JSON) for client/facade tests;
  a method missing from the script never answers = realistic long-poll.
- Raw-string JSON in tests: concatenate fragments and you WILL double a quote
  — the unparseable line is logged, not fatal, and the test hangs on the
  missing response. Dump requests/status on timeout.

## Desktop run

```
VELTA_KMP_RPC_SERVER=<path to deltachat-rpc-server> ./gradlew :composeApp:run
```
Accounts land in `~/.velta-kmp/accounts`. The Tauri repo's 2.63 exe
(`velta-app/src-tauri/binaries/`) covers every method the client uses today.
