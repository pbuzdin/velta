# Velta preview (Rust UI)

**Status (2026-11-12): this is a lab, not the delivery track.** The Android
app is the Kotlin/Compose client (`velta-kmp/`, #192) — the flip verdict
lives in #314 and at velta.cc/news/rust-ui-take.html. This folder keeps the
renderer experiments (skia/vello hybrid/gpu, glass compositing) and the
design-port references (Prism, identity matrix — the web-parity vectors are
pinned here and mirrored in the Compose client).

An experimental, minimal Velta client written in Rust with
[Masonry](https://github.com/linebender/xilem/tree/main/masonry) and winit.
It runs the chat core in-process (no JSON-RPC). It does not replace the web UI
on Android (#294). Goal and scope: #314. Roadmap with checkboxes: #315.

## What it does

- Chat list, chat view with text bubbles and day separators, multi-line
  wrapping composer (Enter = newline; **Send** sends; text and caret are
  pinned to the theme colors).
- Touch scrolling: Masonry's Portal has no finger-drag panning at the pinned
  rev, so the app bridges winit touch events to `Portal::pan_viewport_by`
  (chat list and chat history both pan; taps go through the normal pipeline).
- Soft keyboard: GameActivity ignores `adjustResize`, so a spacer under the
  composer grows by the IME bottom inset (polled over JNI at 200 ms, only
  while a chat is open and the app is in the foreground) and the composer
  rides above the keyboard. Typed text is read from the keyboard buffer,
  since winit drops GameActivity text events; the caret stays at the end.
- Bottom action bar: **Chats**, **Add by link**, **My QR**.
- Links work like in Velta: paste any link on **Add by link**. A relay link
  (`dcaccount:`/`dclogin:`) creates your account on first run and adds a
  relay after that; a friend's, group or channel invite starts the chat; a
  `socks5://` link adds a proxy. First run opens this screen with a
  **Create account** button for the default relay (`nine.testrun.org`).
  **My QR** shows your invite QR for Velta to scan.
  To change the default relay: `am start -n
  cc.velta.preview/com.google.androidgamesdk.GameActivity --es relay <host>`
  (Android) or `VELTA_RELAY=<host>` (desktop).
- A startup log strip at the top shows timings for each step.
- Gestures as in Velta: swipe left anywhere in a chat to go back; swipe a
  bubble right to reply (a "Reply to" banner sits over the composer, and the
  message goes out quoted). Quotes show inside bubbles.
- Back (Android) or Escape (desktop) goes from a chat to the list; on the list
  it sends the app to the background.

## On-device numbers (vivo V2307A, Android 15, hybrid renderer, GameActivity)

Measured 2026-11-11, `velta-preview-game-hybrid` `52b81d7e`, configured account
(3 chats), warm process table against the Tauri web app (`org.velta`) on the
same phone, same session:

| Metric | Rust preview (GameActivity) | Tauri web app |
|---|---|---|
| Cold start, first Android frame (`am start -W` TotalTime) | **157 ms** | 184 ms |
| Usable: chat list built (startup strip) | **+519 ms** | not measured yet |
| Chat list rebuild (live event) | 3–13 ms | — |
| TOTAL PSS | 126 MB | 113 MB (+38 MB swap) |
| TOTAL RSS | 277 MB | 281 MB |

Both apps carry the full core in-process, which is why PSS is close. The
preview's strip logs each step; `adb logcat -s velta-preview` reproduces.

Verified working on device: boot, chat list with unread pills, chat view
(text + image filename placeholders), live incoming updates while open,
Back (chat→list→background), mark-read on open, account intact across
reinstall, **composer above the soft keyboard (insets verified)**.
Open: typed-text rendering in the new raw-TextArea composer and touch
scrolling landed together (build `55c11b69`) — on-device pass pending;
chat-list rebuilds fire more often than needed (listener over-triggers —
harmless, 3–13 ms each).

## Vivo testing quirks (V2307A)

- Installs hang (`adb install` never returns) when the phone wants a
  USB-debugging / vivo "install via USB" confirmation, or right after
  `adb kill-server` (device goes `unauthorized`). Allow the dialog, retry.
- Force-stop the app before installing; installs over a live process hang.
- The first boot right after an install can come up silent (no log strip,
  black surface — the native lib load stalls). Force-stop and start again:
  the second boot is clean.
- A piped `adb install | tail` hides failures (pipeline exit = tail's).
  Check `dumpsys package cc.velta.preview | grep lastUpdateTime` instead.

## Renderers

Chosen at build time with Cargo features:

| Feature  | Renderer             | Notes |
|----------|----------------------|-------|
| `gpu` (default) | vello (wgpu compute) | **Do not ship on Android.** On the vivo (Adreno/GLES) it deadlocks in surface/adapter init: no first frame, no logs, every thread asleep; same story under both activity backends. Keep for desktop only. |
| `hybrid` | vello_hybrid (CPU + GPU) | Works on the phone (see numbers above). No colour emoji yet. |
| `skia` | imaging_skia (GPU, wgpu-backed) | **Renders on the vivo** (booted 157 ms, full UI, colour emoji 🎉 — unlike hybrid). The glass-enabler: Skia's image filters (displacement maps, blur) are the only real-refraction path in this stack — see docs/agents/rust-ui-glass.md. Feel/frame-time comparison pending. |

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

## Glass prototype (`rust-ui-glass` only)

The Rust UI remains a **work-in-progress experiment**. Build with
`--no-default-features --features hybrid,glass` (or `gpu,glass` on desktop).
Default desktop builds enable `gpu,glass`; Android CI explicitly enables glass
for both activity backends. Omit `glass` for the plain dark translucent bar.

Only `vendor/masonry_winit` is patched (xilem `dc49687`; see `vendor/README.md`).
The host renders root content into A and transparent overlays into B, then a
WGSL pass refracts A inside the floating bottom capsule and alpha-composites B.
Rounded-rect SDF normals bend the rim, the centre stays flat; a nine-tap blur,
subtle colour split, dark tint and specular rim finish the lens. Buttons/text
stay sharp and retain Masonry hit-testing. The bar disappears in chats, as
before; list/add/QR contents have scrollable bottom clearance. Geometry updates
before redraw after resize/DPI changes, with no animation timer.

GPU-host only (hybrid or gpu); no CPU/Skia implementation. This is approximately
one copy-like full-window composite plus a small fragment effect in glass rects,
**in addition to two scene replays and the existing presentation blit**. Two
extra RGBA8 window textures (8 bytes per physical pixel total) are reused until
resize, with no per-frame GPU resource recreation. Cost and battery impact on
the vivo are not measured yet; do not call the effect free. Global rectangle
state supports one window, at most 16 non-overlapping lenses; the prototype
refracts only root content, not earlier overlays. GPU/Vello is still not for
Android on the vivo; use hybrid. No rendering-engine patch is needed.

For synthetic screenshots without a real account or sending any messages:
`cargo run --example glass_fixture -- /tmp/velta-glass-fixture`, then run the
preview with that directory and tap **Chats**. The fixture refuses existing
directories and only creates local groups/drafts with an invalid example address.

Desktop verification: hybrid+glass and gpu+glass build; hybrid without glass
builds too. The host tests pass on software GLES, including real imaging
foreground alpha, backdrop preservation and clearing stale overlay pixels.
Run them with `WGPU_BACKEND=gl cargo test -p masonry_winit
--no-default-features --features imaging_vello_hybrid,glass --lib -- --include-ignored`
(or `imaging_vello,glass` for the compute backend). Phone performance and gesture
feel still need an on-device pass; the broken Android emulator was not used.
