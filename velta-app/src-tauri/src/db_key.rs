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

/// The install DEK as 64 hex chars: loaded from the keychain, or generated
/// and stored. `None` = keychain unavailable or unreadable — the session
/// runs unencrypted (or locked, if encrypted databases exist); we never
/// fall back to a key file next to the database, which would add nothing.
#[cfg(not(target_os = "android"))]
fn load_or_create_dek() -> Option<String> {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER) {
        Ok(e) => e,
        Err(e) => {
            log(&format!("keychain unavailable: {e}"));
            return None;
        }
    };
    match entry.get_password() {
        Ok(hex) if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) => Some(hex),
        Ok(_) => {
            // A mangled item is not recoverable and must not be overwritten
            // silently: the databases it may have encrypted stay locked.
            log("keychain item is corrupt; treating as missing");
            None
        }
        Err(keyring::Error::NoEntry) => {
            let bytes = crate::random_bytes::<32>();
            let hex: String = data_encoding::HEXLOWER.encode(&bytes);
            if let Err(e) = entry.set_password(&hex) {
                log(&format!("keychain write failed: {e}"));
                return None;
            }
            log("generated a new database key");
            Some(hex)
        }
        Err(e) => {
            log(&format!("keychain read failed: {e}"));
            None
        }
    }
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

    if let Err(e) = run() {
        let _ = std::fs::remove_file(&enc);
        return Err(e);
    }

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

    let mut dbs: Vec<PathBuf> = match std::fs::read_dir(accounts_root) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path().join("dc.db"))
            .filter(|db| db.is_file())
            .collect(),
        Err(e) => {
            log(&format!("cannot read {}: {e}", accounts_root.display()));
            Vec::new()
        }
    };

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
                    // The encrypted copy opens with the key: any leftover
                    // backup from the migration that produced it is
                    // verified — drop it.
                    let _ = std::fs::remove_file(sibling(db, "plain.bak"));
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
/// session without encryption.
#[cfg(not(target_os = "android"))]
pub fn startup(accounts_data_dir: &Path) -> Option<String> {
    let t0 = Instant::now();
    let hex = load_or_create_dek();
    let report = prepare(&accounts_data_dir.join("accounts"), hex.as_deref());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const OTHER: &str = "ff112233445566778899aabbccddeeff00112233445566778899aabbccddeeffee";

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
             CREATE TABLE config (id INTEGER PRIMARY KEY, name TEXT);
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
    fn sibling_naming_matches_plan() {
        let db = Path::new("/x/accounts/uuid/dc.db");
        assert_eq!(sibling(db, "enc"), PathBuf::from("/x/accounts/uuid/dc.db.enc"));
        assert_eq!(
            sibling(db, "plain.bak"),
            PathBuf::from("/x/accounts/uuid/dc.db.plain.bak")
        );
    }
}
