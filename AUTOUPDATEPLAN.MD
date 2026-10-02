# AUTOUPDATEPLAN.MD — auto-update roadmap (remaining: Android)

## Shipped (records live elsewhere)

- **Windows (and macOS) self-update — SHIPPED v1.4.20.** Flow, signing, and
  the release-pipeline gotchas are documented in README ("One-click
  updates") and AGENTS.md §4.3/§9.2 (ACL platforms, `.sig` glob,
  `latest.json` asset ordering, keypair backup). Nothing unique remains
  here; the old implementation record was removed 2026-10-02.

## Phase 2 — Android: in-app download + system installer (1–2 days, NOT STARTED)

No official Tauri updater on Android, and sideloaded apps can't silently
self-update — the practical ceiling is: download the APK in the app, hand
it to the system package installer. One tap + one system dialog.

1. `lib.rs`: extend the update path with a streaming
   `download_update(url) -> saved path` command (ureq already in the tree;
   write to app cache dir `updates/`, emit progress events — same pattern
   as `imex-progress`).
2. Kotlin command `install_update_apk(path)`:
   - Android 8+: `ACTION_INSTALL_PACKAGE` with a `FileProvider` content
     URI (never a raw file path).
   - Prefer the `PackageInstaller` session API on API 30+ (cleaner,
     updates in place).
   - Before installing, check
     `packageManager.canRequestPackageInstalls()`; if false, send the user
     to `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` for Velta and retry.
     Add `REQUEST_INSTALL_PACKAGES` to the manifest.
3. Frontend: on Android the banner button becomes "Download & install" —
   progress on the banner, then the system installer dialog takes over.
   The app is replaced and relaunched by the installer.
4. `versionCode` must increase with every release — it already does
   (tauri.conf version feeds the monotonic `10040xx` code).

Caveats:

- Same release keystore = in-place upgrade with account data intact. This
  is already true for every pipeline build; keep it that way.
- Vivo/Xiaomi ROMs hide the unknown-sources toggle in vendor-specific
  places — expect one support question.
- The installer leaves the app while installing; that is normal and the
  system relaunches Velta afterwards.

## Phase 3 (optional, only if ever needed) — richer update feed

If per-platform URLs are ever needed beyond the fixed ones, upgrade
`version.txt` to a small `latest.json` variant; keep serving plain
`version.txt` — 1.4.14–1.4.17 installs parse only that.

## Explicitly rejected

- Play Store in-app updates: Velta is not distributed through Play.
- True silent auto-update on Android: requires device-owner or Play, both
  outside this distribution model.
