//! Plaintext → SQLCipher database migration (#259 step 2).
//!
//! Port of `velta-app/src-tauri/src/db_key.rs` (classify/migrate/prepare).
//! Core patch #20 opens accounts with `VELTA_DB_KEY` and never falls back,
//! so a profile created by a pre-#20 build (plaintext `dc.db`) upgrades to
//! a DEK-shipping build and stays closed forever unless the plaintext
//! database is converted first. Same recipe as the shell: checkpoint,
//! `sqlcipher_export` into `dc.db.enc`, verify (integrity, user_version,
//! row counts), swap with the plaintext bytes kept in `dc.db.plain.bak`
//! until the NEXT startup proves the encrypted copy holds the same data.
//! Any failure leaves the plaintext database in place.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// Tables whose row counts must survive the export (shell parity).
const COUNT_TABLES: [&str; 5] = ["msgs", "chats", "contacts", "config", "keypairs"];

pub struct Prepare {
    /// Pass the key to the core this session.
    pub use_key: bool,
    /// Plaintext databases converted this run.
    pub migrated: usize,
    /// Already encrypted with our key.
    pub already: usize,
    /// Unreadable even with our key (stays locked this session).
    pub locked: usize,
}

fn sibling(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    db.with_file_name(name)
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

enum Kind {
    Plain,
    Ours,
    Foreign,
}

fn count(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| format!("{table}: {e}"))
}

fn sync_file(path: &Path) -> std::io::Result<()> {
    // Windows: FlushFileBuffers refuses read-only handles; Android is unix.
    fs::OpenOptions::new().write(true).open(path)?.sync_all()
}

fn sync_dir(dir: &Path) {
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

/// One-time plaintext → SQLCipher migration with rollback (plan §3.2).
fn migrate(db: &Path, key_hex: &str) -> Result<(), String> {
    let key = format!("x'{key_hex}'");
    let enc = sibling(db, "enc");
    let _ = fs::remove_file(&enc);

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
            let plain_n = count(&Connection::open(db).map_err(|e| e.to_string())?, table)?;
            let enc_n = count(&v, table)?;
            if plain_n != enc_n {
                return Err(format!("row count mismatch on {table}: {plain_n} vs {enc_n}"));
            }
        }
        drop(v);
        Ok(())
    };

    if let Err(e) = run().and_then(|()| sync_file(&enc).map_err(|e| format!("fsync enc failed: {e}"))) {
        let _ = fs::remove_file(&enc);
        return Err(e);
    }
    let dir = db.parent().unwrap_or(Path::new("."));

    let swapped = fs::rename(db, sibling(db, "plain.bak")).is_ok()
        && match fs::rename(&enc, db) {
            Ok(()) => true,
            Err(e) => {
                crate::log(&format!("second rename failed, restoring backup: {e}"));
                let _ = fs::rename(sibling(db, "plain.bak"), db);
                false
            }
        };
    sync_dir(dir);
    if !swapped {
        let _ = fs::remove_file(&enc);
        return Err("swap failed".to_string());
    }
    let _ = fs::remove_file(sibling(db, "wal"));
    let _ = fs::remove_file(sibling(db, "shm"));
    Ok(())
}

/// Before the migration backup is deleted: the encrypted live database
/// must hold the SAME data as the backup, never a fresh db created over a
/// lost file. Row counts may only grow (core ran since), keypairs must
/// match exactly, and the identity must be the same.
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

fn account_dbs(accounts_root: &Path) -> Vec<PathBuf> {
    match fs::read_dir(accounts_root) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path().join("dc.db"))
            .filter(|db| db.is_file() || sibling(db, "plain.bak").is_file())
            .collect(),
        Err(e) => {
            crate::log(&format!("cannot read {}: {e}", accounts_root.display()));
            Vec::new()
        }
    }
}

/// Scan, migrate and decide whether the core may get the key. Called once
/// per start, before the worker exists (shell `prepare` parity).
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
            crate::log(&format!(
                "restoring plaintext backup over missing {}",
                db.display()
            ));
            if let Err(e) = fs::rename(&bak, db) {
                crate::log(&format!("restore failed for {}: {e}", db.display()));
            }
        }
    }
    dbs.retain(|db| db.is_file());

    // Classify (and migrate) each database. A `true` result means "restore
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
                            crate::log(&format!("migrated {}", db.display()));
                        }
                        Err(e) => {
                            failed += 1;
                            crate::log(&format!("MIGRATION FAILED for {}: {e}", db.display()));
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
                                let _ = fs::remove_file(&bak);
                            }
                            Some(Err(e)) => crate::log(&format!("KEEPING backup {}: {e}", bak.display())),
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
                        crate::log(&format!(
                            "restoring plaintext backup over unreadable {}",
                            db.display()
                        ));
                        let _ = fs::remove_file(db);
                        let _ = fs::rename(&bak, db);
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
