# Velta preview: agent guide

Read the root `AGENTS.md` first for repo rules (commit identity, "Refs #N",
no force-push, no private hostnames). This file covers only `rust-ui/preview`.

- Issues: goal #314, roadmap #315 (tick boxes there as work lands).
- First-run relay override: `VELTA_RELAY` env (desktop) or `relay.txt` in the
  accounts dir / app files dir (Android, placed via `adb push` + `run-as`;
  the test APK is debuggable for exactly this). Bare hostnames get the
  `dcaccount:` scheme. Never commit a private relay hostname — repo rule.
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
  `ApplicationHandler` around `MasonryState` (needed to catch Back and to
  bridge touch events into Portal panning).

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
- **Clipped labels are measured at full text width**, even inside a flexible
  child of a constrained Portal, so a long one-line label pushes its row past
  the screen. Chat rows use wrapping labels with text shortened by `short()`.
- Android draws edge to edge: the log strip has extra top padding and the
  composer extra bottom padding (status bar and gesture bar).
- **TextInput is single-line by design.** Its docs say so; a multiline
  TextArea child inside it broke typed-text rendering and two-line layout.
  For a multi-line composer use a raw `TextArea::new_editable("")` widget
  (with `ContentColor`/`CaretColor` pinned for the dark surface) — `TextArea`
  is the interactive core `TextInput` wraps, and `TextAction` still flows.
- **Portal has no touch drag-to-pan at rev dc49687** — only wheel scrolls and
  accessibility actions. Touch scrolling is bridged in `App::window_event`
  (winit `Touch` events → `Async::Pan(dy)` → `Portal::pan_viewport_by`,
  physical dy divided by `root.scale_factor()`). List and chat portals both
  take a unique tag stored on the screen, since screen portals are rebuilt.
- **Widget properties can't be updated in place** on a live widget (no
  prop-mutation API on `WidgetMut` at this rev). The IME spacer works around
  it by using a plain `SizedBox` under the composer and mutating its height
  via `SizedBox::set_height` — rebuild-free, so input focus never drops.
- `CaretColor` here is a plain struct (`CaretColor { color }`), not
  constructed via `new`.
- **GameActivity ignores `windowSoftInputMode="adjustResize"`** (verified on
  a V2307A). The layout pads itself: a JNI poller (`ime_bottom`, 200 ms)
  reads the IME bottom inset from the decor view
  (`WindowInsets.Type.ime()` — Insets lives in **android.graphics**, not
  android.view) and posts `Async::Insets`, which sizes the spacer. Any JNI
  failure must clear the pending exception or the poller thread crashes the
  app (`NoSuchMethodError` did exactly that once).

## Build locally

Desktop:

```
cargo run --release -- /path/to/accounts
```

Android has **two activity backends**, picked by a feature; exactly one per
build (an Android build with neither fails to compile winit):

- `native-activity` — framework NativeActivity, packaged by cargo-apk.
- `game-activity` — androidx.games GameActivity (proper IME/insets for the
  composer), packaged by the Gradle shell in `android/`. cargo-apk cannot
  ship it: GameActivity is not a framework class and cargo-apk embeds no
  Java classes. This is the backend Phase 0 of #315 is migrating to.

NativeActivity (needs NDK r27, SDK platform 35, JDK 17, `cargo install cargo-apk --version 0.10.0`):

```
env "RANLIB_aarch64-linux-android=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ranlib" \
  CARGO_APK_RELEASE_KEYSTORE=/path/test.jks CARGO_APK_RELEASE_KEYSTORE_PASSWORD=android \
  cargo apk build --release --lib --no-default-features --features hybrid,native-activity
```

GameActivity (same NDK/SDK/JDK, plus Gradle 8.12; AGP is fetched by Gradle):

```
NDKB="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"; export PATH="$NDKB:$PATH"
env "RANLIB_aarch64-linux-android=$NDKB/llvm-ranlib" \
  "AR_aarch64_linux_android=$NDKB/llvm-ar" \
  "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDKB/aarch64-linux-android28-clang" \
  cargo build --release --lib --target aarch64-linux-android \
  --no-default-features --features hybrid,game-activity
mkdir -p android/app/src/main/jniLibs/arm64-v8a
cp target/aarch64-linux-android/release/libvelta_preview.so android/app/src/main/jniLibs/arm64-v8a/
cd android && echo "sdk.dir=$ANDROID_HOME" > local.properties && gradle --no-daemon :app:assembleRelease
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
- Vivo (V2307A) install/boot quirks — see README "Vivo testing quirks":
  install dialogs can leave adb hanging (check `lastUpdateTime`, not adb's
  exit), force-stop before installing, and a first boot right after an
  install may come up silent — restart the app once before diagnosing.
- Drive taps only with the user's say-so; the phone is a daily driver.

## CI

`.github/workflows/build-rust-preview.yml` runs on pushes to `rust-ui-preview`
that touch `rust-ui/preview/**` and on manual dispatch. Two jobs, each with a
`gpu`/`hybrid` matrix: `apk` (NativeActivity via cargo-apk) and
`apk-gameactivity` (Gradle shell, artifacts `velta-preview-game-*-arm64`).
Both sign with the test keystore cached under
`velta-preview-test-keystore-v1`, so any flavor installs over any other.
