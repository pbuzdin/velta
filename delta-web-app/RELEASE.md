# Velta 1.1.0 — Stable release notes

**Release date:** 2026-08-16  
**Frontend:** Velta PWA (`../app`)  
**Core:** deltachat-core-rust 2.59.0

## What changed since 1.0.0

### Fixed

- **Onboarding sync:** after creating a chatmail account via `set_config_from_qr`,
  the core now explicitly starts I/O so messages arrive without restarting the app.
  This fixes contact requests and group invites not showing up on the first run.
- **Tauri ACL:** added `core:event:allow-listen/emit/unlisten` capabilities for
  both desktop (`default.json`) and mobile (`mobile.json`), so the frontend no
  longer falls back to demo mode.
- **Android safe area:** headers and bottom controls now respect
  `env(safe-area-inset-top/bottom)` so the UI does not overlap the system status
  bar or gesture navigation bar.
- **Closed drawer pointer events:** a closed drawer no longer blocks clicks on the
  underlying sidebar.

### Added

- Runtime boot diagnostics and event-loop logging in the frontend, written to
  `velta.log` via the Tauri `js_log` command.
- This README and release notes documenting the architecture, file layout, and
  build/signing steps for Windows and Android.

## Known limitations

- The Windows build still uses a separate `deltachat-rpc-server.exe` sidecar
  process. The Android build links the core in-process as a native library.
- Real attachment/file sending is not yet implemented; the attach menu sends
  placeholder messages.
- Desktop builds outside Windows are not regularly tested but should work with
  the same Tauri commands.

## Artifacts

- Windows: `src-tauri/target/release/bundle/msi/Velta_1.1.0_x64_en-US.msi`
- Windows: `src-tauri/target/release/bundle/nsis/Velta_1.1.0_x64-setup.exe`
- Android: `app-universal-release-signed.apk`
