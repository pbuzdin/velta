# PLAN: UnifiedPush (ntfy) — Google-free background push for Velta Android

Goal: messages and calls reach the phone with the core process dead — relay →
ntfy → ntfy Android app (UnifiedPush distributor) → Velta wakes, fetches,
posts its usual MessagingStyle notification. No FCM, no Google.

## Verified facts (vendored core 2.62, `core/`)

- `core/src/push.rs` — `PushSubscriber` holds ONE device token per install;
  before storage the token is encrypted to a baked-in `NOTIFIERS_PUBLIC_KEY`.
  Upstream bakes **Delta Chat's official push-server key** — anyone running
  their own notifier MUST swap this key, otherwise registrations are
  encrypted to a key whose private half we don't hold.
- `core/src/imap.rs` (`register_token`) — the ciphertext is written to IMAP
  METADATA `/private/devicetoken` on INBOX. Registration is skipped unless
  the server's `/shared/vendor/deltachat/*` metadata marks `supports_push`
  (true when any of maxsmtprecipients / iroh_relay / ice_servers is present).
- `Accounts::set_push_device_token(token)` (`core/src/accounts.rs`) + FFI
  `dc_accounts_set_push_device_token` already exist. NOT on JSON-RPC or wasm —
  fine: the Android shell hosts the accounts manager in-process, so it calls
  it directly. PWA/desktop don't need this path (Web Push is the browser
  story, separate project).
- The token is opaque to the core — for us it decrypts to a **UnifiedPush
  endpoint URL** (`https://<ntfy-host>/<secret-topic>`).

## Relay state (verified 2026-10-09)

- dovecot 2.3.21, maildir `/home/vmail/mail/<relay-domain>/%u`, real IMAP :993,
  websockify 127.0.0.1:8143, nginx :3341 (iroh relay). Metadata plugin state
  NOT yet verified — needs `doveconf -n | grep imap_metadata` before
  registration can work; `/shared/vendor/deltachat/*` entries may be missing
  → must publish at least one (iroh_relay likely already there) so core
  attempts push registration.

## Work items (in order)

1. **Notifier keypair.** `rsop generate-key` → swap the pubkey constant in
   vendored `core/src/push.rs` (quilt patch — must survive the next
   re-vendor; add to the quilt series). Private key lands on the relay only.
2. **Relay: ntfy server.** Static binary + systemd unit, listening on a
   local unix socket behind nginx (`/ntfy` under the relay domain,
   TLS via existing cert). Auth off — the topic name is the secret.
3. **Relay: notifier daemon.** dovecot `notify`/maildir hook on new-mail for
   user U → `doveadm metadata get -u U -mailbox INBOX /private/devicetoken`
   → decrypt (sequoia/rsop with the notifier private key) → POST empty body
   to the endpoint. Idempotent, per-user rate limit, logs to journal.
4. **Android shell (Kotlin + JNI).**
   - Dependency `org.unifiedpush.android.connector` (small, standard).
   - Receiver: `NEW_ENDPOINT` → JNI → `accounts.set_push_device_token(url)`;
     `MESSAGE` → start `CoreService` + trigger a fetch. Notification posting
     stays in `Notifications.kt` (MessagingStyle, JNI 584df30 — release it
     first).
   - Drawer switch "Background push (UnifiedPush)" with a distributor-missing
     hint (ntfy app install link).
5. **Demote CoreService.** Keep the foreground service as a fallback for
   devices without a distributor; when push is registered, prefer wakeup-only
   (battery win + OEM-kill resilience is the actual product goal).

## Testing

- Relay slice observable with curl alone (register a fake token, send mail,
  see the POST fire).
- On-device E2E: kill app, send message, expect MessagingStyle card <30 s
  with Doze on.
- Core vendored-patch: existing push.rs unit tests must stay green after the
  key swap (they cover pad/encrypt round-trip, not the key material).

## Non-goals

- PWA/Web Push (VAPID) — separate track.
- iOS — APNs via the same core path, later.
