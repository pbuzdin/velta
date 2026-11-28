//! At-rest protection for the Loop engine's own files in `<AppLocalData>/p2p/`:
//! `identity.key`, `profile.json`, `peers.json`, `groups.json` and the
//! `messages-*.jsonl` logs.
//!
//! With a DEK (attachment key) every file is sealed: the small files are
//! whole-file VLTA (like `xfer.rs`'s identity key), a log is an append-only
//! sequence of sealed records. Without a DEK the files stay plaintext as
//! before (keyless session), but are still created owner-only and written
//! atomically.
//!
//! Callers pass paths; the key is looked up by the file's directory, set by
//! [`begin`] when an engine starts and replaced by [`lock`] when it stops.
//! After `lock` nothing is read or written there until the next `begin`, so a
//! late task of a stopped engine can neither leak plaintext nor create a new
//! identity next to the sealed one.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context as _, Result};
use velta_attachment::{AttachmentKey, AttachmentReader};

/// First bytes of a sealed log (plaintext logs start with `{`).
const LOG_MAGIC: &[u8; 5] = b"VLTG\x01";

enum Mode {
    Keyed(AttachmentKey),
    Locked,
}

static MODES: Mutex<Option<HashMap<PathBuf, Mode>>> = Mutex::new(None);

fn with_modes<T>(f: impl FnOnce(&mut HashMap<PathBuf, Mode>) -> T) -> T {
    let mut g = MODES.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

fn dir_of(path: &Path) -> PathBuf {
    path.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// What a read/write of a file in this directory must do.
enum Access {
    Plain,
    Sealed(AttachmentKey),
    Locked,
}

fn access(path: &Path) -> Access {
    with_modes(|m| match m.get(&dir_of(path)) {
        None => Access::Plain,
        Some(Mode::Keyed(k)) => Access::Sealed(k.clone()),
        Some(Mode::Locked) => Access::Locked,
    })
}

fn is_sealed_file(path: &Path) -> bool {
    velta_attachment::is_encrypted(path).unwrap_or(false) || is_sealed_log(path)
}

fn is_sealed_log(path: &Path) -> bool {
    let mut head = [0u8; 5];
    std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head))
        .map(|_| &head == LOG_MAGIC)
        .unwrap_or(false)
}

fn is_state_file(name: &str) -> bool {
    matches!(name, "identity.key" | "profile.json" | "peers.json" | "groups.json" | "groups.json.corrupt")
        || (name.starts_with("messages-") && name.ends_with(".jsonl"))
}

fn state_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(is_state_file))
        .map(|e| e.path())
        .collect()
}

/// Whether `dir` holds sealed Loop state (it needs a key to be opened).
pub fn has_sealed_state(dir: &Path) -> bool {
    state_files(dir).iter().any(|p| is_sealed_file(p))
}

/// Starts a session on `dir`. With a key: seals every plaintext state file
/// (atomic replace, nothing plaintext left behind). Without one: refuses when
/// sealed state exists (locked store; never mint a fresh identity over it).
pub fn begin(dir: &Path, key: Option<AttachmentKey>) -> Result<()> {
    match key {
        Some(key) => {
            // A crash can leave these behind.
            let _ = std::fs::remove_file(dir.join("groups.json.tmp"));
            for path in state_files(dir) {
                if !is_sealed_file(&path) {
                    seal_existing(&path, &key).with_context(|| format!("seal {}", path.display()))?;
                }
            }
            with_modes(|m| m.insert(dir.to_path_buf(), Mode::Keyed(key)));
        }
        None => {
            if has_sealed_state(dir) {
                bail!("Loop data is sealed and the app is locked");
            }
            with_modes(|m| m.remove(dir));
        }
    }
    Ok(())
}

/// Ends the session: the key is dropped and the directory refuses all access
/// until the next [`begin`].
pub fn lock(dir: &Path) {
    with_modes(|m| m.insert(dir.to_path_buf(), Mode::Locked));
}

fn name_of(path: &Path) -> String {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

fn seal_existing(path: &Path, key: &AttachmentKey) -> Result<()> {
    let name = name_of(path);
    let data = std::fs::read(path)?;
    if name.starts_with("messages-") {
        let mut out = LOG_MAGIC.to_vec();
        if !data.is_empty() {
            push_frame(&mut out, key, &name, &data)?;
        }
        replace_atomic(path, &out)
    } else {
        write_atomic(path, &data, Some(key))
    }
}

fn push_frame(out: &mut Vec<u8>, key: &AttachmentKey, name: &str, plain: &[u8]) -> Result<()> {
    let rec = key.seal_record(name.as_bytes(), plain)?;
    out.extend_from_slice(&u32::try_from(rec.len()).map_err(|_| anyhow!("record too large"))?.to_be_bytes());
    out.extend_from_slice(&rec);
    Ok(())
}

/// temp file (0600) in the same directory, fsync, rename over `path`.
fn replace_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("no parent dir")?;
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::Builder::new().prefix(".tmp-").tempfile_in(dir)?;
    tmp.as_file_mut().write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8], key: Option<&AttachmentKey>) -> Result<()> {
    match key {
        Some(k) => {
            let mut sealed = Vec::with_capacity(bytes.len() + 256);
            velta_attachment::encrypt(k, &mut std::io::Cursor::new(bytes), bytes.len() as u64, &mut sealed)?;
            replace_atomic(path, &sealed)
        }
        None => replace_atomic(path, bytes),
    }
}

/// Writes a small state file atomically (sealed when keyed).
pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    match access(path) {
        Access::Plain => write_atomic(path, bytes, None),
        Access::Sealed(k) => write_atomic(path, bytes, Some(&k)),
        Access::Locked => bail!("Loop data is locked"),
    }
}

/// Reads a small state file; `None` when missing, unreadable or locked.
pub fn read(path: &Path) -> Option<Vec<u8>> {
    match access(path) {
        Access::Locked => None,
        Access::Plain => {
            if velta_attachment::is_encrypted(path).unwrap_or(false) {
                return None;
            }
            std::fs::read(path).ok()
        }
        Access::Sealed(k) => AttachmentReader::open(path, Some(&k)).ok()?.read_all().ok(),
    }
}

/// Appends text (whole lines) to a log. Sealed as one record when keyed.
pub fn append(path: &Path, text: &[u8]) -> Result<()> {
    let name = name_of(path);
    let mut open = std::fs::OpenOptions::new();
    open.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    match access(path) {
        Access::Locked => bail!("Loop data is locked"),
        Access::Plain => {
            if is_sealed_log(path) {
                bail!("Loop log is sealed and no key is available");
            }
            open.open(path)?.write_all(text)?;
        }
        Access::Sealed(k) => {
            if path.exists() && !is_sealed_log(path) && std::fs::metadata(path)?.len() > 0 {
                seal_existing(path, &k)?;
            }
            let mut buf = Vec::new();
            let mut f = open.open(path)?;
            if f.metadata()?.len() == 0 {
                buf.extend_from_slice(LOG_MAGIC);
            }
            push_frame(&mut buf, &k, &name, text)?;
            // One write: a crash leaves at most a torn tail frame, which the
            // reader stops at.
            f.write_all(&buf)?;
        }
    }
    Ok(())
}

/// The log's plaintext lines as one string; `None` when missing or locked.
pub fn read_log(path: &Path) -> Option<String> {
    match access(path) {
        Access::Locked => None,
        Access::Plain => {
            if is_sealed_log(path) {
                return None;
            }
            std::fs::read_to_string(path).ok()
        }
        Access::Sealed(k) => {
            let data = std::fs::read(path).ok()?;
            if !data.starts_with(LOG_MAGIC) {
                return String::from_utf8(data).ok();
            }
            let name = name_of(path);
            let mut out = Vec::new();
            let mut rest = &data[LOG_MAGIC.len()..];
            while rest.len() >= 4 {
                let len = u32::from_be_bytes(rest[..4].try_into().ok()?) as usize;
                if rest.len() < 4 + len {
                    break; // torn tail
                }
                if let Ok(plain) = k.open_record(name.as_bytes(), &rest[4..4 + len]) {
                    out.extend_from_slice(&plain);
                }
                rest = &rest[4 + len..];
            }
            String::from_utf8(out).ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> AttachmentKey {
        AttachmentKey::from_db_key(&format!("x'{}'", format!("{n:02x}").repeat(32))).unwrap().unwrap()
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("velta-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn all_bytes(dir: &Path) -> Vec<u8> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            out.extend(std::fs::read(e.path()).unwrap());
        }
        out
    }

    fn contains(hay: &[u8], needle: &str) -> bool {
        hay.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    /// Plaintext state from an older build: first keyed start seals every
    /// file in place; nothing readable stays on disk, nothing is lost.
    #[test]
    fn first_keyed_start_seals_every_plaintext_file() {
        let dir = tmp("migrate");
        let hex = "ab".repeat(32);
        std::fs::write(dir.join("identity.key"), &hex).unwrap();
        std::fs::write(dir.join("profile.json"), r#"{"name":"Alice-secret-name"}"#).unwrap();
        std::fs::write(dir.join("peers.json"), r#"{"peers":[{"node_id":"peer-secret-id"}]}"#).unwrap();
        std::fs::write(dir.join("groups.json"), r#"{"groups":[]} group-secret"#).unwrap();
        std::fs::write(dir.join("messages-aa.jsonl"), "{\"text\":\"chat-secret-1\"}\n{\"text\":\"chat-secret-2\"}\n").unwrap();
        std::fs::write(dir.join("messages-g-bb.jsonl"), "").unwrap();
        std::fs::write(dir.join("unrelated.txt"), "keep-me").unwrap();

        begin(&dir, Some(key(1))).unwrap();

        let disk = all_bytes(&dir);
        for secret in [&hex[..], "Alice-secret-name", "peer-secret-id", "group-secret", "chat-secret-1", "chat-secret-2"] {
            assert!(!contains(&disk, secret), "{secret} still on disk in plaintext");
        }
        assert!(has_sealed_state(&dir));
        assert_eq!(read(&dir.join("identity.key")).unwrap(), hex.as_bytes());
        assert_eq!(read(&dir.join("profile.json")).unwrap(), br#"{"name":"Alice-secret-name"}"#);
        let log = read_log(&dir.join("messages-aa.jsonl")).unwrap();
        assert_eq!(log, "{\"text\":\"chat-secret-1\"}\n{\"text\":\"chat-secret-2\"}\n");
        assert_eq!(read_log(&dir.join("messages-g-bb.jsonl")).unwrap(), "");
        assert_eq!(std::fs::read(dir.join("unrelated.txt")).unwrap(), b"keep-me");
        assert!(
            std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".tmp-")),
            "no temp leftovers"
        );
        // A second start finds sealed files and leaves them alone.
        begin(&dir, Some(key(1))).unwrap();
        assert_eq!(read_log(&dir.join("messages-aa.jsonl")).unwrap().lines().count(), 2);
    }

    /// Lock closes the directory; unlock brings every byte back; a locked
    /// store never starts keyless and never loses its identity.
    #[test]
    fn lock_unlock_round_trip_and_locked_store_refuses_keyless() {
        let dir = tmp("lock");
        begin(&dir, Some(key(2))).unwrap();
        let id = dir.join("identity.key");
        let log = dir.join("messages-aa.jsonl");
        write(&id, b"cd".repeat(32).as_slice()).unwrap();
        append(&log, b"{\"n\":1}\n").unwrap();
        append(&log, b"{\"n\":2}\n").unwrap();
        assert!(!contains(&all_bytes(&dir), "\"n\":1"), "appends are sealed");
        assert_eq!(read_log(&log).unwrap(), "{\"n\":1}\n{\"n\":2}\n");

        lock(&dir);
        assert!(read(&id).is_none() && read_log(&log).is_none(), "nothing readable while locked");
        assert!(write(&id, b"x").is_err() && append(&log, b"{}\n").is_err(), "nothing writable while locked");

        // A keyless start over sealed state is refused; the files are untouched.
        assert!(begin(&dir, None).is_err());
        let sealed_len = std::fs::metadata(&id).unwrap().len();
        assert!(sealed_len > 64);

        // A wrong key cannot read it either.
        begin(&dir, Some(key(3))).unwrap();
        assert!(read(&id).is_none(), "wrong key does not open the file");

        begin(&dir, Some(key(2))).unwrap();
        assert_eq!(read(&id).unwrap(), b"cd".repeat(32));
        append(&log, b"{\"n\":3}\n").unwrap();
        assert_eq!(read_log(&log).unwrap(), "{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n");
    }

    /// A torn last frame (crash mid-append) is skipped, earlier history stays.
    #[test]
    fn torn_log_tail_is_ignored() {
        let dir = tmp("torn");
        begin(&dir, Some(key(4))).unwrap();
        let log = dir.join("messages-aa.jsonl");
        append(&log, b"{\"n\":1}\n").unwrap();
        append(&log, b"{\"n\":2}\n").unwrap();
        let mut data = std::fs::read(&log).unwrap();
        data.truncate(data.len() - 7);
        std::fs::write(&log, data).unwrap();
        assert_eq!(read_log(&log).unwrap(), "{\"n\":1}\n");
    }

    /// Files are owner-only with and without a key, and replacing a file
    /// never leaves it truncated: a failed write keeps the old content.
    #[cfg(unix)]
    #[test]
    fn owner_only_and_failed_write_keeps_old_content() {
        use std::os::unix::fs::PermissionsExt;
        for (tag, k) in [("perm-plain", None), ("perm-keyed", Some(key(5)))] {
            let dir = tmp(tag);
            begin(&dir, k).unwrap();
            write(&dir.join("peers.json"), b"{\"peers\":[]}").unwrap();
            append(&dir.join("messages-aa.jsonl"), b"{}\n").unwrap();
            for f in ["peers.json", "messages-aa.jsonl"] {
                let mode = std::fs::metadata(dir.join(f)).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0, "{tag}/{f}: {mode:o}");
            }
        }
        let dir = tmp("atomic");
        begin(&dir, None).unwrap();
        let p = dir.join("peers.json");
        write(&p, b"old-content").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let failed = write(&p, b"new-content").is_err();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        if failed {
            // (root ignores directory modes; then there is nothing to assert)
            assert_eq!(std::fs::read(&p).unwrap(), b"old-content");
        }
        write(&p, b"new-content").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new-content");
    }
}
