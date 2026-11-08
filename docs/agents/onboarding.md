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

`app/js/pwa-onboarding.js` recognizes `?invite=` before the existing
SecureJoin handler, so ordinary Delta Chat contact/group invites keep their
old meaning. Two formats are supported:

- **V2 (preferred): self-contained signed configuration.** The envelope payload
  is `{v:2,t,p,r,e,k}`: the existing HMAC proxy token, one full `wss://` proxy
  URL, approved `{short-id: chatmail-host}` relays, the same expiry as the HMAC
  token, and an Ed25519 key id. The URL-safe payload and detached signature are
  joined as `payload.signature`. `scripts/relay-invite/pwa_onboarding.py` is the
  reference signer for Veltar. `r=<id>` query parameters are forbidden in v2:
  relay selection configuration must be signed, not appended unsigned.
- **V1 (legacy): registry-based proxy token.** A bare HMAC token plus optional
  `r=<id>` still loads the same-origin `onboarding.json` registry. Keep this
  compatibility path for already issued links; new Veltar links should be v2.

For v2, `verifyOnboardingEnvelope()` verifies Ed25519 with
`window.VELTA_PWA.onboardingKeys[key-id]` before trusting any hostname or
installing the nested HMAC token. Public verification keys are safe build
configuration (`scripts/build-pwa.mjs --onboarding-keys file.json`); private
signing keys never enter the PWA or repository. The payload is encoded, not
encrypted: invite recipients can decode it, and the account address reveals
the relay domain. Base64url must never be mistaken for a signature check.

The capture runs before `createCore`: the bearer token is removed from the
visible URL, stored in the existing proxy-token store, and the relay choice is
parked in `sessionStorage velta-pwa-onboarding`. V2 stores only the verified
registry across the required reload and never fetches `onboarding.json`. The
worker captures its proxy once, so the reload is mandatory. Boot then probes
only approved hosts, uses the requested v1 `r` or the fastest responsive entry,
and calls `configureWithQr(dcaccount:https://host/new)` (or `addAccountWithQr`
for an existing configured profile). The worker turns stock `POST /new` into an
authenticated `wss://<proxy>/cm-new/<host>` exchange, preserving any proxy path.
The automatic path deliberately skips the nickname modal and never calls core
`initTransports` autopick. The token itself is never written into diagnostics.

Deployment-specific hostnames stay in Veltar's private configuration and the
signed invite, never in source, tests, docs, or static PWA configuration. The
proxy still enforces its own allowlist; a valid PWA signature does not turn it
into an open relay. A proxy probe proves reachability, not identity.

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
