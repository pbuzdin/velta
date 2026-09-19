# Onboarding — splash, second device, notifications

Extracted from AGENTS.md.

## Welcome splash (`showSplash`)

Created **on demand**, not at boot: `boot()` shows it only when the account
is unconfigured (setup screen: large logo, tagline, three setup paths, and
a collapsed app-log footer fed from the diagnostics store) or when the core
failed to answer after its retries (log surface). The three setup paths:

1. Create a profile on a relay — input or camera scan of a relay QR
   (camera permission only on tapping Scan).
2. Add as a second device — `dcbackup:` receive (see below).
3. Restore from a backup file — Tauri file dialog → `resolve_content_uri`
   on Android → `importBackup`, fire-and-forget with `imex-progress`;
   the app restarts on success.

Returning users with a configured profile never see it — do not regress
this into an unconditional boot splash.

## Second-device flow (`secondDeviceFlow`)

Drawer → "Add a second device…". The old device shows a `provide_backup`
QR (the `get_backup_qr_svg` design card with the `.qr-self` v-logo badge on
the reserved circle) and waits, completion detected via `imex-progress`;
the new device scans/pastes a `DCBACKUP<n>:…` code (the core's format —
validate with `/^dcbackup\d*:/i`, not a bare `dcbackup:`), and
`addAccountWithBackup` imports it into a fresh account. The receive path
is `receiveSecondDeviceProfile`, shared with the splash.

## Notification permission hang (do not regress)

`tauri-plugin-notification`'s `requestPermission()` can hang forever on
some Android 13+ builds (Vivo) once the dialog has been dismissed — boot()
used to die silently at its first `await`, producing a dead UI with an
amber relay line. Never await a plugin permission call without a timeout:
callers race it (2.5 s). Since 1.3.26 the ask happens only after the user
creates or restores an account (`askNotificationPermission()`, flag-gated
after the restore reload) — not at boot. Diagnostics are mirrored to
velta.log (js_log) regardless, so a hang stays pullable via adb even when
no splash is on screen.
