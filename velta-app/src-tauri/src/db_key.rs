//! Database encryption at rest (#178, phases 1–2 — desktop and Android).
//!
//! One random 256-bit DEK per install. The raw SQLCipher key (`x'<64 hex>'`,
//! skips PBKDF2) reaches the core via the `VELTA_DB_KEY` env var (core quilt
//! patch #20): desktop passes it to the spawned rpc-server sidecar (`cmd.env`,
//! never `install_env` in the parent), Android calls [`install_env`] before
//! `Accounts::new`. The DEK itself lives in the OS
//! keychain — desktop: `keyring` (Windows Credential Manager/DPAPI, macOS
//! login Keychain, Linux Secret Service); Android: AndroidKeyStore KEK
//! wrapping the DEK (`org.velta.VeltaKeystore`, blob in `noBackupFilesDir`).
//! Windows Hello (`dbkey.wrap.hello`, `win_hello.rs`) and the app-lock PIN
//! each replace that keychain item. No plaintext key file ever exists.
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

/// Install `VELTA_DB_KEY` for this process. This is the only writer of that
/// variable in the crate.
///
/// Desktop never uses this: the sidecar gets `cmd.env` before the child
/// exists. Android still calls it after the tokio runtime exists
/// (biometric/PIN unlock arrives later). The invariant is "once per
/// process, one function, before `Accounts::new` on that start attempt" —
/// not a claim that the mutation happens pre-thread on Android.
#[cfg(target_os = "android")]
pub fn install_env(raw: &str) {
    // Runtime env mutation is process-global. Callers must not race a
    // concurrent `Accounts::new` on this start attempt.
    #[allow(unused_unsafe, deprecated)]
    unsafe {
        std::env::set_var("VELTA_DB_KEY", raw);
    }
}

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
fn keychain_entry_legacy() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| log(&format!("keychain unavailable: {e}")))
        .ok()
}

/// #527: the DEK credential is scoped per identity. The pre-fix item was
/// ONE SHARED credential (fixed service + user) that every Velta build on
/// the machine read and rewrote — a test-rig build re-keyed the real
/// profile's store with its own fresh key. The scope is the tauri
/// identifier.
#[cfg(not(target_os = "android"))]
fn keychain_entry(identity: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(&format!("{KEYCHAIN_SERVICE}.{identity}"), KEYCHAIN_USER)
        .map_err(|e| log(&format!("keychain unavailable: {e}")))
        .ok()
}

/// Startup DEK selection with the #527 legacy adoption: the scoped item
/// wins; without it, the pre-scoping shared DEK is adopted only when it
/// demonstrably opens this identity's databases (a foreign key must never
/// encrypt a plaintext store it cannot be recovered for).
#[cfg(not(target_os = "android"))]
fn startup_lookup(scoped: Lookup, legacy_hex: Option<String>, opens_ours: bool) -> Lookup {
    match scoped {
        Lookup::Found(hex) => Lookup::Found(hex),
        Lookup::NoEntry if legacy_hex.is_some() && opens_ours => {
            Lookup::Found(legacy_hex.expect("checked"))
        }
        other => other,
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

/// Store `hex` and prove it stuck: the write must succeed AND a fresh read
/// must return the same key. A store that accepts the write but does not
/// keep it (shared/foreign credential store, #527) must never lead to a
/// re-key.
#[cfg(not(target_os = "android"))]
fn persist_verified(
    set: impl FnOnce(&str) -> Result<(), String>,
    get: impl FnOnce() -> Option<String>,
    hex: &str,
) -> bool {
    if let Err(e) = set(hex) {
        log(&format!("keychain write failed: {e}"));
        return false;
    }
    if get().as_deref() != Some(hex) {
        log("keychain read-back mismatch after write; not using the new key");
        return false;
    }
    true
}

/// Generate and store a new DEK. `None` = the keychain refused or lost it.
#[cfg(not(target_os = "android"))]
fn create_dek(entry: Option<&keyring::Entry>) -> Option<String> {
    let entry = entry?;
    let bytes = crate::random_bytes::<32>();
    let hex: String = data_encoding::HEXLOWER.encode(&bytes);
    let ok = persist_verified(
        |h| entry.set_password(h).map_err(|e| e.to_string()),
        || entry.get_password().ok(),
        &hex,
    );
    if !ok {
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
    let marker = sibling(db, "migrating");
    if let Err(e) = std::fs::write(&marker, b"1").and_then(|()| sync_file(&marker)) {
        let _ = std::fs::remove_file(&enc);
        return Err(format!("marker write failed: {e}"));
    }
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
        let _ = std::fs::remove_file(&marker);
        return Err("swap failed".to_string());
    }
    let _ = std::fs::remove_file(&marker);
    let _ = std::fs::remove_file(sibling(db, "wal"));
    let _ = std::fs::remove_file(sibling(db, "shm"));
    Ok(())
}

/// Interrupted-migration rollback, only reached with the marker present.
/// The unreadable live file is quarantined, never deleted; errors surface.
fn rollback_unfinished(db: &Path, bak: &Path, marker: &Path) -> Result<(), String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let locked = sibling(db, &format!("locked-{ts}"));
    std::fs::rename(db, &locked).map_err(|e| format!("quarantine: {e}"))?;
    if let Err(e) = std::fs::rename(bak, db) {
        let _ = std::fs::rename(&locked, db);
        return Err(format!("restore backup: {e}"));
    }
    let _ = std::fs::remove_file(marker);
    log(&format!("rolled back unfinished migration; live db kept as {}", locked.display()));
    Ok(())
}

/// Scan, migrate and decide whether the sidecar may get the key. Called
/// once per desktop startup, before the sidecar exists.
#[cfg(any(target_os = "android", test))]
pub fn prepare(accounts_root: &Path, key_hex: Option<&str>) -> Prepare {
    prepare_dbs(account_dbs(accounts_root), key_hex)
}

fn prepare_dbs(mut dbs: Vec<PathBuf>, key_hex: Option<&str>) -> Prepare {
    let mut state = Prepare {
        use_key: false,
        migrated: 0,
        already: 0,
        locked: 0,
    };
    let mut failed = 0;

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
                    let _ = std::fs::remove_file(sibling(db, "migrating"));
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
                    // Foreign = "did not open with THIS key": a healthy
                    // encrypted db with a missing/other key lands here too.
                    // Never replace it with the plaintext backup. Only the
                    // migration marker proves an unfinished swap, and even
                    // then the live file is quarantined, never deleted.
                    let bak = sibling(db, "plain.bak");
                    let marker = sibling(db, "migrating");
                    if marker.exists() && bak.exists() && opens(&bak, None) {
                        match rollback_unfinished(db, &bak, &marker) {
                            Ok(()) => true,
                            Err(e) => {
                                log(&format!("rollback FAILED for {}: {e}", db.display()));
                                state.locked += 1;
                                false
                            }
                        }
                    } else {
                        if bak.exists() {
                            log(&format!(
                                "LOCKED {} (keeping {} untouched)",
                                db.display(),
                                bak.display()
                            ));
                        }
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

/// #527/#541: the core's accounts root is `<data>/` (shallow: uuid dirs
/// directly under it) on current layouts but `<data>/accounts/` on legacy
/// ones. Key decisions must see BOTH, or `has_encrypted` is blind to the
/// real databases and a fresh DEK is minted over them.
#[cfg(not(target_os = "android"))]
pub fn core_roots(data_dir: &Path) -> Vec<PathBuf> {
    vec![data_dir.to_path_buf(), data_dir.join("accounts")]
}

#[cfg(not(target_os = "android"))]
fn has_encrypted_any(data_dir: &Path) -> bool {
    core_roots(data_dir).iter().any(|r| has_encrypted(r))
}

/// The databases of THIS identity's core accounts under `root`: only a root
/// that holds `accounts.toml`, and only child dirs the toml names. Anything
/// else under the data dir (a nested accounts tree, p2p-blobs, stray files)
/// is never encrypted by us.
#[cfg(not(target_os = "android"))]
fn listed_account_dbs(root: &Path) -> Vec<PathBuf> {
    let Ok(toml) = std::fs::read_to_string(root.join("accounts.toml")) else {
        return Vec::new();
    };
    account_dbs(root)
        .into_iter()
        .filter(|db| {
            db.parent()
                .and_then(|d| d.file_name())
                .and_then(|n| n.to_str())
                .is_some_and(|n| toml.contains(n))
        })
        .collect()
}

/// `prepare` over every candidate root (core accounts only), results summed.
#[cfg(not(target_os = "android"))]
pub fn prepare_all(data_dir: &Path, key_hex: Option<&str>) -> Prepare {
    let mut total = Prepare { use_key: false, migrated: 0, already: 0, locked: 0 };
    let mut any_key = false;
    let mut any_db = false;
    for r in core_roots(data_dir) {
        let dbs = listed_account_dbs(&r);
        if dbs.is_empty() {
            continue;
        }
        any_db = true;
        let p = prepare_dbs(dbs, key_hex);
        any_key |= p.use_key;
        total.migrated += p.migrated;
        total.already += p.already;
        total.locked += p.locked;
    }
    total.use_key = any_key || (key_hex.is_some() && !any_db);
    total
}

/// Pure key decision for startup: (key, create, issue, adopted-legacy).
#[cfg(not(target_os = "android"))]
fn startup_decision(
    data_dir: &Path,
    scoped: Lookup,
    legacy_hex: Option<String>,
) -> (Option<String>, bool, Option<KeyIssue>, bool) {
    let mut lookup = scoped;
    let mut adopted = false;
    if let (true, Some(l)) = (matches!(lookup, Lookup::NoEntry | Lookup::Unavailable), legacy_hex) {
        let ours = core_roots(data_dir)
            .iter()
            .flat_map(|r| account_dbs(r))
            .any(|db| opens(&db, Some(l.as_str())));
        lookup = startup_lookup(lookup, Some(l), ours);
        adopted = matches!(lookup, Lookup::Found(_));
    }
    let (hex, create, issue) = decide_key(lookup, has_encrypted_any(data_dir));
    (hex, create, issue, adopted)
}

/// Desktop startup entry point: load/create the DEK, migrate plaintext
/// databases, and return the raw key for the sidecar env — `None` runs the
/// session without encryption. The third element is true when a PIN wrap or
/// a Windows Hello wrap is the key root: the session starts LOCKED (keyless
/// sidecar) until `pin_unlock` or `hello_unlock`.
#[cfg(not(target_os = "android"))]
pub fn startup(accounts_data_dir: &Path, identity: &str) -> (Option<String>, Option<KeyIssue>, bool) {
    let t0 = Instant::now();
    // A wrap is the key root (the keychain item was removed when it was
    // set): no keychain read at all, no new key ever.
    if hello_locked(accounts_data_dir) || pin_locked(accounts_data_dir) {
        log("app-lock wrap present; starting locked");
        return (None, None, true);
    }
    let entry = keychain_entry(identity);
    let scoped = keychain_lookup(entry.as_ref());
    let legacy = if matches!(scoped, Lookup::NoEntry | Lookup::Unavailable) {
        match keychain_lookup(keychain_entry_legacy().as_ref()) {
            Lookup::Found(h) => Some(h),
            _ => None,
        }
    } else {
        None
    };
    let (mut hex, create, mut issue, adopted) = startup_decision(accounts_data_dir, scoped, legacy);
    if adopted {
        if let (Some(e), Some(h)) = (entry.as_ref(), hex.as_ref()) {
            let _ = e.set_password(h);
            log("adopted the legacy shared DEK into this identity's scoped item");
        }
    }
    if create {
        hex = create_dek(entry.as_ref());
        if hex.is_none() {
            issue = Some(KeyIssue::KeychainUnavailable);
        }
    }
    if let Some(i) = issue {
        log(&format!("key issue: {i:?}"));
    }
    let report = prepare_all(accounts_data_dir, hex.as_deref());
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
/// sidecar's cwd). The raw key is returned for [`install_env`] before
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
    write_atomic(path, &file)?;
    // A fresh wrap starts from zero attempts.
    let _ = std::fs::remove_file(pin_counter_path(path));
    Ok(())
}

/// tmp + fsync + rename: a crash or full disk never leaves a torn or empty
/// wrap, and an existing wrap is replaced only by a complete one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let r = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        if let Some(d) = path.parent() {
            sync_dir(d);
        }
        Ok(())
    })();
    r.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("wrap write failed: {e}")
    })
}

/// The wrong-attempts counter lives in its own file next to the wrap
/// (`dbkey.wrap.attempts`). An attempt never rewrites the wrap: it is the
/// only copy of the key once the keychain item is gone, so a crash during an
/// attempt must not be able to tear it. The header counter (bytes 6..10) is
/// only read, for wraps written before this file existed.
pub fn pin_counter_path(wrap: &Path) -> PathBuf {
    let mut name = wrap.file_name().unwrap_or_default().to_os_string();
    name.push(".attempts");
    wrap.with_file_name(name)
}

/// Current counter: the side file when it is a complete record, else the
/// legacy header value. A torn side file costs only the counter.
fn pin_counter_load(wrap: &Path, header: u32) -> u32 {
    match std::fs::read(pin_counter_path(wrap)) {
        Ok(b) if b.len() == 4 => u32::from_le_bytes(b[..4].try_into().unwrap()),
        _ => header,
    }
}

/// Persist the counter via temp + fsync + rename; the wrap is not touched.
/// A failed write is logged, not swallowed silently.
fn pin_counter_store(wrap: &Path, counter: u32) {
    let side = pin_counter_path(wrap);
    if counter == 0 {
        // A success clears the counter. The legacy header value is ignored
        // once the side file says 0, so write 0 rather than delete when the
        // header still holds an old count.
        let header_zero = std::fs::read(wrap)
            .ok()
            .filter(|b| b.len() >= 10)
            .is_some_and(|b| b[6..10] == [0, 0, 0, 0]);
        if header_zero {
            let _ = std::fs::remove_file(&side);
            return;
        }
    }
    if let Err(e) = write_atomic(&side, &counter.to_le_bytes()) {
        log(&format!("pin attempt counter not saved: {e}"));
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
    let attempts = pin_counter_load(path, u32::from_le_bytes(bytes[6..10].try_into().unwrap()));
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
/// under `new_pin`, and drop the keychain item — the PIN replaces it. A
/// Windows Hello wrap, when that is the only copy, is decrypted to read the
/// same DEK. The DEK itself never changes, so a running keyed session is
/// unaffected.
#[cfg(not(target_os = "android"))]
pub fn pin_set(data_dir: &Path, old_pin: Option<&str>, new_pin: &str, identity: &str) -> Result<(), String> {
    let path = pin_wrap_path(data_dir);
    let dek = if path.is_file() {
        let Some(old) = old_pin else { return Err("current-pin-required".to_string()) };
        match pin_wrap_open(&path, old) {
            PinOpen::Dek(dek) => dek,
            PinOpen::Wrong { delay_secs, .. } => return Err(format!("retry:{delay_secs}")),
            PinOpen::Corrupt => return Err("corrupt".to_string()),
        }
    } else if hello_locked(data_dir) {
        #[cfg(windows)]
        {
            hello_dek(data_dir)?
        }
        #[cfg(not(windows))]
        {
            return Err("no-key".to_string());
        }
    } else {
        match keychain_lookup(keychain_entry(identity).as_ref()) {
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
    if let Some(entry) = keychain_entry(identity) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log(&format!("keychain delete failed: {e}")),
        }
    }
    log("app-lock PIN is now the key root; keychain item removed");
    Ok(())
}

/// Verify `pin`, store the DEK back in the keychain, remove the wrap.
/// A Windows Hello wrap that is still present stays the key root — the
/// keychain item is not restored.
#[cfg(not(target_os = "android"))]
pub fn pin_clear(data_dir: &Path, pin: &str, identity: &str) -> Result<(), String> {
    let path = pin_wrap_path(data_dir);
    let dek = match pin_wrap_open(&path, pin) {
        PinOpen::Dek(dek) => dek,
        PinOpen::Wrong { delay_secs, .. } => return Err(format!("retry:{delay_secs}")),
        PinOpen::Corrupt => return Err("corrupt".to_string()),
    };
    if hello_locked(data_dir) {
        let _ = std::fs::remove_file(&path);
        log("app-lock PIN removed; Windows Hello remains the key root");
        return Ok(());
    }
    let Some(entry) = keychain_entry(identity) else {
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
pub fn pin_unlock(data_dir: &Path, pin: &str) -> Result<String, String> {
    let path = pin_wrap_path(data_dir);
    let hex = match pin_wrap_open(&path, pin) {
        PinOpen::Dek(hex) => hex,
        PinOpen::Wrong { attempts, delay_secs } => {
            log(&format!("pin unlock: wrong PIN (attempt {attempts}, wait {delay_secs} s)"));
            return Err(format!("retry:{delay_secs}"));
        }
        PinOpen::Corrupt => return Err("corrupt".to_string()),
    };
    // #527: never re-key unless the wrap that holds this DEK is durably on
    // disk where startup() reads it.
    if !pin_wrap_path(data_dir).is_file() {
        return Err("wrap-missing".to_string());
    }
    let report = prepare_all(data_dir, Some(&hex));
    if !report.use_key {
        return Err("prepare-failed".to_string());
    }
    log(&format!(
        "pin unlock: {} migrated, {} already encrypted, {} locked",
        report.migrated, report.already, report.locked
    ));
    Ok(format!("x'{hex}'"))
}

// ---- Windows Hello (#178) -------------------------------------------------
//
// Same custody rule as the PIN: the wrap file replaces the keychain item.
// File layout: `VLTHW | u8 ver=1 | 12B nonce | 48B AES-GCM ct` of the DEK
// (66 bytes). The wrapping key is derived from the Hello signature
// (`win_hello.rs`); decrypting asks Windows Hello every time.

#[cfg(windows)]
pub fn hello_wrap_path(data_dir: &Path) -> PathBuf {
    data_dir.join("dbkey.wrap.hello")
}

/// Wrap body inside a well-formed Hello wrap. Wrong magic or length is not
/// a wrap.
#[cfg(any(windows, test))]
pub fn hello_wrap_ct(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() != 66 || &bytes[0..5] != b"VLTHW" || bytes[5] != 1 {
        return None;
    }
    Some(&bytes[6..])
}

#[cfg(not(target_os = "android"))]
pub fn hello_locked(data_dir: &Path) -> bool {
    #[cfg(windows)]
    {
        std::fs::read(hello_wrap_path(data_dir))
            .ok()
            .is_some_and(|b| hello_wrap_ct(&b).is_some())
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        false
    }
}

#[cfg(windows)]
fn hello_ct(data_dir: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(hello_wrap_path(data_dir)).map_err(|_| "corrupt".to_string())?;
    hello_wrap_ct(&bytes)
        .map(|ct| ct.to_vec())
        .ok_or_else(|| "corrupt".to_string())
}

#[cfg(windows)]
fn hello_dek(data_dir: &Path) -> Result<String, String> {
    let raw = crate::win_hello::open(&hello_ct(data_dir)?)?;
    Ok(data_encoding::HEXLOWER.encode(&raw))
}

#[cfg(windows)]
fn drop_keychain(identity: &str) {
    if let Some(entry) = keychain_entry(identity) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log(&format!("keychain delete failed: {e}")),
        }
    }
}

/// Read the current DEK from the PIN wrap, the Hello wrap, or the keychain.
#[cfg(windows)]
fn current_dek(data_dir: &Path, pin: Option<&str>, identity: &str) -> Result<String, String> {
    let path = pin_wrap_path(data_dir);
    if path.is_file() {
        let Some(pin) = pin else { return Err("current-pin-required".to_string()) };
        return match pin_wrap_open(&path, pin) {
            PinOpen::Dek(dek) => Ok(dek),
            PinOpen::Wrong { delay_secs, .. } => Err(format!("retry:{delay_secs}")),
            PinOpen::Corrupt => Err("corrupt".to_string()),
        };
    }
    if hello_locked(data_dir) {
        return hello_dek(data_dir);
    }
    match keychain_lookup(keychain_entry(identity).as_ref()) {
        Lookup::Found(dek) => Ok(dek),
        Lookup::NoEntry => Err("no-key".to_string()),
        Lookup::Unavailable => Err("keychain-unavailable".to_string()),
    }
}

/// Wrap the DEK under the Hello credential and drop the keychain copy. One
/// Hello prompt total (the sign in `seal`; creation rides it on first use).
/// The PIN wrap, if any, stays as the fallback.
#[cfg(windows)]
pub fn hello_set(data_dir: &Path, pin: Option<&str>, identity: &str) -> Result<(), String> {
    if hello_locked(data_dir) {
        return Ok(());
    }
    let dek_hex = current_dek(data_dir, pin, identity)?;
    let dek = data_encoding::HEXLOWER
        .decode(dek_hex.as_bytes())
        .map_err(|_| "bad dek".to_string())?;
    let ct = crate::win_hello::seal(&dek)?;
    let mut file = Vec::with_capacity(6 + ct.len());
    file.extend_from_slice(b"VLTHW");
    file.push(1);
    file.extend_from_slice(&ct);
    let path = hello_wrap_path(data_dir);
    write_atomic(&path, &file)?;
    drop_keychain(identity);
    log("Windows Hello is now a key root; keychain item removed");
    Ok(())
}

/// Unwrap with Hello. If a PIN wrap remains, only the Hello wrap is
/// removed. Otherwise the DEK goes back to the keychain.
#[cfg(windows)]
pub fn hello_clear(data_dir: &Path, identity: &str) -> Result<(), String> {
    let dek = hello_dek(data_dir)?;
    let path = hello_wrap_path(data_dir);
    if pin_locked(data_dir) {
        let _ = std::fs::remove_file(&path);
        log("Windows Hello removed; app-lock PIN remains the key root");
        return Ok(());
    }
    let Some(entry) = keychain_entry(identity) else {
        return Err("keychain-unavailable".to_string());
    };
    entry
        .set_password(&dek)
        .map_err(|e| format!("keychain write failed: {e}"))?;
    let _ = std::fs::remove_file(&path);
    log("Windows Hello removed; DEK back in the keychain");
    Ok(())
}

/// Prompt Hello and migrate any plaintext databases. Returns the raw key
/// for the respawned sidecar env.
#[cfg(windows)]
pub fn hello_unlock(data_dir: &Path, identity: &str) -> Result<String, String> {
    let hex = hello_dek(data_dir)?;
    let report = prepare_all(data_dir, Some(&hex));
    if !report.use_key {
        return Err("prepare-failed".to_string());
    }
    drop_keychain(identity);
    log(&format!(
        "hello unlock: {} migrated, {} already encrypted, {} locked",
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
        // Without the migration marker nothing proves a swap was interrupted:
        // the unreadable file is left alone and the backup kept.
        let p = prepare(&dir, Some(KEY));
        assert_eq!((p.locked, p.migrated), (1, 0));
        assert!(dir.join("acc1").join("dc.db.plain.bak").exists());
        std::fs::write(dir.join("acc1").join("dc.db.migrating"), b"1").unwrap();

        // The marked interrupted swap is rolled back to the plaintext backup and
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

    /// H3: a healthy encrypted db plus a leftover plain.bak must survive a
    /// start with no key or another key (the old branch deleted the live db).
    #[test]
    fn foreign_start_never_replaces_live_db_with_plain_bak() {
        for start in [None, Some(OTHER)] {
            let dir = tmpdir();
            let acc = dir.join("acc1");
            let db = plant_plain_db(&acc, 3);
            std::fs::copy(&db, acc.join("dc.db.plain.bak")).unwrap();
            assert!(migrate(&db, KEY).is_ok());
            // migrate() renamed the plain copy to .plain.bak; re-plant an old one
            std::fs::write(acc.join("dc.db.plain.bak"), b"").unwrap();
            let bak = plant_plain_db(&dir.join("old"), 1);
            std::fs::rename(&bak, acc.join("dc.db.plain.bak")).unwrap();

            let _ = prepare(&dir, start);

            assert_eq!(
                keyed_count(&db, KEY, "SELECT count(*) FROM msgs"),
                3,
                "live encrypted db destroyed (start key {start:?})"
            );
        }
    }

    /// Marker (proof of an unfinished swap) => quarantine, never delete.
    #[test]
    fn marker_rollback_quarantines_instead_of_deleting() {
        let dir = tmpdir();
        let acc = dir.join("acc1");
        let db = plant_plain_db(&acc, 2);
        std::fs::rename(&db, acc.join("dc.db.plain.bak")).unwrap();
        std::fs::write(&db, b"torn garbage not a database").unwrap();
        std::fs::write(acc.join("dc.db.migrating"), b"1").unwrap();

        let _ = prepare(&dir, Some(KEY));

        assert!(std::fs::read_dir(&acc).unwrap().flatten().any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("dc.db.locked-")));
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

    /// A well-formed Hello wrap body: magic + version + 60 wrap bytes.
    #[cfg(windows)]
    fn hello_wrap_bytes(magic: &[u8; 5], ver: u8) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(magic);
        b.push(ver);
        b.resize(66, 0xAB);
        b
    }

    #[cfg(windows)]
    #[test]
    fn hello_wrap_rejects_a_foreign_header() {
        assert!(hello_wrap_ct(&hello_wrap_bytes(b"VLTHW", 1)).is_some());
        assert!(hello_wrap_ct(&hello_wrap_bytes(b"XXXXX", 1)).is_none());
        assert!(hello_wrap_ct(&hello_wrap_bytes(b"VLTHW", 2)).is_none());
        // Wrong length is not a wrap, even with the right magic.
        assert!(hello_wrap_ct(b"VLTHW\x01tiny").is_none());
        assert!(hello_wrap_ct(b"VLTHW").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn hello_availability_probe_does_not_crash() {
        let _on = crate::win_hello::available();
    }

    #[cfg(windows)]
    #[test]
    fn hello_wrap_file_starts_locked_and_pin_clear_keeps_it() {
        let dir = tmpdir();
        std::fs::write(hello_wrap_path(&dir), hello_wrap_bytes(b"VLTHW", 1)).unwrap();
        let (key, issue, locked) = startup(&dir, "test");
        assert!(key.is_none() && issue.is_none() && locked);
        assert!(hello_locked(&dir));

        pin_wrap_write(&pin_wrap_path(&dir), "123456", KEY).unwrap();
        pin_clear(&dir, "123456", "test").unwrap();
        assert!(!pin_wrap_path(&dir).exists());
        assert!(hello_locked(&dir));
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
        std::fs::write(dir.join("accounts.toml"), "acc1").unwrap();
        pin_wrap_write(&pin_wrap_path(&dir), "654321", KEY).unwrap();
        assert!(pin_locked(&dir));

        let raw = pin_unlock(&dir, "654321").unwrap();
        assert_eq!(raw, format!("x'{KEY}'"));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 2);
        assert!(!opens(&db, None));

        // Wrong PIN: retry backoff, data untouched.
        assert!(matches!(
            pin_unlock(&dir, "000000"),
            Err(e) if e.starts_with("retry:")
        ));
        assert!(opens(&db, Some(KEY)));
        assert_eq!(keyed_count(&db, KEY, "SELECT count(*) FROM msgs"), 2);

        // Second unlock: already encrypted, same key back.
        assert_eq!(pin_unlock(&dir, "654321").unwrap(), raw);
    }

    /// #541: shallow layout (`<data>/<uuid>/dc.db`, what the sidecar uses).
    /// A foreign-keyed db must make startup refuse to mint a DEK.
    #[test]
    fn startup_does_not_mint_over_shallow_encrypted_dbs() {
        let dir = tmpdir();
        let db = plant_plain_db(&dir.join("acc1"), 2);
        let p = prepare(&dir, Some(OTHER)); // foreign key encrypts it
        assert_eq!(p.migrated, 1);
        assert!(opens(&db, Some(OTHER)));
        // the old startup looked only here and saw nothing (root cause)
        assert!(!has_encrypted(&dir.join("accounts")));
        let (hex, create, issue, _) = startup_decision(&dir, Lookup::NoEntry, None);
        assert_eq!((hex, create, issue), (None, false, Some(KeyIssue::KeyMissing)));
    }

    #[test]
    fn startup_does_not_mint_over_nested_encrypted_dbs() {
        let dir = tmpdir();
        let root = dir.join("accounts");
        let db = plant_plain_db(&root.join("acc1"), 2);
        prepare(&root, Some(OTHER));
        assert!(opens(&db, Some(OTHER)));
        let (hex, create, issue, _) = startup_decision(&dir, Lookup::NoEntry, None);
        assert_eq!((hex, create, issue), (None, false, Some(KeyIssue::KeyMissing)));
    }

    #[test]
    fn startup_mints_on_truly_fresh_dir() {
        let dir = tmpdir();
        assert_eq!(startup_decision(&dir, Lookup::NoEntry, None), (None, true, None, false));
    }

    /// #527: unlock on a shallow store must migrate/see the real dbs.
    #[test]
    fn pin_unlock_migrates_shallow_layout() {
        let dir = tmpdir();
        let db = plant_plain_db(&dir.join("acc1"), 3);
        std::fs::write(dir.join("accounts.toml"), "acc1").unwrap();
        pin_wrap_write(&pin_wrap_path(&dir), "654321", KEY).unwrap();
        // callers used to pass <data>/accounts, which is empty here
        let raw = pin_unlock(&dir, "654321").unwrap();
        assert_eq!(raw, format!("x'{KEY}'"));
        assert!(opens(&db, Some(KEY)));
    }

    /// Nested layout: root is <data>/accounts, wrap is in <data>.
    #[test]
    fn pin_unlock_migrates_nested_layout() {
        let dir = tmpdir();
        let root = dir.join("accounts");
        let db = plant_plain_db(&root.join("acc1"), 3);
        std::fs::write(root.join("accounts.toml"), "acc1").unwrap();
        pin_wrap_write(&pin_wrap_path(&dir), "654321", KEY).unwrap();
        pin_unlock(&dir, "654321").unwrap();
        assert!(opens(&db, Some(KEY)));
    }

    /// #527: no wrap, no re-key. A keyless plaintext store must stay
    /// plaintext when unlock has nothing durable to stand on.
    #[test]
    fn pin_unlock_without_wrap_never_rekeys() {
        for nested in [false, true] {
            let dir = tmpdir();
            let root = if nested { dir.join("accounts") } else { dir.clone() };
            let db = plant_plain_db(&root.join("acc1"), 2);
            std::fs::write(root.join("accounts.toml"), "acc1").unwrap();
            assert!(pin_unlock(&dir, "654321").is_err());
            assert!(opens(&db, None), "store must stay plaintext (nested={nested})");
        }
    }

    /// A credential store that accepts the write but does not keep it must
    /// not yield a key (the shared-store loss behind #527).
    #[test]
    fn persist_verified_rejects_lost_writes() {
        assert!(!persist_verified(|_| Ok(()), || None, KEY));
        assert!(!persist_verified(|_| Ok(()), || Some(OTHER.to_string()), KEY));
        assert!(!persist_verified(|_| Err("denied".into()), || Some(KEY.to_string()), KEY));
        assert!(persist_verified(|_| Ok(()), || Some(KEY.to_string()), KEY));
    }

    /// An attempt must never rewrite the file that holds the only key wrap:
    /// a crash mid-write would leave the profile keyless.
    #[test]
    fn wrong_attempt_never_rewrites_the_wrap() {
        let dir = tmpdir();
        let wrap = pin_wrap_path(&dir);
        pin_wrap_write(&wrap, "123456", KEY).unwrap();
        let before = std::fs::read(&wrap).unwrap();
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 1, .. }));
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 2, .. }));
        assert_eq!(std::fs::read(&wrap).unwrap(), before, "wrap bytes changed on a wrong attempt");
        assert!(matches!(pin_wrap_open(&wrap, "123456"), PinOpen::Dek(d) if d == KEY));
        assert_eq!(std::fs::read(&wrap).unwrap(), before, "wrap bytes changed on a right attempt");
    }

    /// A torn/garbage counter file costs at most the counter, never the key.
    #[test]
    fn torn_counter_file_does_not_lose_the_key() {
        let dir = tmpdir();
        let wrap = pin_wrap_path(&dir);
        pin_wrap_write(&wrap, "123456", KEY).unwrap();
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 1, .. }));
        std::fs::write(pin_counter_path(&wrap), b"\x01").unwrap(); // torn
        assert!(matches!(pin_wrap_open(&wrap, "123456"), PinOpen::Dek(d) if d == KEY));
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 1, .. }));
    }

    /// A legacy wrap with a non-zero in-header counter keeps backing off,
    /// and re-wrapping (PIN change) starts from zero.
    #[test]
    fn legacy_header_counter_is_honoured_and_rewrap_resets() {
        let dir = tmpdir();
        let wrap = pin_wrap_path(&dir);
        pin_wrap_write(&wrap, "123456", KEY).unwrap();
        let mut b = std::fs::read(&wrap).unwrap();
        b[6..10].copy_from_slice(&3u32.to_le_bytes());
        std::fs::write(&wrap, &b).unwrap();
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 4, .. }));
        pin_wrap_write(&wrap, "654321", KEY).unwrap();
        assert!(matches!(pin_wrap_open(&wrap, "000000"), PinOpen::Wrong { attempts: 1, .. }));
    }

    #[test]
    fn wrap_write_is_atomic_and_replaces() {
        let dir = tmpdir();
        let wrap = pin_wrap_path(&dir);
        pin_wrap_write(&wrap, "123456", KEY).unwrap();
        pin_wrap_write(&wrap, "654321", OTHER).unwrap();
        assert!(!wrap.with_file_name("dbkey.wrap.tmp").exists());
        assert!(matches!(pin_wrap_open(&wrap, "654321"), PinOpen::Dek(d) if d == OTHER));
    }

    /// (b) prepare_all only encrypts dbs the core's accounts.toml names, at
    /// a root that has one: a stray dc.db, an unlisted dir and a nested
    /// tree under a shallow root stay untouched.
    #[test]
    fn prepare_all_touches_only_listed_core_accounts() {
        let dir = tmpdir();
        let mine = plant_plain_db(&dir.join("uuid-mine"), 1);
        let stray = plant_plain_db(&dir.join("p2p-blobs"), 1);
        let nested = plant_plain_db(&dir.join("accounts").join("uuid-n"), 1); // no toml at that level
        std::fs::write(dir.join("accounts.toml"), "uuid-mine").unwrap();
        let p = prepare_all(&dir, Some(KEY));
        assert_eq!(p.migrated, 1);
        assert!(opens(&mine, Some(KEY)));
        assert!(opens(&stray, None), "unlisted dir untouched");
        assert!(opens(&nested, None), "nested tree without its own toml untouched");
    }

    #[cfg(target_os = "android")]
    #[test]
    fn install_env_is_the_process_writer() {
        install_env("x'deadbeef'");
        assert_eq!(std::env::var("VELTA_DB_KEY").ok().as_deref(), Some("x'deadbeef'"));
    }
}
