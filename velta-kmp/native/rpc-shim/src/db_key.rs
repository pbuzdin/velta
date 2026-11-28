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
    /// Databases re-keyed from the pre-fix key string this run.
    pub rekeyed: usize,
    /// Run the core with this key instead of the one passed in: some database
    /// could not be re-keyed yet and still only opens with the legacy key.
    /// Attachments stay under the same key, so nothing is stranded.
    pub key_override: Option<String>,
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

/// Opens `path`, keyed with `key_hex` when given.
fn open_with(path: &Path, key_hex: Option<&str>) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open failed: {e}"))?;
    if let Some(k) = key_hex {
        conn.pragma_update(None, "key", format!("x'{k}'"))
            .map_err(|e| format!("key failed: {e}"))?;
    }
    Ok(conn)
}

/// One-time plaintext → SQLCipher migration with rollback (plan §3.2).
fn migrate(db: &Path, key_hex: &str) -> Result<(), String> {
    convert(db, None, key_hex, "plain.bak", "migrating")
}

/// Re-key an encrypted database from `old_hex` to `key_hex` the same way:
/// export into a new file, verify, swap, keep the old file as `oldkey.bak`.
fn rekey(db: &Path, old_hex: &str, key_hex: &str) -> Result<(), String> {
    convert(db, Some(old_hex), key_hex, "oldkey.bak", "rekeying")
}

/// Export `db` (opened with `src_key`, plaintext when None) into a copy
/// under `key_hex`, verify it, and swap it in; the source stays as
/// `bak_suffix` until a later start proves the new file holds the same data.
fn convert(
    db: &Path,
    src_key: Option<&str>,
    key_hex: &str,
    bak_suffix: &str,
    marker_suffix: &str,
) -> Result<(), String> {
    let key = format!("x'{key_hex}'");
    let enc = sibling(db, "enc");
    let _ = fs::remove_file(&enc);

    let run = || -> Result<(), String> {
        let plain = open_with(db, src_key)?;
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
            let plain_n = count(&open_with(db, src_key)?, table)?;
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

    let marker = sibling(db, marker_suffix);
    if let Err(e) = fs::write(&marker, b"1").and_then(|()| sync_file(&marker)) {
        let _ = fs::remove_file(&enc);
        return Err(format!("marker write failed: {e}"));
    }
    let bak = sibling(db, bak_suffix);
    let swapped = fs::rename(db, &bak).is_ok()
        && match fs::rename(&enc, db) {
            Ok(()) => true,
            Err(e) => {
                crate::log(&format!("second rename failed, restoring backup: {e}"));
                let _ = fs::rename(&bak, db);
                false
            }
        };
    sync_dir(dir);
    if !swapped {
        let _ = fs::remove_file(&enc);
        let _ = fs::remove_file(&marker);
        return Err("swap failed".to_string());
    }
    let _ = fs::remove_file(&marker);
    let _ = fs::remove_file(sibling(db, "wal"));
    let _ = fs::remove_file(sibling(db, "shm"));
    Ok(())
}

/// Before the migration backup is deleted: the encrypted live database
/// must hold the SAME data as the backup, never a fresh db created over a
/// lost file. Row counts may only grow (core ran since), keypairs must
/// match exactly, and the identity must be the same.
fn bak_superseded(db: &Path, bak: &Path, bak_key: Option<&str>, key_hex: &str) -> Result<(), String> {
    let plain = open_with(bak, bak_key)?;
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

/// Interrupted-migration rollback, only reached with the marker present.
/// The unreadable live file is quarantined, never deleted; errors surface.
fn rollback_unfinished(db: &Path, bak: &Path, marker: &Path) -> Result<(), String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let locked = sibling(db, &format!("locked-{ts}"));
    fs::rename(db, &locked).map_err(|e| format!("quarantine: {e}"))?;
    if let Err(e) = fs::rename(bak, db) {
        let _ = fs::rename(&locked, db);
        return Err(format!("restore backup: {e}"));
    }
    let _ = fs::remove_file(marker);
    crate::log(&format!("rolled back unfinished migration; live db kept as {}", locked.display()));
    Ok(())
}

fn account_dbs(accounts_root: &Path) -> Vec<PathBuf> {
    match fs::read_dir(accounts_root) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path().join("dc.db"))
            .filter(|db| {
                db.is_file() || sibling(db, "plain.bak").is_file() || sibling(db, "oldkey.bak").is_file()
            })
            .collect(),
        Err(e) => {
            crate::log(&format!("cannot read {}: {e}", accounts_root.display()));
            Vec::new()
        }
    }
}

/// Android builds before the hex fix wrote the DEK as a key string that
/// repeated each byte's high nibble (`b >> 4` twice), so existing profiles
/// are keyed with that string, not with the DEK's real hex. Derive it from
/// the real key. None when it is the same string (a key that is its own
/// legacy form: a wrap written by those builds, or any all-`0x11`-style key).
pub fn legacy_key(new_hex: &str) -> Option<String> {
    let hex = new_hex.to_ascii_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let old: String = hex
        .as_bytes()
        .chunks(2)
        .flat_map(|pair| [pair[0] as char, pair[0] as char])
        .collect();
    (old != hex).then_some(old)
}

/// Re-key every account database that only opens with the legacy key.
/// Returns (databases re-keyed, any database still only on the legacy key).
/// A database that opens with neither key is never touched.
fn rekey_pass(accounts_root: &Path, old_hex: &str, new_hex: &str) -> (usize, bool) {
    let (mut done, mut pending) = (0, false);
    for db in account_dbs(accounts_root) {
        let bak = sibling(&db, "oldkey.bak");
        let marker = sibling(&db, "rekeying");

        // Crash between the two swap renames: dc.db gone, old copy present.
        if !db.exists() && bak.exists() && opens(&bak, Some(old_hex)) {
            crate::log(&format!("restoring pre-rekey copy over missing {}", db.display()));
            if let Err(e) = fs::rename(&bak, &db) {
                crate::log(&format!("restore failed for {}: {e}", db.display()));
                pending = true;
                continue;
            }
        }
        if !db.is_file() {
            continue;
        }
        // Marker = a swap may have been interrupted. Either key opening the
        // live file means it is whole; only a live file that opens with
        // neither is moved aside (never deleted) for the old copy.
        if marker.exists() {
            if opens(&db, Some(new_hex)) || opens(&db, Some(old_hex)) {
                let _ = fs::remove_file(&marker);
            } else if bak.exists() && opens(&bak, Some(old_hex)) {
                if let Err(e) = rollback_unfinished(&db, &bak, &marker) {
                    crate::log(&format!("rekey rollback FAILED for {}: {e}", db.display()));
                    continue;
                }
            }
        }
        if opens(&db, Some(new_hex)) {
            if bak.exists() {
                match bak_superseded(&db, &bak, Some(old_hex), new_hex) {
                    Ok(()) => {
                        let _ = fs::remove_file(&bak);
                    }
                    Err(e) => crate::log(&format!("KEEPING backup {}: {e}", bak.display())),
                }
            }
        } else if opens(&db, Some(old_hex)) {
            match rekey(&db, old_hex, new_hex) {
                Ok(()) => {
                    done += 1;
                    crate::log(&format!("re-keyed {}", db.display()));
                }
                Err(e) => {
                    pending = true;
                    crate::log(&format!("REKEY FAILED for {} (keeps the old key): {e}", db.display()));
                }
            }
        }
    }
    (done, pending)
}

const BLOBS_DONE: &str = ".velta-dek-v2";

/// Re-encrypt one blob from the legacy attachment key to the new one.
/// Ok(true) = rewritten, Ok(false) = nothing to do (plain, already new, or
/// opens with neither key: left alone).
fn reencrypt_blob(
    path: &Path,
    old: &velta_attachment::AttachmentKey,
    new: &velta_attachment::AttachmentKey,
) -> Result<bool, String> {
    if !velta_attachment::is_encrypted(path).map_err(|e| e.to_string())? {
        return Ok(false);
    }
    if velta_attachment::AttachmentReader::open(path, Some(new)).is_ok() {
        return Ok(false);
    }
    let Ok(mut reader) = velta_attachment::AttachmentReader::open(path, Some(old)) else {
        return Ok(false);
    };
    let len = reader.len();
    let tmp = sibling(path, "rekey.tmp");
    let _ = fs::remove_file(&tmp);
    let mut write = || -> Result<(), String> {
        let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        velta_attachment::encrypt(new, &mut reader, len, &mut out).map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        let check = velta_attachment::AttachmentReader::open(&tmp, Some(new)).map_err(|e| e.to_string())?;
        if check.len() != len {
            return Err("length differs after re-encrypt".to_string());
        }
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(reader);
    // Windows cannot rename over an existing file; the finished copy stays
    // as `.rekey.tmp` and is picked up by the next pass if we die in between.
    #[cfg(windows)]
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).map_err(|e| format!("swap failed: {e}"))?;
    Ok(true)
}

fn blob_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => blob_files(&p, out),
            Ok(t) if t.is_file() => out.push(p),
            _ => {}
        }
    }
}

/// Move attachments (account blobdirs and Loop's stored media) from the
/// legacy attachment key to the new one. Per file: write a new file, verify
/// it opens under the new key, rename over the original; a crash leaves
/// each file readable with exactly one of the two keys, and the next pass
/// finishes the rest. Accounts whose database does not open with the new
/// key are skipped. Returns whether everything was handled, which lets the
/// caller drop a done-marker so later starts skip the scan.
fn reencrypt_blobs(accounts_root: &Path, old_hex: &str, new_hex: &str) -> bool {
    let done = accounts_root.join(BLOBS_DONE);
    if done.exists() {
        return true;
    }
    let keys = (
        velta_attachment::AttachmentKey::from_db_key(&format!("x'{old_hex}'")),
        velta_attachment::AttachmentKey::from_db_key(&format!("x'{new_hex}'")),
    );
    let (Ok(Some(old)), Ok(Some(new))) = keys else { return false };
    let mut roots = vec![accounts_root.join("p2p-blobs")];
    let mut complete = true;
    if let Ok(entries) = fs::read_dir(accounts_root) {
        for e in entries.flatten() {
            let account = e.path();
            let db = account.join("dc.db");
            if db.is_file() {
                if opens(&db, Some(new_hex)) {
                    roots.push(account.join("dc.db-blobs"));
                } else {
                    complete = false;
                }
            }
        }
    }
    let mut files = Vec::new();
    for r in &roots {
        blob_files(r, &mut files);
    }
    let mut rewritten = 0;
    for f in &files {
        let name = f.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if let Some(orig_name) = name.strip_suffix(".rekey.tmp") {
            // Leftover of an interrupted pass: keep it only when it is a
            // complete new-key copy and the original is gone (Windows swap).
            let orig = f.with_file_name(orig_name);
            if !orig.exists()
                && velta_attachment::AttachmentReader::open(f, Some(&new)).is_ok()
                && fs::rename(f, &orig).is_ok()
            {
                continue;
            }
            let _ = fs::remove_file(f);
            continue;
        }
        match reencrypt_blob(f, &old, &new) {
            Ok(true) => rewritten += 1,
            Ok(false) => {}
            Err(e) => {
                complete = false;
                crate::log(&format!("attachment re-key failed for {}: {e}", f.display()));
            }
        }
    }
    crate::log(&format!("attachments re-keyed: {rewritten} of {}", files.len()));
    if complete {
        let _ = fs::write(&done, b"1");
    }
    complete
}

/// Scan, migrate and decide whether the core may get the key. Called once
/// per start, before the worker exists (shell `prepare` parity).
pub fn prepare(accounts_root: &Path, key_hex: Option<&str>) -> Prepare {
    let mut rekeyed = 0;
    let mut key_override = None;
    if let Some(new) = key_hex {
        if let Some(old) = legacy_key(new) {
            let (n, pending) = rekey_pass(accounts_root, &old, new);
            rekeyed = n;
            if pending {
                // Something still only opens with the legacy key: keep the
                // whole session (databases and attachments) on it.
                key_override = Some(old);
            } else {
                reencrypt_blobs(accounts_root, &old, new);
            }
        }
    }
    let mut state = prepare_inner(accounts_root, key_override.as_deref().or(key_hex));
    state.rekeyed = rekeyed;
    state.key_override = key_override;
    state
}

fn prepare_inner(accounts_root: &Path, key_hex: Option<&str>) -> Prepare {
    let mut state = Prepare {
        use_key: false,
        migrated: 0,
        already: 0,
        locked: 0,
        rekeyed: 0,
        key_override: None,
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
                    let _ = fs::remove_file(sibling(db, "migrating"));
                    // The encrypted copy opens with the key. Drop the
                    // migration backup only once it is proven to hold the
                    // same data (never a fresh db over a lost file).
                    let bak = sibling(db, "plain.bak");
                    if bak.exists() {
                        match key_hex.map(|k| bak_superseded(db, &bak, None, k)) {
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
                    // Foreign = "did not open with THIS key". That includes a
                    // healthy encrypted db when the key is missing or another
                    // one. Never replace it with the plaintext backup. The
                    // only proof of an interrupted migration is the marker
                    // `dc.db.migrating`; even then the live file is moved
                    // aside (`.locked-<ts>`), never deleted.
                    let bak = sibling(db, "plain.bak");
                    let marker = sibling(db, "migrating");
                    if marker.exists() && bak.exists() && opens(&bak, None) {
                        match rollback_unfinished(db, &bak, &marker) {
                            Ok(()) => true,
                            Err(e) => {
                                crate::log(&format!("rollback FAILED for {}: {e}", db.display()));
                                state.locked += 1;
                                false
                            }
                        }
                    } else {
                        if bak.exists() {
                            crate::log(&format!(
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

/// The one place the DEK format is decided. Accepts the bare 64-hex form
/// (Android shell) or the raw SQLCipher `x'<hex>'` form (desktop shell) and
/// returns lower-case bare hex, or None when it is not a 256-bit key.
pub fn canonical_dek(s: &str) -> Option<String> {
    let s = s.trim();
    let hex = s
        .strip_prefix("x'")
        .or_else(|| s.strip_prefix("X'"))
        .and_then(|r| r.strip_suffix('\''))
        .unwrap_or(s);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// The value the core gets in `VELTA_DB_KEY`: always `x'<hex>'`, the only
/// form the core treats as a raw key and `AttachmentKey::from_db_key` accepts.
pub fn core_env_key(hex: &str) -> String {
    format!("x'{hex}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210";
    const OTHER: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0f0e1d2c3b4a5968778695a4b3c2d1e0f";

    fn root(tag: &str) -> PathBuf {
        let r = std::env::temp_dir().join(format!(
            "velta-shim-rekey-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&r).unwrap();
        r
    }

    fn make_db(db: &Path, key: &str, with_tables: bool) {
        fs::create_dir_all(db.parent().unwrap()).unwrap();
        let c = Connection::open(db).unwrap();
        c.pragma_update(None, "key", format!("x'{key}'")).unwrap();
        let schema = if with_tables {
            "CREATE TABLE msgs (id INTEGER PRIMARY KEY, txt TEXT);
             CREATE TABLE chats (id INTEGER PRIMARY KEY);
             CREATE TABLE contacts (id INTEGER PRIMARY KEY);
             CREATE TABLE config (keyname TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE keypairs (id INTEGER PRIMARY KEY);
             INSERT INTO msgs (txt) VALUES ('hello'), ('loop');
             INSERT INTO config (keyname, value) VALUES ('addr', 'a@example.org');"
        } else {
            "CREATE TABLE other (x TEXT); INSERT INTO other VALUES ('x');"
        };
        c.execute_batch(schema).unwrap();
    }

    fn msgs(db: &Path, key: &str) -> Option<i64> {
        let c = Connection::open(db).ok()?;
        c.pragma_update(None, "key", format!("x'{key}'")).ok()?;
        c.query_row("SELECT count(*) FROM msgs", [], |r| r.get(0)).ok()
    }

    fn akey(hex: &str) -> velta_attachment::AttachmentKey {
        velta_attachment::AttachmentKey::from_db_key(&format!("x'{hex}'")).unwrap().unwrap()
    }

    fn put_blob(path: &Path, hex: &str, data: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        velta_attachment::encrypt(&akey(hex), &mut &data[..], data.len() as u64, &mut f).unwrap();
    }

    fn blob_reads(path: &Path, hex: &str) -> Option<Vec<u8>> {
        velta_attachment::AttachmentReader::open(path, Some(&akey(hex))).ok()?.read_all().ok()
    }

    fn old_of(new: &str) -> String {
        legacy_key(new).expect("differs")
    }

    #[test]
    fn legacy_key_repeats_the_high_nibble() {
        let old = old_of(NEW);
        assert_eq!(old.len(), 64);
        assert_eq!(&old[..8], "00224466");
        assert_eq!(&old[8..16], "88aaccee");
        assert_ne!(old, NEW);
        // A key that already has equal nibbles in every byte is its own legacy form.
        assert_eq!(legacy_key(&"11".repeat(32)), None);
        assert_eq!(legacy_key("nothex"), None);
    }

    #[test]
    fn old_key_profile_moves_to_the_new_key_with_its_attachments() {
        let r = root("full");
        let old = old_of(NEW);
        make_db(&r.join("1/dc.db"), &old, true);
        put_blob(&r.join("1/dc.db-blobs/a.bin"), &old, b"photo bytes");
        put_blob(&r.join("1/dc.db-blobs/sub/b.bin"), &old, &vec![7u8; 200_000]);
        put_blob(&r.join("p2p-blobs/peer/c.bin"), &old, b"loop media");
        fs::write(r.join("1/dc.db-blobs/plain.txt"), b"legacy plaintext").unwrap();

        let first = prepare(&r, Some(NEW));
        assert_eq!(first.rekeyed, 1);
        assert!(first.use_key);
        assert_eq!(first.key_override, None);
        assert_eq!(msgs(&r.join("1/dc.db"), NEW), Some(2));
        assert_eq!(msgs(&r.join("1/dc.db"), &old), None, "old key no longer opens it");
        assert_eq!(blob_reads(&r.join("1/dc.db-blobs/a.bin"), NEW).unwrap(), b"photo bytes");
        assert_eq!(blob_reads(&r.join("1/dc.db-blobs/sub/b.bin"), NEW).unwrap(), vec![7u8; 200_000]);
        assert_eq!(blob_reads(&r.join("p2p-blobs/peer/c.bin"), NEW).unwrap(), b"loop media");
        assert!(blob_reads(&r.join("1/dc.db-blobs/a.bin"), &old).is_none());
        assert_eq!(fs::read(r.join("1/dc.db-blobs/plain.txt")).unwrap(), b"legacy plaintext");
        assert!(r.join("1/dc.db.oldkey.bak").exists(), "old copy kept until the next start verifies");
        assert!(r.join(BLOBS_DONE).exists());

        let second = prepare(&r, Some(NEW));
        assert_eq!(second.rekeyed, 0);
        assert_eq!(second.already, 1);
        assert!(!r.join("1/dc.db.oldkey.bak").exists(), "backup dropped once the new file is proven");
        fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn crash_between_steps_leaves_a_database_that_opens_with_one_key() {
        let old = old_of(NEW);

        // (a) stopped after the marker, before the swap: live file still old.
        let r = root("crash-a");
        make_db(&r.join("1/dc.db"), &old, true);
        fs::write(r.join("1/dc.db.rekeying"), b"1").unwrap();
        fs::write(r.join("1/dc.db.enc"), b"half written garbage").unwrap();
        assert_eq!(msgs(&r.join("1/dc.db"), &old), Some(2));
        let p = prepare(&r, Some(NEW));
        assert_eq!(p.rekeyed, 1);
        assert_eq!(msgs(&r.join("1/dc.db"), NEW), Some(2));
        assert!(!r.join("1/dc.db.rekeying").exists());
        fs::remove_dir_all(&r).ok();

        // (b) stopped between the two renames: dc.db gone, old copy present.
        let r = root("crash-b");
        make_db(&r.join("1/dc.db.oldkey.bak"), &old, true);
        fs::write(r.join("1/dc.db.rekeying"), b"1").unwrap();
        make_db(&r.join("1/dc.db.enc"), NEW, true);
        let p = prepare(&r, Some(NEW));
        assert_eq!(p.rekeyed, 1);
        assert_eq!(msgs(&r.join("1/dc.db"), NEW), Some(2));
        fs::remove_dir_all(&r).ok();

        // (c) stopped after the swap, marker still there: the new file is live.
        let r = root("crash-c");
        make_db(&r.join("1/dc.db"), NEW, true);
        make_db(&r.join("1/dc.db.oldkey.bak"), &old, true);
        fs::write(r.join("1/dc.db.rekeying"), b"1").unwrap();
        let p = prepare(&r, Some(NEW));
        assert_eq!(p.rekeyed, 0);
        assert_eq!(msgs(&r.join("1/dc.db"), NEW), Some(2));
        assert!(!r.join("1/dc.db.rekeying").exists());
        assert!(!r.join("1/dc.db.oldkey.bak").exists());
        fs::remove_dir_all(&r).ok();

        // (d) attachments: some already new, one half-written temp, rest old.
        let r = root("crash-d");
        make_db(&r.join("1/dc.db"), NEW, true);
        put_blob(&r.join("1/dc.db-blobs/done.bin"), NEW, b"already new");
        put_blob(&r.join("1/dc.db-blobs/todo.bin"), &old, b"still old");
        fs::write(r.join("1/dc.db-blobs/todo.bin.rekey.tmp"), b"VLTAgarbage").unwrap();
        prepare(&r, Some(NEW));
        assert_eq!(blob_reads(&r.join("1/dc.db-blobs/done.bin"), NEW).unwrap(), b"already new");
        assert_eq!(blob_reads(&r.join("1/dc.db-blobs/todo.bin"), NEW).unwrap(), b"still old");
        assert!(!r.join("1/dc.db-blobs/todo.bin.rekey.tmp").exists());
        fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn a_database_that_opens_with_neither_key_is_never_touched() {
        let r = root("neither");
        make_db(&r.join("1/dc.db"), OTHER, true);
        put_blob(&r.join("1/dc.db-blobs/x.bin"), OTHER, b"foreign");
        let before = fs::read(r.join("1/dc.db")).unwrap();
        let blob_before = fs::read(r.join("1/dc.db-blobs/x.bin")).unwrap();
        let p = prepare(&r, Some(NEW));
        assert_eq!(p.rekeyed, 0);
        assert_eq!(p.locked, 1);
        assert_eq!(fs::read(r.join("1/dc.db")).unwrap(), before);
        assert_eq!(fs::read(r.join("1/dc.db-blobs/x.bin")).unwrap(), blob_before);
        assert!(!r.join("1/dc.db.oldkey.bak").exists());
        assert!(!r.join(BLOBS_DONE).exists(), "nothing was proven, so the scan repeats later");
        fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn a_failed_rekey_keeps_the_session_on_the_old_key() {
        let r = root("fail");
        let old = old_of(NEW);
        // No msgs/chats/... tables: the verification of the export fails.
        make_db(&r.join("1/dc.db"), &old, false);
        put_blob(&r.join("1/dc.db-blobs/a.bin"), &old, b"keep me readable");
        let p = prepare(&r, Some(NEW));
        assert_eq!(p.rekeyed, 0);
        assert_eq!(p.key_override.as_deref(), Some(old.as_str()));
        assert!(p.use_key);
        let c = Connection::open(r.join("1/dc.db")).unwrap();
        c.pragma_update(None, "key", format!("x'{old}'")).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM other", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "database untouched");
        assert_eq!(blob_reads(&r.join("1/dc.db-blobs/a.bin"), &old).unwrap(), b"keep me readable");
        assert!(!r.join(BLOBS_DONE).exists());
        fs::remove_dir_all(&r).ok();
    }
}
