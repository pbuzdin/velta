# Velta preview: agent guide

Read the root `AGENTS.md` first for repo rules (commit identity, "Refs #N",
no force-push, no private hostnames). This file covers only `rust-ui/preview`.

- Issues: goal #314, roadmap #315 (tick boxes there as work lands).
- Branch: `rust-ui-preview`. Not merged into master.
- Standalone crate with its own `[workspace]` and a pinned `Cargo.lock`
  (force-added, since `**/Cargo.lock` is gitignored). Keep the lock committed.
- Uses the vendored core at `../../core` as a path dependency. Do not change
  core from here; core changes go through `tools/apply-core-patches.py`.
- Masonry and masonry_winit are pinned to xilem rev `dc49687`. Bump on purpose,
  never implicitly.

## Layout

- `src/lib.rs`: startup log (`say`, `log_text`), `android_main`,
  `to_background` (JNI `moveTaskToBack`).
- `src/main.rs`: desktop entry.
- `src/core.rs`: synchronous wrapper around the chat core (own tokio runtime),
  event listener that reports `Change::Chatlist` / `Change::Chat(id)`.
- `src/ui.rs`: screens (list, chat, invite) swapped inside one `BODY` slot,
  the `Driver` (Masonry `AppDriver`) and `App`, our own winit
  `ApplicationHandler` around `MasonryState` (needed to catch Back).

## Masonry gotchas (learned the hard way)

- **Tags are never released.** When a tagged widget is removed, its tag stays
  mapped to the dead widget id, and re-adding the same named tag is silently
  ignored in release builds. Editing it later panics deep in Masonry
  ("cannot find child ... returned by children_ids()"). Use named tags only for
  widgets that live for the whole app; anything rebuilt gets
  `WidgetTag::unique()` stored with the screen (see `ChatTags`).
- **Android window appears late.** The window exists only after the activity
  resumes. Async actions posted earlier are dropped, so the first screen is
  built on the first async action that arrives (`Driver::built`).
- **winit marks every key as handled on Android**, so Back never reaches the
  system. It is caught in `App::window_event` and turned into `Async::Back`.
- Masonry tracing goes to systrace, not logcat; `android_logger` is set up in
  `android_main`.
- `CrossAxisAlignment` has `Stretch`, not `Fill`.

## Build locally

Desktop:

```
cargo run --release -- /path/to/accounts
```

Android (needs NDK r27, SDK platform 35, JDK 17, `cargo install cargo-apk --version 0.10.0`):

```
env "RANLIB_aarch64-linux-android=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ranlib" \
  CARGO_APK_RELEASE_KEYSTORE=/path/test.jks CARGO_APK_RELEASE_KEYSTORE_PASSWORD=android \
  cargo apk build --release --lib --no-default-features --features hybrid
```

- `--lib` is required (the crate is both bin and cdylib).
- The vendored OpenSSL needs the `RANLIB_<target>` variable above. Its name has
  dashes, so bash `export` rejects it; pass it with `env`.
- cargo-apk only accepts SDK platforms up to the NDK's max level (35 for r27).
- For the x86_64 emulator add `--target x86_64-linux-android` and the matching
  `RANLIB_x86_64-linux-android`.

## Testing

- Emulator: drive with `adb shell input tap X Y` and read
  `adb logcat -d -s velta-preview`. A panic is logged with the `panic:` prefix.
- Always test "open chat, Back, open chat again" after touching `ui.rs`.
- The emulator uses a software GPU, so it can't reproduce real-GPU problems;
  ask for a phone test of both APKs.

## CI

`.github/workflows/build-rust-preview.yml` runs on pushes to `rust-ui-preview`
that touch `rust-ui/preview/**` and on manual dispatch. It builds `gpu` and
`hybrid` arm64 APKs and uploads them as artifacts. The test keystore is cached
under `velta-preview-test-keystore-v1`.
