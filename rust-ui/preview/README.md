# Velta preview (Rust UI)

An experimental, minimal Velta client written in Rust with
[Masonry](https://github.com/linebender/xilem/tree/main/masonry) and winit.
It runs the chat core in-process (no JSON-RPC). It does not replace the web UI
on Android (#294). Goal and scope: #314. Roadmap with checkboxes: #315.

## What it does

- Chat list, chat view with text bubbles and day separators, plain-text composer.
- First run creates an account on `nine.testrun.org` and shows an invite QR
  (tap **Invite**). Scan it from Velta to start a chat.
- A startup log strip at the top shows timings for each step.
- Back (Android) or Escape (desktop) goes from a chat to the list; on the list
  it sends the app to the background.

## Renderers

Chosen at build time with Cargo features:

| Feature  | Renderer             | Notes |
|----------|----------------------|-------|
| `gpu` (default) | vello (wgpu compute) | Black screen and lag on at least one real phone. |
| `hybrid` | vello_hybrid (CPU + GPU) | Works on the phone. No colour emoji yet. |

## Android activity backends

A second build-time axis, mutually exclusive: `native-activity`
(framework NativeActivity, packaged by cargo-apk) or `game-activity`
(androidx.games GameActivity via the Gradle shell in `android/` — the
backend with proper IME and insets support that the composer needs, and
where #315 Phase 0 is heading).

## Desktop (Linux)

```
cargo run --release -- /path/to/accounts-dir
```

The accounts dir uses the same layout as other Velta clients, or set
`VELTA_ACCOUNTS`. Without one, a new account is created.

## Android

Install the APK from the **Build Rust preview APK** workflow
(`.github/workflows/build-rust-preview.yml`): open the latest run on the
`rust-ui-preview` branch and download `velta-preview-hybrid-arm64`,
`velta-preview-gpu-arm64` (NativeActivity) or the `velta-preview-game-*`
artifacts (GameActivity). All use the package id `cc.velta.preview`, so one
replaces the other, and all install next to the normal Velta app.

The APK is signed with a throwaway test key. Logs:

```
adb logcat -s velta-preview
```

Build locally: see `AGENTS.md`.
