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
   Since 10-09 the private relay is **invite-only** (nginx `/new` 403s
   open signup): relay addresses typed into the create paths fail there
   with the server's "invite-only" error, and the supported path is an
   invite link `https://<relay>/i/<token>` — pasted into this input or
   the profile-modal's Add profile, or opened directly (the interstitial
   links the PWA as `#/join?t=<token>`). `parseRelayInvite` recognizes
   the link shape; `createAccountFromRelayInvite` claims it
   (GET `/i/claim?t=`, atomic single-use on the relay, flock'd JSON
   store) and configures via `configureWithCredentials`. Claimed
   credentials park in `sessionStorage velta-invite-creds` (30 min) so a
   failed configure can retry without burning the invite; a tunnel
   switch reloads and resumes from `velta-pending-invite`. Minting is a
   root CLI on the relay, not a UI (`invite-tool.py add`).
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

## One-tap PWA invitations

`app/js/pwa-onboarding.js` recognizes the signed proxy-token shape in
`?invite=` before the existing SecureJoin handler, so ordinary Delta Chat
contact/group invites keep their old meaning. The same-origin onboarding
configuration supplies one full `wss://` proxy URL (paths are supported) and
only signup-capable `{short-id: chatmail-host}` relays. The corresponding proxy
administrator command is `tools/deploy-ws-proxy.sh relay add ID HOST`; it
validates Chatmail without calling `/new`.

Deployment-specific hostnames are configuration, not source constants. Keep
real values out of the open-source tree, documentation, tests, and generated
PWA artifacts. A private static `onboarding.json` can be injected into the
served tree after precache generation; a same-origin runtime endpoint can serve
the same configuration when a static public file is not acceptable. A static
file remains visible to clients, and a successful proxy probe proves
reachability rather than identity.

The capture runs before `createCore`: the bearer token is removed from the
visible URL, stored in the existing proxy-token store, and the relay choice is
parked in `sessionStorage velta-pwa-onboarding`. A reload is mandatory because
the wasm worker captures its proxy once. Boot then probes only registry hosts,
uses the requested `r` or the fastest responsive entry, and calls
`configureWithQr(dcaccount:https://host/new)` (or `addAccountWithQr` for an
existing configured profile). The worker turns stock `POST /new` into an
authenticated `wss://<proxy>/cm-new/<host>` exchange, preserving any proxy path;
this avoids the CORS failure of both direct Chatmail signup and an HTTP proxy.
The proxy only forwards an empty signup POST to allowlisted Chatmail hosts.
This automatic path deliberately skips the nickname modal and never calls core
`initTransports` autopick. The token itself is never written into diagnostics.

## Second-device flow (`secondDeviceFlow`)

Drawer → "Profile management…" → **Second device** tab (post-1.4.34 the
profile flows — Add profile / Second device / Export backup / Import backup — live in one
tabbed modal; the splash's "add as second device" path shares the same
receive flow). The old device shows a `provide_backup`
QR (the `get_backup_qr_svg` design card with the `.qr-self` v-logo badge on
the reserved circle) and waits, completion detected via `imex-progress`;
the new device scans/pastes a `DCBACKUP<n>:…` code (the core's format —
validate with `/^dcbackup\d*:/i`, not a bare `dcbackup:`), and
`addAccountWithBackup` imports it into a fresh account and returns before
the transfer finishes. `get_backup` does not start IO. When the import
resolves, the new device reapplies the tunnel proxy, calls `start_io`
(unless Sync only active and the user has already left that account), and
emits `account-changed` without bumping the epoch so the relay line leaves
"no relay configured" (#118). A rejected import does not start IO. A file
import still relies on the reload at imex progress 1000, which boots into
`_startIo`. Profile management → Import backup is that same file import once
a profile already exists: `beginBackupImport` adds an unconfigured account
(the core refuses a tar on an account in use), selects it, and deletes it
again if the import fails. The receive path is `receiveSecondDeviceProfile`,
shared with the splash.

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
