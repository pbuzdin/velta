//! Database encryption at rest (#178, phases 1–2 — desktop and Android).
//!
//! One random 256-bit DEK per install. The raw SQLCipher key (`x'<64 hex>'`,
//! skips PBKDF2) reaches the core via the `VELTA_DB_KEY` env var (core quilt
//! patch #20): desktop passes it to the spawned rpc-server sidecar, Android
//! sets it in-process before `Accounts::new`. The DEK itself lives in the OS
//! keychain — desktop: `keyring` (Windows Credential Manager/DPAPI, macOS
//! login Keychain, Linux Secret Service); Android: AndroidKeyStore KEK
//! wrapping the DEK (`org.velta.VeltaKeystore`, blob in `noBackupFilesDir`).
//! No plaintext key file ever exists.
//!
//! Before the core opens anything, every `<accounts>/<uuid>/dc.db` is
//! classified and plaintext databases are migrated in-process
//! (`sqlcipher_export` through the same bundled SQLCipher core uses) while
//! the files are not open by anyone. Hard rule from the plan (§3.3): an
//! account we cannot open stays LOCKED — the UI shows a locked screen and
//! onboarding never runs; we never create a fresh account over unreadable
//! data.

use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::Connection;

#[cfg(not(target_os = "android"))]
const KEYCHAIN_SERVICE: &str = "chat.velta.dbkey";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_USER: &str = "default";

/// Tables whose row counts must survive the migration byte-identical.
const COUNT_TABLES: [&str; 5] = ["msgs", "chats", "contacts", "config", "keypairs"];

/// A db we can classify.
enum Kind {
    /// Opens without a key.
    Plain,
    /// Opens with our key (already migrated, or created keyed).
    Ours,
    /// Opens with neither — wrong or missing key. LOCKED, never touched.
    Foreign,
}

pub struct Prepare {
    /// Pass the key to the sidecar this session.
    pub use_key: bool,
    /// Plaintext databases converted this run.
    pub migrated: usize,
    /// Already encrypted with our key.
    pub already: usize,
    /// Unreadable even with our key (stays locked this session).
    pub locked: usize,
}

fn log(msg: &str) {
    crate::log(&format!("db-key: {msg}"));
}

/// What the keychain said about the install DEK.
#[derive(Debug)]
pub enum Lookup {
    /// A well-formed 64-hex key.
    Found(String),
    /// No item stored (fresh install, or the keychain was reset).
    NoEntry,
    /// Keychain unavailable, unreadable, or the item is corrupt.
    Unavailable,
}

/// Why this session runs without a usable key — surfaced in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyIssue {
    /// No OS keychain (e.g. no Linux Secret Service): stays unencrypted.
    KeychainUnavailable,
    /// Encrypted databases exist but the keychain has no key for them.
    /// No new key is created (no mixed keys); they stay locked.
    KeyMissing,
}

/// Key policy (plan §3.3): a new DEK is only generated when NO encrypted
/// database exists. If encrypted data exists and the keychain lost the
/// key, creating a fresh one would encrypt new accounts with a second key
/// while the old ones stay locked — never do that.
/// Returns (key to use, whether to create+store a new key, issue for UI).
pub fn decide_key(lookup: Lookup, has_encrypted: bool) -> (Option<String>, bool, Option<KeyIssue>) {
    match lookup {
        Lookup::Found(hex) => (Some(hex), false, None),
        Lookup::NoEntry if has_encrypted => (None, false, Some(KeyIssue::KeyMissing)),
        Lookup::NoEntry => (None, true, None),
        Lookup::Unavailable if has_encrypted => (None, false, Some(KeyIssue::KeyMissing)),
        Lookup::Unavailable => (None, false, Some(KeyIssue::KeychainUnavailable)),
    }
}

#[cfg(not(target_os = "android"))]
fn keychain_entry() -> Option<keyring::Entry> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER) {
        Ok(e) => Some(e),
        Err(e) => {
            log(&format!("keychain unavailable: {e}"));
            None
        }
    }
}

#[cfg(not(target_os = "android"))]
fn keychain_lookup(entry: Option<&keyring::Entry>) -> Lookup {
    let Some(entry) = entry else { return Lookup::Unavailable };
    match entry.get_password() {
        Ok(hex) if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) => Lookup::Found(hex),
        Ok(_) => {
            // A mangled item is not recoverable and must not be overwritten
            // silently: the databases it may have encrypted stay locked.
            log("keychain item is corrupt; treating as unavailable");
            Lookup::Unavailable
        }
        Err(keyring::Error::NoEntry) => Lookup::NoEntry,
        Err(e) => {
            log(&format!("keychain read failed: {e}"));
            Lookup::Unavailable
        }
    }
}

/// Generate and store a new DEK. `None` = the keychain refused the write.
#[cfg(not(target_os = "android"))]
fn create_dek(entry: Option<&keyring::Entry>) -> Option<String> {
    let entry = entry?;
    let bytes = crate::random_bytes::<32>();
    let hex: String = data_encoding::HEXLOWER.encode(&bytes);
    if let Err(e) = entry.set_password(&hex) {
        log(&format!("keychain write failed: {e}"));
        return None;
    }
    log("generated a new database key");
    Some(hex)
}

/// Every `<root>/<uuid>/dc.db` — including accounts whose `dc.db` is
/// missing but whose migration backup `dc.db.plain.bak` exists (a crash
/// between the two swap renames).
fn account_dbs(accounts_root: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(accounts_root) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path().join("dc.db"))
            .filter(|db| db.is_file() || sibling(db, "plain.bak").is_file())
            .collect(),
        Err(e) => {
            log(&format!("cannot read {}: {e}", accounts_root.display()));
            Vec::new()
        }
    }
}

/// Any database that is not plaintext (or an unrecoverable interrupted
/// swap's leftover) means a key has been used on this install before.
pub fn has_encrypted(accounts_root: &Path) -> bool {
    account_dbs(accounts_root)
        .iter()
        .any(|db| db.is_file() && !opens(db, None))
}

/// fsync a file (and on unix its directory) so a rename after it cannot
/// publish an empty or torn file after a power loss.
fn sync_file(path: &Path) -> std::io::Result<()> {
    // Windows: FlushFileBuffers refuses read-only handles (os error 5) —
    // open for writing or every migration fails its fsync step.
    std::fs::OpenOptions::new().write(true).open(path)?.sync_all()
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir; // Windows: no std directory fsync; the .bak covers it.
}

fn count(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| format!("{table}: {e}"))
}

/// Before the migration backup is deleted: the encrypted live database
/// must be the SAME data as the backup, not a fresh db created over a
/// missing file. Row counts must match; tables that legitimately change
/// in a session (msgs, chats, contacts) may only grow — a shrink, or a
/// different identity (config `addr`, keypairs), keeps the backup.
fn bak_superseded(db: &Path, bak: &Path, key_hex: &str) -> Result<(), String> {
    let plain = Connection::open(bak).map_err(|e| e.to_string())?;
    let enc = Connection::open(db).map_err(|e| e.to_string())?;
    enc.pragma_update(None, "key", format!("x'{key_hex}'"))
        .map_err(|e| e.to_string())?;
    for table in COUNT_TABLES {
        let (b, e) = (count(&plain, table)?, count(&enc, table)?);
        let ok = match table {
            "keypairs" => e == b,
            _ => e >= b,
        };
        if !ok {
            return Err(format!("row count mismatch on {table}: backup {b}, live {e}"));
        }
    }
    let addr = |c: &Connection| -> Option<String> {
        c.query_row("SELECT value FROM config WHERE keyname='addr'", [], |r| r.get(0))
            .ok()
    };
    if addr(&plain) != addr(&enc) {
        return Err("identity (addr) differs from backup".to_string());
    }
    Ok(())
}

fn opens(path: &Path, key_hex: Option<&str>) -> bool {
    let Ok(conn) = Connection::open(path) else {
        return false;
    };
    if let Some(hex) = key_hex {
        if conn
            .pragma_update(None, "key", format!("x'{hex}'"))
            .is_err()
        {
            return false;
        }
    }
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .is_ok()
}

fn classify(path: &Path, key_hex: Option<&str>) -> Kind {
    if opens(path, None) {
        return Kind::Plain;
    }
    if key_hex.is_some_and(|k| opens(path, Some(k))) {
        return Kind::Ours;
    }
    Kind::Foreign
}

/// `dc.db` → `dc.db.<suffix>` on the same directory.
fn sibling(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    db.with_file_name(name)
}

/// One-time plaintext → SQLCipher migration with rollback (plan §3.2):
/// checkpoint, `sqlcipher_export` into `dc.db.enc`, verify (integrity,
/// user_version, row counts), then swap, keeping the plaintext bytes in
/// `dc.db.plain.bak` until the NEXT startup confirms the encrypted copy
/// opens with the key. Any failure leaves the plaintext database in place.
fn migrate(db: &Path, key_hex: &str) -> Result<(), String> {
    let key = format!("x'{key_hex}'");
    let enc = sibling(db, "enc");
    let _ = std::fs::remove_file(&enc);

    let run = || -> Result<(), String> {
        let plain = Connection::open(db).map_err(|e| format!("open plain failed: {e}"))?;
        plain
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| format!("checkpoint failed: {e}"))?;
        plain
            .execute(
                "ATTACH DATABASE ? AS enc KEY ?",
                rusqlite::params![enc.to_string_lossy(), key],
            )
            .map_err(|e| format!("attach failed: {e}"))?;
        if let Err(e) = plain.execute_batch("SELECT sqlcipher_export('enc');") {
            let _ = plain.execute_batch("DETACH DATABASE enc;");
            return Err(format!("sqlcipher_export failed: {e}"));
        }
        plain
            .execute_batch("DETACH DATABASE enc;")
            .map_err(|e| format!("detach failed: {e}"))?;
        let user_version: i64 = plain
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        drop(plain);

        let v = Connection::open(&enc).map_err(|e| format!("reopen enc failed: {e}"))?;
        v.pragma_update(None, "key", &key)
            .map_err(|e| format!("key on enc failed: {e}"))?;
        let integrity: String = v
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err(format!("integrity_check on enc: {integrity}"));
        }
        let enc_version: i64 = v
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if enc_version != user_version {
            v.pragma_update(None, "user_version", user_version)
                .map_err(|e| format!("user_version copy failed: {e}"))?;
        }
        for table in COUNT_TABLES {
            let plain_n: i64 = {
                let c = Connection::open(db).map_err(|e| e.to_string())?;
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                    .map_err(|e| format!("{table}: {e}"))?
            };
            let enc_n: i64 = v
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .map_err(|e| format!("{table}: {e}"))?;
            if plain_n != enc_n {
                return Err(format!("row count mismatch on {table}: {plain_n} vs {enc_n}"));
            }
        }
        drop(v);
        Ok(())
    };

    if let Err(e) = run().and_then(|()| sync_file(&enc).map_err(|e| format!("fsync enc failed: {e}"))) {
        let _ = std::fs::remove_file(&enc);
        return Err(e);
    }
    let dir = db.parent().unwrap_or(Path::new("."));

    // Same-volume renames do not copy. Windows has no std directory fsync;
    // the .bak survives until the next startup verifies the swap anyway.
    let swapped = std::fs::rename(db, sibling(db, "plain.bak")).is_ok()
        && match std::fs::rename(&enc, db) {
            Ok(()) => true,
            Err(e) => {
                log(&format!("second rename failed, restoring backup: {e}"));
                let _ = std::fs::rename(sibling(db, "plain.bak"), db);
                false
            }
        };
    sync_dir(dir);
    if !swapped {
        let _ = std::fs::remove_file(&enc);
        return Err("swap failed".to_string());
    }
    let _ = std::fs::remove_file(sibling(db, "wal"));
    let _ = std::fs::remove_file(sibling(db, "shm"));
    Ok(())
}

/// Scan, migrate and decide whether the sidecar may get the key. Called
/// once per desktop startup, before the sidecar exists.
pub fn prepare(accounts_root: &Path, key_hex: Option<&str>) -> Prepare {
    let mut state = Prepare {
        use_key: false,
        migrated: 0,
        already: 0,
        locked: 0,
    };
    let mut failed = 0;

    let mut dbs = account_dbs(accounts_root);

    // Crash between the two swap renames: dc.db gone, plaintext backup
    // present. Restore it first — otherwise the core would create a fresh
    // database in its place and the next start would prune the backup.
    for db in &dbs {
        let bak = sibling(db, "plain.bak");
        if !db.exists() && opens(&bak, None) {
            log(&format!("restoring plaintext backup over missing {}", db.display()));
            if let Err(e) = std::fs::rename(&bak, db) {
                log(&format!("restore failed for {}: {e}", db.display()));
            }
        }
    }
    dbs.retain(|db| db.is_file());

    // Classify (and migrate) each database. A `None` result means "restore
    // path reclassified this one" — it is re-examined on a second pass.
    for _ in 0..2 {
        let mut redo = Vec::new();
        for db in &dbs {
            let recount = match classify(db, key_hex) {
                Kind::Plain => {
                    let Some(k) = key_hex else { continue };
                    match migrate(db, k) {
                        Ok(()) => {
                            state.migrated += 1;
                            log(&format!("migrated {}", db.display()));
                        }
                        Err(e) => {
                            failed += 1;
                            log(&format!("MIGRATION FAILED for {}: {e}", db.display()));
                        }
                    }
                    false
                }
                Kind::Ours => {
                    state.already += 1;
                    // The encrypted copy opens with the key. Drop the
                    // migration backup only once it is proven to hold the
                    // same data (never a fresh db over a lost file).
                    let bak = sibling(db, "plain.bak");
                    if bak.exists() {
                        match key_hex.map(|k| bak_superseded(db, &bak, k)) {
                            Some(Ok(())) => {
                                let _ = std::fs::remove_file(&bak);
                            }
                            Some(Err(e)) => log(&format!(
                                "KEEPING backup {}: {e}",
                                bak.display()
                            )),
                            None => {}
                        }
                    }
                    false
                }
                Kind::Foreign => {
                    let bak = sibling(db, "plain.bak");
                    // An interrupted swap (live db unreadable, plaintext
                    // backup present) is rolled back rather than left locked.
                    if bak.exists() && opens(&bak, None) {
                        log(&format!(
                            "restoring plaintext backup over unreadable {}",
                            db.display()
                        ));
                        let _ = std::fs::remove_file(db);
                        let _ = std::fs::rename(&bak, db);
                        true
                    } else {
                        state.locked += 1;
                        false
                    }
                }
            };
            if recount {
                redo.push(db.clone());
            }
        }
        if redo.is_empty() {
            break;
        }
        dbs = redo;
    }

    // A key is only handed over when it does not strand every database:
    // if nothing is encrypted yet and a migration just failed, run this
    // session unencrypted and retry next start instead of locking the user
    // out. With something already encrypted the key must go over (those
    // databases cannot open without it); failed plaintext ones surface as
    // locked for this session and retry next start.
    state.use_key = key_hex.is_some() && (state.already + state.migrated > 0 || failed == 0);
    state
}

/// Desktop startup entry point: load/create the DEK, migrate plaintext
/// databases, and return the raw key for the sidecar env — `None` runs the
/// session without encryption. The third element reports an app-lock PIN
/// wrap: the session then starts LOCKED (keyless sidecar) and
/// `pin_unlock` re-keys it after the user entered the PIN.
#[cfg(not(target_os = "android"))]
pub fn startup(accounts_data_dir: &Path) -> (Option<String>, Option<KeyIssue>, bool) {
    let t0 = Instant::now();
    // A PIN wrap is the key root (the keychain item was removed when the
    // PIN was set): no keychain read at all, no new key ever.
    if pin_locked(accounts_data_dir) {
        log("app-lock PIN wrap present; starting locked");
        return (None, None, true);
    }
    let root = accounts_data_dir.join("accounts");
    let entry = keychain_entry();
    let (mut hex, create, mut issue) = decide_key(keychain_lookup(entry.as_ref()), has_encrypted(&root));
    if create {
        hex = create_dek(entry.as_ref());
        if hex.is_none() {
            issue = Some(KeyIssue::KeychainUnavailable);
        }
    }
    if let Some(i) = issue {
        log(&format!("key issue: {i:?}"));
    }
    let report = prepare(&root, hex.as_deref());
    log(&format!(
        "prepare: {} newly encrypted, {} already encrypted, {} locked, key {} ({} ms)",
        report.migrated,
        report.already,
        report.locked,
        if report.use_key { "active" } else { "off" },
        t0.elapsed().as_millis()
    ));
    if report.use_key {
        (hex.map(|h| format!("x'{h}'")), issue, false)
    } else {
        (None, issue, false)
    }
}

/// Android startup entry point (#178 phase 2): the DEK comes from the
/// Keystore via `org.velta.VeltaKeystore` (JNI, works on push/job cold
/// starts — no user auth bound to the KEK). Called from `init_android_core`
/// with the accounts ROOT (`<data>/accounts`, where `Accounts::new` puts
/// per-account dirs directly — desktop nests one level deeper through the
/// sidecar's cwd). The raw key is returned for `std::env::set_var` before
/// `Accounts::new`; a Keystore failure runs the session keyless, which
/// leaves already-encrypted databases closed until the Keystore works
/// again — nothing is recreated over them.
#[cfg(target_os = "android")]
pub fn android_startup(accounts_root: &Path) -> Option<String> {
    let t0 = Instant::now();
    let hex = crate::android_keystore_dek();
    let report = prepare(accounts_root, hex.as_deref());
    log(&format!(
        "prepare: {} newly encrypted, {} already encrypted, {} locked, key {} ({} ms)",
        report.migrated,
        report.already,
        report.locked,
        if report.use_key { "active" } else { "off" },
        t0.elapsed().as_millis()
    ));
    if report.use_key {
        hex.map(|h| format!("x'{h}'"))
    } else {
        None
    }
}

// ---- App-lock PIN (#178 phase 4, desktop) ---------------------------------
//
// The PIN replaces the OS keychain as the KEK source (plan §2.4):
// Argon2id(PIN, salt, 64 MiB / t=3) → AES-256-GCM wraps the SAME DEK into
// `<data>/dbkey.wrap`; setting a PIN removes the keychain item, clearing it
// rewrites the keychain. File layout:
// `VLTDW | u8 ver | u32 LE wrong-attempts | 16B salt | 12B nonce | 48B ct`.
// The attempts counter backs off online guessing only — a copied wrap can be
// attacked offline, so the PIN is a convenience root, not a stronger one.

#[cfg(not(target_os = "android"))]
pub fn pin_wrap_path(data_dir: &Path) -> PathBuf {
    data_dir.join("dbkey.wrap")
}

#[cfg(not(target_os = "android"))]
pub fn pin_locked(data_dir: &Path) -> bool {
    pin_wrap_path(data_dir).is_file()
}

fn derive_pin_kek(pin: &str, salt: &[u8]) -> [u8; 32] {
    use argon2::Argon2;
    let mut kek = [0u8; 32];
    let params = argon2::Params::new(64 * 1024, 3, 1, None).expect("static Argon2 params");
    Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(pin.as_bytes(), salt, &mut kek)
        .expect("Argon2id with static params cannot fail");
    kek
}

fn pin_header(counter: u32, salt: &[u8], nonce: &[u8]) -> Vec<u8> {
    let mut head = Vec::with_capacity(38);
    head.extend_from_slice(b"VLTDW");
    head.push(1);
    head.extend_from_slice(&counter.to_le_bytes());
    head.extend_from_slice(salt);
    head.extend_from_slice(nonce);
    head
}

/// Wrap `dek_hex` under `pin`. Rejects short PINs and non-hex DEKs.
pub fn pin_wrap_write(path: &Path, pin: &str, dek_hex: &str) -> Result<(), String> {
    if pin.chars().count() < 6 {
        return Err("pin too short".to_string());
    }
    if dek_hex.len() != 64 || !dek_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad dek".to_string());
    }
    let salt = crate::random_bytes::<16>();
    let nonce = crate::random_bytes::<12>();
    let head = pin_header(0, &salt, &nonce);
    // The AAD binds everything EXCEPT the clear-text attempts counter
    // (bytes 6..10), which moves on wrong attempts without a rewrap.
    let mut aad = Vec::with_capacity(34);
    aad.extend_from_slice(&head[0..6]);
    aad.extend_from_slice(&salt);
    aad.extend_from_slice(&nonce);
    let ct = {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};
        let cipher = Aes256Gcm::new((&derive_pin_kek(pin, &salt)).into());
        let dek = data_encoding::HEXLOWER
            .decode(dek_hex.as_bytes())
            .map_err(|_| "bad dek".to_string())?;
        cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &dek, aad: &aad })
            .map_err(|_| "encrypt failed".to_string())?
    };
    let mut file = head;
    file.extend_from_slice(&ct);
    std::fs::write(path, file).map_err(|e| format!("wrap write failed: {e}"))
}

/// Patch the clear-text attempts counter (offset 6..10) without rewrapping.
fn pin_counter_store(path: &Path, counter: u32) {
    if let Ok(mut bytes) = std::fs::read(path) {
        if bytes.len() >= 10 {
            bytes[6..10].copy_from_slice(&counter.to_le_bytes());
            let _ = std::fs::write(path, bytes);
        }
    }
}

fn backoff_secs(attempts: u32) -> u64 {
    match attempts {
        0 => 0,
        n => 30.min(1u64 << (n - 1).min(5)),
    }
}

/// What opening the PIN wrap produced.
pub enum PinOpen {
    /// The DEK hex, verified by the GCM tag.
    Dek(String),
    /// Wrong PIN; the wrap now records `attempts` and asks for `delay_secs`.
    Wrong { attempts: u32, delay_secs: u64 },
    /// Not a Velta wrap (truncated/foreign bytes) — locked, never reset.
    Corrupt,
}

pub fn pin_wrap_open(path: &Path, pin: &str) -> PinOpen {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            log(&format!("pin wrap unreadable: {e}"));
            return PinOpen::Corrupt;
        }
    };
    if bytes.len() != 86 || &bytes[0..5] != b"VLTDW" || bytes[5] != 1 {
        return PinOpen::Corrupt;
    }
    let attempts = u32::from_le_bytes(bytes[6..10].try_into().unwrap());
    let (salt, nonce, ct) = (&bytes[10..26], &bytes[26..38], &bytes[38..]);
    let mut aad = Vec::with_capacity(34);
    aad.extend_from_slice(&bytes[0..6]);
    aad.extend_from_slice(salt);
    aad.extend_from_slice(nonce);
    let open = (|| {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};
        let cipher = Aes256Gcm::new((&derive_pin_kek(pin, salt)).into());
        let dek = cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad }).ok()?;
        Some(data_encoding::HEXLOWER.encode(&dek))
    })();
    match open {
        Some(hex) => {
            pin_counter_store(path, 0);
            PinOpen::Dek(hex)
        }
        None => {
            let attempts = attempts.saturating_add(1);
            pin_counter_store(path, attempts);
            PinOpen::Wrong { attempts, delay_secs: backoff_secs(attempts) }
        }
    }
}

/// Verify the wrap with `old_pin` (when a PIN is already set), wrap the DEK
/// under `new_pin`, and drop the keychain item — the PIN replaces it. The
/// DEK itself never changes, so a running keyed session is unaffected.
#[cfg(not(target_os = "android"))]
pub fn pin_set(data_dir: &Path, old_pin: Option<&str>, new_pin: &str) -> Result<(), String> {
    let path = pin_wrap_path(data_dir);
    let dek = if path.is_file() {
        let Some(old) = old_pin else { return Err("current-pin-required".to_string()) };
        match pin_wrap_open(&path, old) {
            PinOpen::Dek(dek) => dek,
            PinOpen::Wrong { delay_secs, .. } => return Err(format!("retry:{delay_secs}")),
            PinOpen::Corrupt => return Err("corrupt".to_string()),
        }
    } else {
        match keychain_lookup(keychain_entry().as_ref()) {
            Lookup::Found(dek) => dek,
            Lookup::NoEntry => return Err("no-key".to_string()),
            Lookup::Unavailable => return Err("keychain-unavailable".to_string()),
        }
    };
    pin_wrap_write(&path, new_pin, &dek)?;
    // Paranoia: the wrap must open with the exact PIN we just wrote.
    if !matches!(pin_wrap_open(&path, new_pin), PinOpen::Dek(_)) {
        let _ = std::fs::remove_file(&path);
        return Err("wrap verify failed".to_string());
    }
    if let Some(entry) = keychain_entry() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log(&format!("keychain delete failed: {e}")),
        }
    }
    log("app-lock PIN is now the key root; keychain item removed");
    Ok(())
}

/// Verify `pin`, store the DEK back in the keychain, remove the wrap.
#[cfg(not(target_os = "android"))]
pub fn pin_clear(data_dir: &Path, pin: &str) -> Result<(), String> {
    let path = pin_wrap_path(data_dir);
    let dek = match pin_wrap_open(&path, pin) {
        PinOpen::Dek(dek) => dek,
        PinOpen::Wrong { delay_secs, .. } => return Err(format!("retry:{delay_secs}")),
        PinOpen::Corrupt => return Err("corrupt".to_string()),
    };
    let Some(entry) = keychain_entry() else {
        return Err("keychain-unavailable".to_string());
    };
    entry
        .set_password(&dek)
        .map_err(|e| format!("keychain write failed: {e}"))?;
    let _ = std::fs::remove_file(&path);
    log("app-lock PIN removed; DEK back in the keychain");
    Ok(())
}

/// Verify `pin` and migrate any plaintext databases — returns the raw key
/// for the respawned sidecar env. The wrap's counter resets on success.
#[cfg(not(target_os = "android"))]
pub fn pin_unlock(data_dir: &Path, accounts_root: &Path, pin: &str) -> Result<String, String> {
    let path = pin_wrap_path(data_dir);
    let hex = match pin_wrap_open(&path, pin) {
        PinOpen::Dek(hex) => hex,
        PinOpen::Wrong { delay_secs, .. } => return Err(format!("retry:{delay_secs}")),
        PinOpen::Corrupt => return Err("corrupt".to_string()),
    };
    let report = prepare(accounts_root, Some(&hex));
    if !report.use_key {
        return Err("prepare-failed".to_string());
    }
    log(&format!(
        "pin unlock: {} migrated, {} already encrypted, {} locked",
        report.migrated, report.already, report.locked
    ));
    Ok(format!("x'{hex}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const OTHER: &str = "ff112233445566778899aabbccddeeff00112233445566778899aabbccddee00";

    static TMP_N: AtomicUsize = AtomicUsize::new(0);

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "velta-dbkey-test-{}-{}",
            std::process::id(),
            TMP_N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A tiny stand-in for a core database: the counted tables exist and a
    /// marker row is in msgs, so verification has something to bite on.
    fn plant_plain_db(dir: &Path, rows: i64) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let db = dir.join("dc.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE msgs (id INTEGER PRIMARY KEY, txt TEXT);
             CREATE TABLE chats (id INTEGER PRIMARY KEY);
             CREATE TABLE contacts (id INTEGER PRIMARY KEY);
             CREATE TABLE config (id INTEGER PRIMARY KEY, keyname TEXT, value TEXT);
             INSERT INTO config (keyname, value) VALUES ('addr', 'me@example.org');
             CREATE TABLE keypairs (id INTEGER PRIMARY KEY);
             PRAGMA user_version = 7;",
        )
        .unwrap();
        for i in 0..rows {
            conn.execute("INSERT INTO msgs (txt) VALUES (?1)", [&format!("m{i}")])
                .unwrap();
        }
        drop(conn);
        db
    }

    fn keyed_count(db: &Path, hex: &str, sql: &str) -> i64 {
        let c = Connection::open(db).unwrap();
        c.pragma_update(None, "key", format!("x'{hex}'")).unwrap();
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migration_round_trip_and_rollback_copy() {
        let dir = tmpdir();
        // Production layout: prepare() scans <root>/<account-uuid>/dc.db.
        let db = plant_plain_db(&dir.join("acc1"), 3);

        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.migrated, p.already, p.locked, p.use_key), (1, 0, 0, true));

        // Encrypted now, plaintext no longer; rows and version survived.
        assert!(!opens(&db, None));
        assert!(!opens(&db, Some(OTHER)));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 3);
        assert_eq!(keyed_count(&db, KEY, "PRAGMA user_version"), 7);
        // The rollback copy exists until the next startup verifies it,
        // and still holds the same schema, readable as plaintext.
        let bak = dir.join("acc1").join("dc.db.plain.bak");
        assert!(opens(&bak, None));

        // Second startup: classified ours, backup pruned, still keyed.
        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.migrated, p.already, p.use_key), (0, 1, true));
        assert!(!bak.exists());
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 3);
    }

    #[test]
    fn foreign_database_is_locked_never_touched() {
        let dir = tmpdir();
        let db = plant_plain_db(&dir.join("acc1"), 1);
        // A completed previous lifecycle: encrypted with someone else's key,
        // its rollback copy already pruned.
        prepare(&dir, Some(OTHER));
        let _ = std::fs::remove_file(dir.join("acc1").join("dc.db.plain.bak"));
        assert!(!opens(&db, None));
        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.locked, p.already, p.migrated), (1, 0, 0));
        // Untouched: still exactly the bytes the other key produced.
        assert!(opens(&db, Some(OTHER)));
        assert!(!dir.join("acc1").join("dc.db.plain.bak").exists());
    }

    #[test]
    fn interrupted_swap_restores_then_migrates() {
        let dir = tmpdir();
        let db = plant_plain_db(&dir.join("acc1"), 2);
        std::fs::rename(&db, dir.join("acc1").join("dc.db.plain.bak")).unwrap();
        std::fs::write(&db, b"not a database at all").unwrap();

        // The interrupted swap is rolled back to the plaintext backup and
        // the migration is redone in the same run.
        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.locked, p.migrated, p.already), (0, 1, 0));
        assert!(!opens(&db, None));
        assert!(opens(&db, Some(KEY)));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 2);
    }

    #[test]
    fn policy_keyless_session_when_a_first_migration_fails() {
        let dir = tmpdir();
        let db = plant_plain_db(&dir.join("acc1"), 1);
        // Make the export target un-creatable: the migration fails, nothing
        // is encrypted yet, so the session must stay keyless and the
        // plaintext db must be untouched (retry next start, no lockout).
        std::fs::create_dir_all(dir.join("acc1").join("dc.db.enc")).unwrap();
        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.migrated, p.already, p.locked, p.use_key), (0, 0, 0, false));
        assert!(opens(&db, None));

        // No keychain key at all: nothing is ever migrated.
        let dir2 = tmpdir();
        let db2 = plant_plain_db(&dir2.join("acc1"), 1);
        let p = prepare(&dir2, None);
        assert_eq!((p.migrated, p.use_key), (0, false));
        assert!(opens(&db2, None));
    }

    #[test]
    fn test_keys_are_64_hex() {
        for k in [KEY, OTHER] {
            assert_eq!(k.len(), 64);
            assert!(k.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    /// Crash after `dc.db -> dc.db.plain.bak` but before `dc.db.enc ->
    /// dc.db`: no live db at all. Must restore and re-migrate, not let the
    /// core create a fresh database and later prune the only copy.
    #[test]
    fn crash_between_renames_restores_and_remigrates() {
        let dir = tmpdir();
        let acc = dir.join("acc1");
        let db = plant_plain_db(&acc, 4);
        std::fs::rename(&db, acc.join("dc.db.plain.bak")).unwrap();
        // A half-written export may also be left behind.
        std::fs::write(acc.join("dc.db.enc"), b"partial").unwrap();
        assert!(!db.exists());
        assert!(!has_encrypted(&dir));

        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.migrated, p.locked, p.use_key), (1, 0, true));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 4);
        assert!(!acc.join("dc.db.enc").exists());

        // Next start: backup verified against the live db, then pruned.
        let p = prepare(&dir, Some(KEY));
        assert_eq!(p.already, 1);
        assert!(!acc.join("dc.db.plain.bak").exists());
    }

    /// The original failure: a FRESH keyed db sits where the data was and
    /// the plaintext backup still has it. The backup must never be pruned.
    #[test]
    fn backup_kept_when_live_db_is_not_the_same_data() {
        let dir = tmpdir();
        let acc = dir.join("acc1");
        let db = plant_plain_db(&acc, 5);
        let bak = acc.join("dc.db.plain.bak");
        std::fs::rename(&db, &bak).unwrap();
        // Fresh empty keyed db (what the core would create).
        {
            let c = Connection::open(&db).unwrap();
            c.pragma_update(None, "key", format!("x'{KEY}'")).unwrap();
            c.execute_batch(
                "CREATE TABLE msgs (id INTEGER PRIMARY KEY, txt TEXT);
                 CREATE TABLE chats (id INTEGER PRIMARY KEY);
                 CREATE TABLE contacts (id INTEGER PRIMARY KEY);
                 CREATE TABLE config (id INTEGER PRIMARY KEY, keyname TEXT, value TEXT);
                 CREATE TABLE keypairs (id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        }
        assert!(opens(&db, Some(KEY)));

        let p = prepare(&dir, Some(KEY));
        assert_eq!(p.already, 1);
        assert!(bak.exists(), "backup with more data must be kept");
        assert!(opens(&bak, None));
    }

    #[test]
    fn key_policy_never_mixes_keys() {
        let k = || Lookup::Found(KEY.to_string());
        assert_eq!(decide_key(k(), true), (Some(KEY.to_string()), false, None));
        assert_eq!(decide_key(k(), false), (Some(KEY.to_string()), false, None));
        // Fresh install: create.
        assert_eq!(decide_key(Lookup::NoEntry, false), (None, true, None));
        // Encrypted data but no key: do NOT create, report it.
        assert_eq!(decide_key(Lookup::NoEntry, true), (None, false, Some(KeyIssue::KeyMissing)));
        assert_eq!(decide_key(Lookup::Unavailable, true), (None, false, Some(KeyIssue::KeyMissing)));
        // No keychain at all (Linux without Secret Service): plaintext, reported.
        assert_eq!(
            decide_key(Lookup::Unavailable, false),
            (None, false, Some(KeyIssue::KeychainUnavailable))
        );
    }

    #[test]
    fn has_encrypted_detects_keyed_databases() {
        let dir = tmpdir();
        plant_plain_db(&dir.join("acc1"), 1);
        assert!(!has_encrypted(&dir));
        prepare(&dir, Some(KEY));
        assert!(has_encrypted(&dir));
    }

    #[test]
    fn sibling_naming_matches_plan() {
        let db = Path::new("/x/accounts/uuid/dc.db");
        assert_eq!(sibling(db, "enc"), PathBuf::from("/x/accounts/uuid/dc.db.enc"));
        assert_eq!(
            sibling(db, "plain.bak"),
            PathBuf::from("/x/accounts/uuid/dc.db.plain.bak")
        );
    }

    #[test]
    fn pin_wrap_roundtrip_and_backoff() {
        let dir = tmpdir();
        let wrap = pin_wrap_path(&dir);
        assert!(matches!(pin_wrap_write(&wrap, "12345", KEY), Err(_)), "short PIN refused");

        pin_wrap_write(&wrap, "123456", KEY).unwrap();
        assert!(matches!(pin_wrap_open(&wrap, "123456"), PinOpen::Dek(d) if d == KEY));
        assert!(!matches!(pin_wrap_open(&wrap, OTHER), PinOpen::Dek(_)));

        // Wrong attempts back off 1s, 2s, … and the counter is clear-text
        // (the OTHER attempt above already counted).
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 2, delay_secs: 2 }));
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 3, delay_secs: 4 }));
        // The right PIN still opens and resets the counter.
        assert!(matches!(pin_wrap_open(&wrap, "123456"), PinOpen::Dek(d) if d == KEY));
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 1, delay_secs: 1 }));
        assert_eq!(backoff_secs(10), 30, "capped");
    }

    #[test]
    fn pin_wrap_corrupt_is_locked_never_reset() {
        let dir = tmpdir();
        let wrap = pin_wrap_path(&dir);
        pin_wrap_write(&wrap, "123456", KEY).unwrap();
        let mut bytes = std::fs::read(&wrap).unwrap();
        bytes[0] = b'X'; // foreign magic
        std::fs::write(&wrap, bytes).unwrap();
        assert!(matches!(pin_wrap_open(&wrap, "123456"), PinOpen::Corrupt));
        let dir2 = tmpdir();
        std::fs::write(pin_wrap_path(&dir2), b"tiny").unwrap();
        assert!(matches!(pin_wrap_open(&pin_wrap_path(&dir2), "123456"), PinOpen::Corrupt));
    }

    #[test]
    fn pin_unlock_migrates_and_returns_the_key() {
        let dir = tmpdir();
        let db = plant_plain_db(&dir.join("acc1"), 2);
        pin_wrap_write(&pin_wrap_path(&dir), "654321", KEY).unwrap();
        assert!(pin_locked(&dir));

        let raw = pin_unlock(&dir, &dir, "654321").unwrap();
        assert_eq!(raw, format!("x'{KEY}'"));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 2);
        assert!(!opens(&db, None));

        // Wrong PIN: retry backoff, data untouched.
        assert!(matches!(
            pin_unlock(&dir, &dir, "000000"),
            Err(e) if e.starts_with("retry:")
        ));
        assert!(opens(&db, Some(KEY)));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 2);

        // Second unlock: already encrypted, same key back.
        assert_eq!(pin_unlock(&dir, &dir, "654321").unwrap(), raw);
    }
}
