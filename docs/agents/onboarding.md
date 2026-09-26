# Onboarding — splash, second device, notifications

Extracted from AGENTS.md.

## Welcome splash (`showSplash`)

Created **on demand**, not at boot: `boot()` shows it only when the account
is unconfigured (setup screen: large logo, tagline, three setup paths, and
a collapsed app-log footer fed from the diagnostics store) or when the core
failed to answer after its retries (log surface). The three setup paths:

1. Create a profile on a relay — input or camera scan of a relay QR
   (camera permission only on tapping Scan). Under the input sits
   "Autopick the fastest relay": it calls
   `initTransports` (core-side autorelay — the core probes its built-in
   relay pool, configures the fastest, then grows the profile to ~3
   transports from IMAP idle hooks). The button renders only when the
   core surface has `initTransports` (demo/mock hides it).
2. Add as a second device — `dcbackup:` receive (see below).
3. Restore from a backup file — Tauri file dialog → `resolve_content_uri`
   on Android → `importBackup`, fire-and-forget with `imex-progress`;
   the app restarts on success.

After a relay create (both the typed-relay and the autorelay button land in
`runCreate`), the success path asks for a **nickname** (issue #6): a compact
modal — input prefilled with the default display name, Skip / Save name —
applied via `setDisplayName` before `finishOk()`. Skippable by design:
closing the modal or pressing BACK must never block entering the app. The
second-device and restore paths skip the ask (the profile already has its
identity).

Returning users with a configured profile never see it — do not regress
this into an unconditional boot splash.

## Second-device flow (`secondDeviceFlow`)

Drawer → "Profile management…" → **Second device** tab (post-1.4.34 the
profile flows — Add profile / Second device / Export backup — live in one
tabbed modal; the splash's "add as second device" path shares the same
receive flow). The old device shows a `provide_backup`
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
