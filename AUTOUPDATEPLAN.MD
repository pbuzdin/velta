# AUTOUPDATEPLAN.MD — in-app auto-update for Windows and Android

Plan for turning the update banner (version check + Download button) into a
real self-update flow. Written 2026-09-20 against v1.4.17; verify plugin
APIs against the current Tauri v2 docs at implementation time.

## Current state (already in place)

- Update feed: every release publishes `version.txt`; apps fetch it
  shell-side (`get_latest_version` ureq command in lib.rs) and the drawer
  shows an update banner when it reports something newer (ui.js
  `checkForUpdate`).
- Download today: "Download APK" opens the GitHub release URL in the
  system browser (Android), nothing on Windows. The user installs by hand.
- Release pipeline (`release.yml`) already publishes `Velta-<version>-arm64.apk`,
  `Velta_<version>_x64-setup.exe` and `version.txt`; signing keys are in
  `signing/` + the `ANDROID_KEY*` secrets.
- Renderer has no GitHub reach by design (CSP is loopback-only); all
  update traffic must stay shell-side (Rust/Kotlin).

## Phase 1 — Windows: `tauri-plugin-updater` — SHIPPED in v1.4.20

First-party, mature, desktop-only. Flow: the plugin checks a JSON manifest,
verifies a minisign signature, downloads the NSIS installer, runs it and
relaunches. Implemented as described below (see README "One-click updates"
and AGENTS.md §11 "Windows self-update"); notes kept as the implementation
record. Remaining work: Phase 2 (Android).

1. Add `tauri-plugin-updater` and `tauri-plugin-process` (relaunch after
   install) to `velta-app/src-tauri/Cargo.toml`; register both in lib.rs.
2. Generate the updater signing keypair once
   (`cargo tauri signer generate`): private key + password into repo
   secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
   and a local backup — losing them kills the updater, same class of
   accident as losing the Android keystore.
3. `tauri.conf.json`:
   `bundle.createUpdaterArtifacts: true` (the build then emits a
   `.sig` next to the installer) and `plugins.updater` with the public key
   and `endpoints: ["https://github.com/pbuzdin/velta/releases/latest/download/latest.json"]`.
4. Capabilities: add `updater:default` and `process:allow-restart` to
   `capabilities/default.json` (Tauri v2 ACL).
5. `release.yml`: the signed installer is produced automatically when the
   signing env vars are set; add a step that assembles `latest.json` —

   ```json
   {
     "version": "<version>",
     "pub_date": "<RFC 2822 date>",
     "platforms": {
       "windows-x86_64": {
         "signature": "<content of the .sig file>",
         "url": "https://github.com/pbuzdin/velta/releases/download/v<version>/Velta_<version>_x64-setup.exe"
       }
     }
   }
   ```

   — and uploads it as a release asset next to the installer.
6. Frontend (update banner): on desktop the button becomes "Update" and
   calls the updater plugin (`check()`, `downloadAndInstall()` with
   progress toasts, then `process.relaunch()`). The version.txt check stays
   as the cheap gate; the plugin re-validates against `latest.json` on
   install.

Notes and caveats:

- Only **installer** installs self-update. A bare `velta-app.exe` copied
  somewhere will not.
- `latest.json` must be the LAST asset updated in the release (or use
  `releases/latest/download/` only after everything is uploaded) — a
  manifest pointing at a not-yet-uploaded installer URL bricks the update
  for one cycle.
- Debug/`tauri dev` runs check the real endpoint; the version gate in
  `checkForUpdate` keeps that harmless.

## Phase 2 — Android: in-app download + system installer (1–2 days)

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

## Phase 3 (optional) — richer update feed

If per-platform URLs are ever needed beyond the two fixed ones, upgrade
`version.txt` to a small `latest.json` (platform → URL + notes) served the
same way. Keep serving plain `version.txt` too — 1.4.14–1.4.17 installs
parse only that.

## Explicitly rejected

- Play Store in-app updates: Velta is not distributed through Play.
- True silent auto-update on Android: requires device-owner or Play, both
  outside this distribution model.

## Acceptance criteria

- Windows: a 1.4.17 installer install sees release 1.4.18+, clicks Update,
  and relaunches on 1.4.18 without leaving the app (the NSIS UI in between
  is fine). No manual download.
- Android: a 1.4.17 install sees the banner, taps once, grants
  unknown-sources once, and lands in the system installer; after it
  finishes the app is on the new version with the account intact.
- The renderer still performs no network requests beyond loopback; all
  update traffic is shell-side.
- Signing keys (Android keystore + updater keypair) are backed up in two
  places and documented in AGENTS.md alongside `signing/`.
