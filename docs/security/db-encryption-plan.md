# Database encryption at rest — plan

Refs #178

Status: phases 0–3 (desktop + Android + PWA) IMPLEMENTED 2026-10-30. Desktop ships:
keyring DEK (`chat.velta.dbkey`), keyed sidecar via the `VELTA_DB_KEY` env
var (core quilt patch #20), one-time pre-spawn `sqlcipher_export` migration
with rollback (`velta-app/src-tauri/src/db_key.rs`), and a locked screen for
accounts the key cannot open. Android ships: the same migration + env var
in-process (set before `Accounts::new` in `init_android_core`), with the DEK
custodied in AndroidKeyStore (`org.velta.VeltaKeystore`: non-exportable
AES-256-GCM KEK `velta_kek`, StrongBox when available, wrapped DEK blob in
`noBackupFilesDir/dbkey.wrap` — never backed up, so a restored database is
unopenable by design); no user auth is bound to the KEK, so push/job cold
starts unlock without UI (the strong biometric mode is phase 4's app lock).
Backup/transfer exclusion predates this: `allowBackup=false` + global
`data_extraction_rules.xml`. Deviations from §2.1 below: the desktop core
is the rpc-server SIDECAR, not in-process `Accounts` (that is Android-only,
corrected below), so the key crosses as an env var and migration runs in
the shell before spawn; `.plain.bak` rollback copies are pruned at the next
successful startup instead of in-session. Phase 3 (PWA) and 4 (app lock)
still open. Phase 3 (PWA) shipped: db-crypt.js (VLTE1 file framing with
path|generation AAD, VLTEW DEK wrap, PBKDF2-SHA256 600k and PRF+HKDF KEK
derivation), worker boot gated on the page-supplied KEK (unlock before the
transport exists, so the 20s connect deadline never races the prompt), per-
generation `enc` marker so the plaintext→encrypted transition stays
bootable, verify-and-discard unlock UI, profile-management setup row, and
tests/wasm-db-crypt.test.mjs. Deviation from §2.3: Argon2id is NOT shipped
— the KEK comes from PBKDF2-SHA256 (600k) or a PRF passkey; the Argon2id
wasm module remains the upgrade path. PRF on a real authenticator and the
Firefox/old-Safari opt-out need device verification. Android Keystore
wrap/unwrap and the upgrade-keep-the-key test (§3.6) still need a device
run — the Keystore cannot be exercised on a JVM. Phase 4 (app lock) shipped
for the PWA 2026-10-30: an app-lock PIN (6+ chars) and a generated recovery
code each wrap the SAME DEK (`dbkey.pin`/`dbkey.pinmeta`,
`dbkey.recovery`/`dbkey.recmeta` at the OPFS root, in the snapshot-cleanup
keep-list), the unlock screen switches between passkey/passphrase/PIN/
recovery with in-session exponential backoff (1s→30s), and auto-lock
(Off/1/5/15 min, live setting) reloads the page after the tab was hidden —
the decrypted snapshot dies with the worker, and the boot path re-prompts.
A successful backup export stamps the reminder; encryption-on nudges one
reminder; stale after 30 days, re-shown at most weekly. Deviations from
§2.4: the PIN backoff counter is in-session only (an OPFS wrap is offline-
brute-forcible once the profile files are copied — the passphrase/passkey
stays the root of security, stated in the UI), PBKDF2-SHA256 not Argon2id
(phase 3 deferral), and the boot now resets its key state first, so an
in-process re-boot cannot inherit a previous unlock.

Update 2026-10-31 (1.4.89): release status — Android profile-data encryption SHIPPED; desktop and PWA are PREVIEW; attachment encryption is WIP (not encrypted yet). Android actually encrypts now — the Keystore
wrap buffer was 16 bytes short (GCM tag), so no DEK was ever stored and the
core ran keyless; fixed with `VeltaKeystore.pack`. Android also gained the
Velta app-lock PIN, the screen-lock fallback for the biometric lock (API
30+), and the lock settings moved to the app-wide Privacy & security screen.

Phase 4 desktop + Android shipped 2026-10-30 (same day). Desktop: the
app-lock PIN REPLACES the keychain as the KEK root (plan §2.4) —
Argon2id(PIN, 64 MiB, t=3) wraps the SAME DEK into `<data>/dbkey.wrap`
(`VLTDW|ver|attempts|salt|nonce|ct`, attempts counter with 1s→30s backoff
enforced in `unlock_with_pin`), the keychain item is removed on set and
rewritten on clear, and a PIN session STARTS LOCKED: the sidecar spawns
keyless, the locked screen asks for the PIN, and a correct one re-migrates
and respawns the sidecar keyed (`spawn_sidecar` now owns the child so
lock/unlock can respawn it). Auto-lock (same Off/1/5/15 setting) respawns
the sidecar keyless after N minutes hidden. Deviations: a copied wrap is
offline-attackable (the counter gates online guessing only), and the PIN
wrap is not ferried across an OS keychain outage — losing the PIN means
restore-from-backup, as the plan's §3.3 says. Android (compile-verified,
device runs pending): `VeltaLock.kt` — a second AndroidKeyStore key
`velta_kek_auth` with `setUserAuthenticationRequired(true)` wraps the SAME
DEK into `noBackupFilesDir/dbkey.wrap.auth` while the plain wrap is
removed, so `init_android_core` refuses to run until the activity's
BiometricPrompt hands the DEK to `VeltaCore.startWithDek` (the init future
retries; headless push/job cold starts stay down, per §2.4), and auto-lock
is a full-screen re-prompt after N minutes hidden (UI gate — the DEK stays
in the running core's memory). Desktop optional bits still open: the
keychain-mode auto-lock (pointless — the keychain re-keys without asking),
a desktop recovery code, and the phase-5 blob decision.

## 1. Findings: what core 2.66.0 offers

All paths are under `core/` (vendored chatmail core 2.66.0).

| API | Where | State |
|---|---|---|
| `Context::open(passphrase) -> Result<bool>` | `src/context.rs:436` | Present, `#[deprecated(since = "TBD")]`. Sets the key on a new DB, checks it on an existing one. |
| `Context::change_passphrase(passphrase)` | `src/context.rs:447` | Present (SQLCipher `PRAGMA rekey`). |
| `Context::is_open()` / `Sql::is_open()` | `src/context.rs:453`, `src/sql.rs:108` | Present. `Sql` also records whether it was opened with a passphrase (`src/sql.rs:59`). |
| `ContextBuilder::with_password` | `src/context.rs:142` | Deprecated. |
| `Accounts::open` / `add_account` | `src/accounts.rs:168`, `:805` | Call `ctx.open("")`. An encrypted account stays **closed** and does not error. |
| `Accounts::add_closed_account` | `src/accounts.rs` | Present. Creates an account without opening it, so the caller can call `open(key)` first. |
| Build | `Cargo.toml:87`, `:210` | `rusqlite` with `sqlcipher`, default feature `bundled-sqlcipher-vendored-openssl`. |
| Per-connection pragmas | `src/sql.rs:~700` | `secure_delete=on`, `temp_store=memory`, WAL journal. |

Deprecation: `CHANGELOG.md:1856` says "Mark database encryption support as deprecated (#7403)". `deltachat-ffi/deltachat.h:287` says: "Nonempty passphrase (db encryption) is deprecated 2025-11: db encryption does nothing with blobs, so fs/disk encryption is recommended; isolation from other apps is needed anyway." Encryption is **deprecated, not removed**. 2.66 still has it and it is still tested (`src/accounts.rs:1276`).

JSON-RPC: `deltachat-jsonrpc/src/api.rs` exposes **no** `open`/`change_passphrase`/`is_open`/`add_closed_account`. The `passphrase` parameters at `api.rs:639/655/2055/2071` are backup export/import passphrases only.

How Velta opens accounts today:
- Android: `velta-app/src-tauri/src/lib.rs` (`init_android_core`) embeds `deltachat_jsonrpc::api::Accounts` **in-process** (`Accounts::new`, `ANDROID_ACCOUNTS`). The Rust side can call `deltachat::Context` methods directly. Desktop does NOT: it spawns the `deltachat-rpc-server` sidecar child process and speaks JSON-RPC over stdio, so the shell can only pass the key as an environment variable (quilt patch #20 reads `VELTA_DB_KEY` in `Accounts::load_accounts`/`add_account`).
- `app/js/rpc-core.js` only uses JSON-RPC (`start_io_for_all_accounts`, ...) and never sees a key.
- PWA: `packages/velta-wasm/rust/src/lib.rs:149` runs `Accounts::new("/accounts")`. SQLite lives in sqlite-wasm-rs's **in-memory** VFS (`lib.rs:79-113`, `sqlite_export`/`sqlite_import`). `app/js/worker-wasm.js` persists a snapshot (memfs + exported DB bytes) to **OPFS** under `navigator.locks`. In the browser the data at rest is that OPFS snapshot, not a live SQLite file.

**Decision: app-only work. No core patch, so nothing goes through `tools/apply-core-patches.py`.**
- Native: the Tauri Rust side calls `ctx.open(key)` (with `#[allow(deprecated)]`) on every account that `Accounts::new` left closed, and creates new accounts with `add_closed_account` + `open(key)` (new Tauri command, see §2.1). Only a thin `velta_db_key` module is needed. JSON-RPC stays as is.
- PWA: encrypt the OPFS snapshot with WebCrypto AES-GCM in `worker-wasm.js`. The in-memory DB never touches disk, so SQLCipher inside wasm is not needed. (Whether the wasm build even links SQLCipher is an open question, §7.)
- Risk: upstream may remove `open(passphrase)` in a later core. Mitigation, §6: pin a test that fails on the bump. If it is removed, the fallback is a small core patch that keeps `Sql::open(ctx, key)` reachable, or the Android/desktop "file-level" variant in §6.

## 2. Design per platform

One random 256-bit key (DEK) per install, generated with the OS CSPRNG. All accounts on the install share it, so no per-account prompts. It is passed to SQLCipher as a raw key: `"x'<64 hex>'"`, which skips SQLCipher's PBKDF2 (the key is already uniform). Core passes the string straight to `PRAGMA key` (`src/sql.rs:97`).

### 2.1 Desktop (Windows, macOS, Linux)
- Store the DEK with the `keyring` crate (v3; features `windows-native`, `apple-native`, `linux-native-sync-persistent` + `crypto-rust`). Service `chat.velta.dbkey`, user `install-<uuid>`. Backends: Windows Credential Manager (DPAPI, per user), macOS login Keychain, Linux Secret Service (GNOME Keyring/KWallet) with a kernel-keyutils cache.
- Fallback when there is no Secret Service (headless, minimal WMs, some Flatpaks): show an explicit choice. (a) Passphrase-wrapped key file `<data>/dbkey.wrap` (Argon2id m=64 MiB, t=3 → KEK → AES-256-GCM wraps the DEK), entered at each start. Or (b) "no encryption" with a warning. Never fall back silently to a plaintext key file next to the DB, because that would add nothing.
- Startup in `lib.rs` before `CommandApi` is served:
  1. Load the DEK, or report a missing key (§3.3).
  2. For each account id: `if !ctx.is_open() { ctx.open(key) }`. If it returns `false`, that account is in the wrong-key state (§3.3).
  3. Replace the JS `add_account` path with a Tauri command `velta_add_account` → `add_closed_account` + `open(key)`. `rpc-core.js` calls it instead of `add_account` / `add_or_select` paths. Backup import (`import_backup`) is done on an already-opened, keyed context, so it lands encrypted.

### 2.2 Android
- Keystore: generate a non-exportable AES-256-GCM key `velta_kek` in AndroidKeyStore, StrongBox when available. It wraps the DEK. The wrapped blob goes in `noBackupFilesDir/dbkey.wrap`.
- Implement as a small Kotlin class in the Tauri Android project, exposed via a Tauri mobile plugin (`velta-keystore`, commands `getOrCreateDek`, `wrapState`). It does not use EncryptedSharedPreferences, which is deprecated.
- Cold starts by push or job (`lib.rs:3531`) must get the key without UI. So the KEK has **no** `setUserAuthenticationRequired` unless the app lock in biometric-bound mode is enabled (§2.4). Document that in that mode background fetch waits until unlock.
- Exclude `dbkey.wrap` and the accounts dir from Auto Backup / device transfer (`dataExtractionRules`). A restored DB without its Keystore key cannot be opened anyway.

### 2.3 PWA
- What is encrypted: the OPFS snapshot. Every DB byte array from `sqlite_export` and every memfs file (blobs, `accounts.toml`) is written as `AES-256-GCM(DEK, iv=random96, aad=path|generation)`. The format header is `VLTE1`. `current` stays plaintext (a generation number only).
- Key source, in order:
  1. **WebAuthn PRF passkey**: `navigator.credentials.get({extensions:{prf:{eval:{first:salt}}}})` → 32 bytes → HKDF → KEK → unwraps the DEK stored in OPFS `dbkey.wrap`. Supported in Chrome/Edge, Safari 18+, Android passkeys, and some security keys.
  2. **Passphrase**: Argon2id via a small wasm module (fallback PBKDF2-SHA256, 600k iterations, WebCrypto-native) → KEK → unwraps the DEK. Store the salt and parameters with the wrap.
  3. **Opt-out**: as today.
- The unwrapped DEK is imported as a non-extractable `CryptoKey`, held only in the worker.
- Honest limits: (a) the plaintext DB exists in tab memory while the app runs, (b) a malicious script on the origin (XSS, compromised deploy or service worker) can read everything while the app is unlocked, so encryption only helps at rest, (c) PRF is unavailable on Firefox desktop and older Safari, (d) losing the passkey and the passphrase means losing the local data (the account can be restored from a backup or second device only), (e) a browser "clear site data" deletes everything, encrypted or not.

### 2.4 Optional app lock
- Off by default. Modes: PIN (desktop and PWA, also Android) or biometrics (Android BiometricPrompt, macOS Touch ID via `LocalAuthentication`, Windows Hello via `UserConsentVerifier`).
- Strong mode (Android): the KEK has `setUserAuthenticationRequired(true)` + biometric/credential, so unlocking really gates the DEK. Desktop and PWA: the PIN replaces the OS keychain as KEK source (Argon2id(PIN) wraps the DEK, with an attempt counter and backoff). Without that, a PIN would only be a UI gate, and the doc and UI say so.
- Auto-lock after N minutes in the background: drop the in-memory key, `stop_io`, and close contexts (`Accounts` reload). Notifications then show "New message" only.

### 2.5 Blobs (attachments)

**DECIDED 2026-10-30 (#178 phase 5): option A.** The message database is
SQLCipher-encrypted (phases 0–4); the blob directory `<account>/dc.db-blobs/`
stays plaintext and relies on platform isolation, exactly as the core
maintainers argue. Concretely: Android app-private storage is file-based
encrypted at rest (Android 10+); the PWA's blobs are inside the encrypted
OPFS snapshot (phase 3, already covered); desktop relies on OS disk
encryption. Option B (app-level blob encryption) is REJECTED for 2.66:
core reads blobs directly on the send path, for thumbnails and for webxdc,
so every read/write would need a core patch that fights every bump — the
same reason upstream deprecated DB encryption. Revisit only if upstream
revives keyed blobs. Shipped with the decision:

- the desktop thumbnail cache (`<data>/thumbs/`, a flat gallery of derived
  plaintext images) is wiped on lock (`lock_now`) and regenerates on
  demand from the LOCAL originals (`dc.db-blobs/` — no network involved;
  the cost is one full-res decode per viewed image per lock cycle). Honest
  sizing: while blobs themselves stay plaintext (option A) the wipe buys
  little — it removes the most BROWSABLE artifact (every photo contact-
  sheeted in one folder) while the sources remain; it becomes load-bearing
  only if blobs are ever keyed (option B), when thumbs would be the last
  plaintext copies. NOT moved under `accounts/`: nothing accounts-scoped
  scans `<data>`, and the move would churn every cache key for no gain;
- the settings show the boundary (Profile management): a static FBE note
  on Android, or the live disk-encryption status on desktop
  (`volume_encryption_status`: PowerShell `Get-BitLockerVolume` on Windows
  — Home editions without the module report "unknown" —, `fdesetup
  isactive` on macOS, "unknown" on Linux);
- PWA: no on-disk thumbnail cache exists (originals serve from memory);
  nothing to change.

The original options, for the record.

Core stores blobs in `<account>/dc.db-blobs/` in plaintext, and the core maintainers say that is why DB encryption was deprecated. Options:
- **A (recommended, phase 1)**: rely on platform isolation and FS encryption, and document it. Android app-private storage is file-based encrypted (FBE) since Android 10. Desktop: recommend BitLocker/FileVault/LUKS, and the settings page shows whether the volume is encrypted where it can tell. PWA: blobs are inside the encrypted snapshot (§2.3), so they are already covered.
- **B (phase 4, optional)**: app-level blob encryption at rest via the Tauri blob server (`lib.rs:936`, it already serves blobs and thumbnails). It needs a core patch, because core reads blobs directly for sending, thumbnails and webxdc. It is too invasive for 2.66, so it is deferred.
- In all cases, the thumbnail cache `<accounts>/../thumbs/` (`lib.rs:1038`) is derived plaintext. Move it under the accounts dir and wipe it on lock. For PWA, keep it out of OPFS.

### 2.6 WAL, temp, shm
- SQLCipher encrypts the main DB **and** `-wal` pages with the same key. `-shm` has only the WAL index, no row data.
- Core already sets `temp_store=memory` and `secure_delete=on`, so there are no plaintext temp files.
- Migration leftovers are the real risk: the plaintext `dc.db`, `dc.db-wal` and `dc.db-shm` must be checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`) before export and then deleted. A delete does not erase data on SSD/flash, so the doc says that only full-disk encryption covers past plaintext. Also add `PRAGMA cipher_memory_security` = default.

## 3. Resilience

### 3.1 Backup before migrating
Before touching any DB, use core's own export (`export_backup` via JSON-RPC, passphrase = random 24-char code shown to the user, or the user's own) to `<data>/pre-encryption-backup-<ts>.tar`. Also keep a filesystem copy of the account dir (`dc.db*` + blobs, after a checkpoint) until verification passes. Ask the user to save the backup code. On Android, offer the SAF picker to copy it out.

### 3.2 One-time migration
Per account, with IO stopped and `Accounts` unloaded:
1. `PRAGMA wal_checkpoint(TRUNCATE)` on the plaintext DB.
2. `ATTACH 'dc.db.enc' AS enc KEY "x'..'"; SELECT sqlcipher_export('enc'); DETACH` via rusqlite with the same bundled SQLCipher (separate tool connection, no core change). Copy `user_version` too.
3. Verify: open `dc.db.enc` with the key, then `PRAGMA cipher_integrity_check`, `PRAGMA integrity_check`, row counts of `msgs`, `chats`, `contacts`, `config`, `keypairs` equal, and `user_version` equal.
4. Atomic swap: `dc.db` → `dc.db.plain.bak`, `dc.db.enc` → `dc.db` (rename on the same FS, then fsync the dir). Write `migration.state` (begin/exported/verified/swapped/done) so an interrupted run resumes or rolls back.
5. Open through core with `ctx.open(key)`. Only on success, delete `.plain.bak`, `-wal`, `-shm` and the FS copy. Keep the core backup tar until the user dismisses it (or 7 days).
6. Rollback on any failure: restore `.plain.bak`, delete `.enc`, clear the key-in-use flag, show an error, and keep running unencrypted.
- Alternative path (also app-only): core `export_backup` → new `add_closed_account` + `open(key)` → `import_backup`. It is slower and re-imports blobs, but uses only supported APIs. Use it when `sqlcipher_export` fails.
- PWA: the migration is simply the next snapshot written encrypted. Keep the previous plaintext generation until the encrypted one has been read back once, then delete it.

### 3.3 Key missing or wrong
- Hard rule: **never** create a fresh empty account when an existing `dc.db` cannot be opened. Today `Accounts::open` silently leaves such accounts closed, and the UI might fall into onboarding. Velta checks `is_open()` for every account in `accounts.toml` before serving the UI.
- If a closed account exists, show a "Locked / key unavailable" screen with: retry (keychain might be locked), enter recovery passphrase (if set), **restore from backup** (import into a new keyed account), or "remove this profile" (explicit, typed confirmation). Onboarding is never the default.
- Keep a `key_fingerprint` (HMAC of a constant with the DEK) in a sidecar `dbkey.meta`, so "wrong key" can be told apart from "corrupt DB".
- Optional recovery: at migration, offer a recovery code (DEK wrapped by Argon2id(code)) that the user writes down. It enables device-change recovery without a backup tar.

### 3.4 Backup reminders
Record the last successful `export_backup` / settings-transfer time. Remind after 30 days (configurable, can be disabled) and right after enabling encryption or the app lock. Reuse the scheduled job infrastructure (`scheduled.rs`).

### 3.5 Updates, reinstall, device change
- App updates: keychain items, Keystore keys and OPFS persist across updates. Keychain item names and the Keystore alias are frozen, with a test (§3.6). macOS: sign with the same Team ID, otherwise Keychain ACLs prompt. Windows: Credential Manager is per user and unaffected.
- Android uninstall deletes the Keystore key, so the DB is unreadable by design. Backup or settings transfer is required (and was already required, since the app data dir is wiped too).
- OS reinstall or a new PC: the keychain is gone, so restore from backup / settings transfer / multi-device, or use the recovery code. Copying the data dir to a new machine without the key gives the "key missing" screen (§3.3), never an empty account.
- PWA: the passkey syncs (iCloud, Google Password Manager), but OPFS does not, so on a new browser use the normal backup or transfer.

### 3.6 Tests
- Rust (velta-app): open/encrypt round trip on a temp accounts dir. Migration happy path. Crash at each `migration.state` step → resume or rollback. Wrong key → `open` false → no new account created. Missing key → locked state. `add_closed_account` path. `sqlcipher_export` verification row counts. Plaintext `-wal`/`-shm` are gone after migration. A byte scan of `dc.db` for a known message body after migration finds nothing.
- Core-bump guard: a test that calls `Context::open(key)` + `change_passphrase` and fails if the API disappears (it runs in CI on every `COREUPDATE`).
- keyring: mock backend, plus a Linux CI job without Secret Service → fallback prompt.
- Android: instrumented test for Keystore wrap/unwrap and for the KEK alias staying stable across an app upgrade (install old APK → upgrade → open).
- PWA (`tests/wasm-opfs-snapshot.test.mjs`): the snapshot is encrypted (no SQLite header `SQLite format 3` in OPFS bytes), round trip, wrong passphrase, tampered byte → GCM failure → locked screen and no reset, interrupted generation.
- E2E: two accounts, migrate, send/receive, restart, still readable.

## 4. Threat model
Protects against:
- Offline access to the data dir: a stolen or lost laptop without FDE, disk images, a backup tool or cloud-synced folder copying `%LOCALAPPDATA%`/`~/.local/share`, forensic copies of app data on a rooted device that has no Keystore key.
- Other local apps or users reading files they have FS permission for, but not the keychain item (partial, see below).
- PWA: a disk copy of the browser profile or OPFS.

Does not protect against:
- Malware running as the same user while Velta is unlocked. It can ask the keychain (Linux Secret Service has no per-app ACL), read process memory, or hook the UI.
- Root or a compromised OS. On Android, Keystore keys can still be used (not extracted) by an attacker with root.
- Attachments on desktop without FDE (§2.5 option A), and plaintext remnants on SSD from before the migration.
- XSS or a compromised PWA deploy. Metadata on chatmail servers (out of scope; E2E encryption covers transport).
- Coercion. A user who forgets everything with no backup loses local history (by design).

## 5. Phases and estimates

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Spike: native `ctx.open(key)` on a closed account from `lib.rs`. Confirm the wasm SQLCipher status. Core-bump guard test. | 1–2 d |
| 1 | Desktop: keyring DEK, keyed open at startup, `velta_add_account`, locked/missing-key screen, backup + migration + rollback, tests | 5–7 d |
| 2 | Android: Kotlin Keystore plugin, background cold-start path, backup exclusion rules, upgrade test | 4–6 d |
| 3 | PWA: encrypted OPFS snapshot, PRF passkey + passphrase wrapping, migration of the existing snapshot, tests | 4–6 d |
| 4 | App lock (PIN/biometrics, strong mode on Android), auto-lock, backup reminders, recovery code | 4–5 d |
| 5 (optional) | Blob encryption design and a core patch decision. Thumbnail cache cleanup. | 2 d design + TBD |

Total for 0–4 is about 3–5 weeks.

## 6. Risks
- Upstream deprecation: `open(passphrase)` could be removed in a core after 2.66. Mitigation: the guard test, plus a minimal core patch through `tools/apply-core-patches.py` that keeps the keyed `Sql::open`, if needed.
- SQLCipher format change on a rusqlite/libsqlite3-sys bump (4.6 → 4.14 already happened in the wasm series). Mitigation: pin `cipher_compatibility`, test opening a fixture DB.
- Linux keyring flakiness (locked collection at autostart, Flatpak portals). It must degrade to the prompt, never to data loss.
- Migration on large DBs (time, double disk space). Check free space first, ~2× DB size + backup.
- Android background start with strong-mode lock: no key → push fetch deferred.
- Performance: SQLCipher adds about 5–15% on page I/O. Measure on low-end Android.

## 7. Open questions
1. Does the wasm build link SQLCipher (`sqlite-wasm-rs` feature) or plain SQLite? The plan does not rely on it (snapshot encryption), but it changes the size or fallback.
2. Encryption on by default for new installs, or opt-in at first? Proposal: on by default for desktop and Android once phase 1–2 are stable. Opt-in for PWA (passkey UX).
3. Offer a recovery code by default, or only backups?
4. Is blob encryption (option B) wanted at all, given upstream's stance?
5. Linux without Secret Service: is a passphrase prompt at each start acceptable, or allow a "store key in plain file" option with a warning?
6. Should settings transfer (`docs/settings-transfer.md`) carry the app-lock setting?
