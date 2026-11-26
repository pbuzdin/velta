//! #470: automatic iroh file transfer for Velta ↔ Velta 1:1 chats.
//!
//! An attachment over [`THRESHOLD`] to a contact that proved it runs Velta
//! with this transfer (core patch #31, `Chat-Velta-Xfer`) is not mailed. The
//! sender stores a copy, offers it here and mails a small end-to-end
//! encrypted message carrying a [`Ticket`] (node id, SHA-256, size, expiry,
//! a random per-ticket secret, iroh protocol version, the sender's iroh
//! relay). The receiver fetches it over iroh: direct when reachable,
//! otherwise through the chatmail relay's advertised iroh relay. Fetches are
//! chunked, resumable (`.part` file) and hash-verified. Every failure that
//! the email path can fix (expired ticket, sender unreachable, other iroh
//! version) is a [`FetchError`] whose [`FetchError::wants_email`] is true: the
//! caller then asks the sender to re-send the file as a normal attachment.
//!
//! At rest (#465 parity): the offered copy, the received file, the offer
//! list and the endpoint key are sealed with the profile's attachment key
//! (VLTA) when there is one; keyless profiles keep plaintext files readable
//! only by this user. Only the in-flight `.part` is plaintext (resume appends
//! to it); it lives in app-private storage and is removed when the fetch ends
//! or after [`PART_MAX_AGE`].
//!
//! Offers survive restarts (`offers.json`): a receiver can still fetch after
//! the sender's app restarted, and the UI re-sends undelivered files by email
//! once their ticket expires.
//!
//! iroh version: 0.35, the one core and every chatmail relay's iroh relay
//! speak today (relays broke wire compatibility in 0.91). The ticket names
//! the version so a later 1.x path can be negotiated.
//!
//! Relays: ONLY the relay the chatmail server advertises. With none
//! advertised the endpoint runs with relays disabled (direct paths only) and
//! an unreachable sender falls back to email. A ticket naming another relay
//! is fetched direct-only. n0's public relays are never used.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context as _, Result};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use iroh035::{endpoint::Connection, Endpoint, NodeAddr, NodeId, RelayMap, RelayMode, RelayUrl, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use velta_attachment::{AttachmentKey, AttachmentReader};

/// Attachments strictly larger than this go over iroh (6 MB).
pub const THRESHOLD: u64 = 6 * 1024 * 1024;
/// Largest file a receiver accepts (the Loop engine's bound, p2p.rs).
pub const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
pub const ALPN: &[u8] = b"/velta/xfer/1";
pub const TICKET_PREFIX: &str = "VXFER1:";
/// The iroh wire this build speaks for transfers.
pub const IROH_PROTO: &str = "iroh-0.35";
/// Default ticket lifetime (the sender re-sends by email after this).
pub const DEFAULT_TTL: Duration = Duration::from_secs(24 * 3600);
/// Leftover `.part` files older than this are deleted at start.
/// A fetch gives up when no bytes arrive for this long (resumable).
pub const READ_IDLE: Duration = Duration::from_secs(30);
pub const PART_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);
/// Offers expired longer than this are forgotten by [`Xfer::sweep`] (the UI
/// mails or withdraws them well before).
const OFFER_KEEP: u64 = 7 * 24 * 3600;
/// Free space kept on top of the bytes a fetch needs.
const SPACE_MARGIN: u64 = 32 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;
const MAX_REQ: usize = 1024;

/// A download ticket, carried inside an end-to-end encrypted Velta message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub v: u8,
    /// iroh protocol of the provider, e.g. "iroh-0.35".
    pub proto: String,
    /// Sender's node id (hex).
    pub node: String,
    /// The sender's chatmail relay's iroh relay, if it advertises one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    /// Direct addresses known when the ticket was made (LAN first).
    #[serde(default)]
    pub addrs: Vec<SocketAddr>,
    /// SHA-256 of the file, lowercase hex.
    pub hash: String,
    pub size: u64,
    pub name: String,
    /// Expiry, Unix seconds.
    pub exp: u64,
    /// Random per-ticket secret the provider checks (hex). Knowing the
    /// node id and the file's hash is not enough to fetch it. Empty only in
    /// tickets from builds before it existed.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sec: String,
}

impl Ticket {
    pub fn encode(&self) -> String {
        format!("{TICKET_PREFIX}{}", BASE64URL_NOPAD.encode(&serde_json::to_vec(self).unwrap_or_default()))
    }

    pub fn decode(s: &str) -> Result<Ticket> {
        let raw = s.trim().strip_prefix(TICKET_PREFIX).context("not a Velta transfer ticket")?;
        let t: Ticket = serde_json::from_slice(&BASE64URL_NOPAD.decode(raw.as_bytes()).context("bad ticket encoding")?)?;
        if t.v != 1 {
            bail!("unsupported ticket version {}", t.v);
        }
        if t.hash.len() != 64 || HEXLOWER.decode(t.hash.as_bytes()).is_err() {
            bail!("bad hash");
        }
        if t.sec.len() > 128 {
            bail!("bad secret");
        }
        t.node.parse::<NodeId>().context("bad node id")?;
        if let Some(r) = &t.relay {
            r.parse::<RelayUrl>().context("bad relay url")?;
        }
        if t.name.is_empty() || t.name.len() > 255 || t.name.contains(['/', '\\', '\0']) || t.name == ".." || t.name == "." {
            bail!("bad file name");
        }
        Ok(t)
    }
}

/// Why a fetch did not produce the file.
#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The ticket's expiry passed.
    Expired,
    /// The provider speaks another iroh wire than this build.
    OtherProto(String),
    /// No path to the sender (offline, isolated network, no relay advertised).
    Unreachable(String),
    /// The sender no longer offers this file (deleted, expired there, or the
    /// ticket's secret did not match).
    NotOffered,
    /// The bytes did not hash to the ticket; the partial is deleted.
    HashMismatch,
    /// The ticket announces more than [`MAX_FILE`].
    TooLarge,
    /// Not enough free disk space for the file (bytes needed).
    NoSpace(u64),
    /// Local I/O or a broken stream; retrying resumes from the `.part`.
    Io(String),
}

impl FetchError {
    /// True when the email fallback (sender re-sends as an attachment) is the
    /// right answer. Io errors resume over iroh instead; a full disk needs
    /// the user, not another copy.
    pub fn wants_email(&self) -> bool {
        !matches!(self, FetchError::Io(_) | FetchError::NoSpace(_))
    }

    /// Short machine code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            FetchError::Expired => "expired",
            FetchError::OtherProto(_) => "proto",
            FetchError::Unreachable(_) => "unreachable",
            FetchError::NotOffered => "not-offered",
            FetchError::HashMismatch => "hash",
            FetchError::TooLarge => "too-large",
            FetchError::NoSpace(_) => "no-space",
            FetchError::Io(_) => "io",
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Relay policy: the chatmail relay's own iroh relay, or none. Never n0.
pub fn relay_mode_for(relay: Option<&str>) -> Result<RelayMode> {
    Ok(match relay {
        Some(u) => RelayMode::Custom(RelayMap::from(u.parse::<RelayUrl>().context("bad relay url")?)),
        None => RelayMode::Disabled,
    })
}

/// The relay a fetch may dial: the ticket's relay only when it is the one
/// our own chatmail transport advertises, or the sender's own chatmail
/// relay (`peers`: the sender's mail domains — chatmail serves its iroh
/// relay at `https://<domain>` — or full relay URLs). Anything else
/// (another server, n0) is ignored and the fetch runs direct-only.
pub fn allowed_relay(ticket_relay: Option<&str>, own: Option<&str>, peers: &[String]) -> Option<RelayUrl> {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    let t = ticket_relay?;
    let url: RelayUrl = t.parse().ok()?;
    if own.is_some_and(|o| norm(o) == norm(t)) {
        return Some(url);
    }
    // RelayUrl stores hosts as FQDNs ("example.org."): drop the dot.
    let host = url.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    let https = url.scheme() == "https";
    let ok = peers.iter().any(|p| {
        let p = p.trim().to_ascii_lowercase();
        if p.contains("://") {
            norm(&p) == norm(t)
        } else {
            let d = p.trim_start_matches('.').trim_end_matches('.');
            https && !d.is_empty() && (host == d || host == format!("iroh.{d}"))
        }
    });
    ok.then_some(url)
}

/// Route decision for one attachment (the JS side mirrors it in iroh-xfer.js).
pub fn use_iroh(enabled: bool, size: u64, one_to_one: bool, peer_is_velta: bool) -> bool {
    enabled && one_to_one && peer_is_velta && size > THRESHOLD
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Serialize, Deserialize)]
struct Request {
    hash: String,
    offset: u64,
    #[serde(default)]
    sec: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Response {
    ok: bool,
    #[serde(default)]
    err: String,
    #[serde(default)]
    size: u64,
}

/// One open offer; persisted in `offers.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Offer {
    /// The stored copy (`out/<hash>`, VLTA when the profile has a key).
    pub path: PathBuf,
    /// Plaintext size.
    pub size: u64,
    pub exp: u64,
    pub sec: String,
    #[serde(default)]
    pub name: String,
    /// Unix seconds of the first complete delivery, 0 = none yet.
    #[serde(default)]
    pub delivered: u64,
}

/// Writes `bytes` to `path` atomically: VLTA under `key`, else plaintext.
/// tempfile creates the file owner-only (0600 on Unix).
fn write_private(path: &Path, bytes: &[u8], key: Option<&AttachmentKey>) -> Result<()> {
    let dir = path.parent().context("no parent dir")?;
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::Builder::new().prefix(".tmp-").tempfile_in(dir)?;
    match key {
        Some(k) => velta_attachment::encrypt(k, &mut std::io::Cursor::new(bytes), bytes.len() as u64, tmp.as_file_mut())?,
        None => tmp.as_file_mut().write_all(bytes)?,
    }
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn read_private(path: &Path, key: Option<&AttachmentKey>) -> Result<Vec<u8>> {
    AttachmentReader::open(path, key)?.read_all()
}

/// Hashes everything read through it.
struct HashingReader<'a, R> {
    inner: &'a mut R,
    h: Sha256,
    n: u64,
}

impl<R: Read> Read for HashingReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.h.update(&buf[..n]);
        self.n += n as u64;
        Ok(n)
    }
}

/// Owns `inner` and hashes every plaintext byte read through it.
pub(crate) struct PlainHasher<R> {
    inner: R,
    h: Sha256,
}

impl<R> PlainHasher<R> {
    pub(crate) fn new(inner: R) -> Self {
        Self { inner, h: Sha256::new() }
    }

    pub(crate) fn finish(self) -> [u8; 32] {
        let dig = self.h.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&dig);
        out
    }
}

impl<R: Read> Read for PlainHasher<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.h.update(&buf[..n]);
        Ok(n)
    }
}

/// `{path}.sha256` — the extension stays, so `clip.mp4` is not `clip.sha256`.
pub(crate) fn sha_sidecar(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".sha256");
    PathBuf::from(name)
}

/// Records the plaintext SHA-256 next to a sealed upload. A failed write
/// removes a stale sidecar so the offer falls back to hashing the file.
pub(crate) fn write_plaintext_hash(dest: &Path, hash: &[u8]) {
    let side = sha_sidecar(dest);
    if std::fs::write(&side, HEXLOWER.encode(hash)).is_err() {
        let _ = std::fs::remove_file(&side);
    }
}

fn read_sha_sidecar(src: &Path) -> Option<String> {
    let raw = std::fs::read(sha_sidecar(src)).ok()?;
    let text = std::str::from_utf8(&raw).ok()?;
    let s = text.trim();
    if s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Some(s.to_string())
    } else {
        None
    }
}

/// Same bytes as `src` at `dest`. Hard link when the volume allows it;
/// otherwise a temp copy renamed into place so a crash cannot leave a short file.
fn link_or_copy(src: &Path, dest: &Path) -> Result<()> {
    if dest.exists() || std::fs::hard_link(src, dest).is_ok() || dest.exists() {
        return Ok(());
    }
    let tmp = dest.with_file_name(format!(".{}", dest.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::copy(src, &tmp).with_context(|| format!("copying {}", src.display()))?;
    std::fs::File::open(&tmp)?.sync_all()?;
    if std::fs::rename(&tmp, dest).is_err() {
        let _ = std::fs::remove_file(&tmp);
        if !dest.exists() {
            bail!("could not store {}", dest.display());
        }
    }
    Ok(())
}

/// Sidecar from seal time: link the sealed bytes. A sidecar on plaintext
/// while a key is set is ignored — that hash is not of these bytes.
fn try_link_stored(src: &Path, out_dir: &Path, key: Option<&AttachmentKey>) -> Result<Option<(String, u64, PathBuf)>> {
    let Some(hash) = read_sha_sidecar(src) else { return Ok(None) };
    let len = match key {
        Some(k) => {
            if !velta_attachment::is_encrypted(src).unwrap_or(false) {
                return Ok(None);
            }
            AttachmentReader::open(src, Some(k))?.len()
        }
        None => std::fs::metadata(src)?.len(),
    };
    std::fs::create_dir_all(out_dir)?;
    let dest = out_dir.join(&hash);
    link_or_copy(src, &dest)?;
    Ok(Some((hash, len, dest)))
}

/// Copies `src` (plaintext or a VLTA upload) into `out_dir/<sha256>`, sealed
/// under `key` when set. A seal-time sidecar links those bytes instead of
/// decrypting and sealing them again. Returns (hash, plaintext size, stored path).
fn store_copy(src: &Path, out_dir: &Path, key: Option<&AttachmentKey>) -> Result<(String, u64, PathBuf)> {
    if let Some(hit) = try_link_stored(src, out_dir, key)? {
        return Ok(hit);
    }
    let mut reader = AttachmentReader::open(src, key).with_context(|| format!("opening {}", src.display()))?;
    let len = reader.len();
    std::fs::create_dir_all(out_dir)?;
    let mut tmp = tempfile::Builder::new().prefix(".offer-").tempfile_in(out_dir)?;
    let mut hr = HashingReader { inner: &mut reader, h: Sha256::new(), n: 0 };
    match key {
        Some(k) => velta_attachment::encrypt(k, &mut hr, len, tmp.as_file_mut())?,
        None => {
            std::io::copy(&mut hr, tmp.as_file_mut())?;
        }
    }
    if hr.n != len {
        bail!("file changed while it was copied");
    }
    tmp.as_file().sync_all()?;
    let hash = HEXLOWER.encode(&hr.h.finalize());
    let dest = out_dir.join(&hash);
    tmp.persist(&dest).map_err(|e| e.error)?;
    Ok((hash, len, dest))
}

/// Moves a verified `.part` to `out_dir/<name>` (unique), sealing it under
/// `key` when set. The plaintext partial is removed either way.
fn finish_received(part: &Path, out_dir: &Path, name: &str, key: Option<&AttachmentKey>) -> Result<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let out = unique_path(out_dir, name);
    match key {
        Some(k) => {
            let r = velta_attachment::encrypt_file(k, part, &out);
            let _ = std::fs::remove_file(part);
            if let Err(e) = r {
                let _ = std::fs::remove_file(&out);
                return Err(e);
            }
        }
        None => {
            if std::fs::rename(part, &out).is_err() {
                std::fs::copy(part, &out)?;
                let _ = std::fs::remove_file(part);
            }
        }
    }
    Ok(out)
}

/// Bytes the user may still write under `dir`, if the platform says.
#[cfg(unix)]
pub fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `s` a writable statvfs.
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some((s.f_bavail as u64).saturating_mul(s.f_frsize as u64))
}

#[cfg(windows)]
pub fn free_space(dir: &Path) -> Option<u64> {
    use windows::{core::HSTRING, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};
    let mut avail = 0u64;
    // SAFETY: the out pointer is a live u64; the other outputs are not requested.
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(dir.as_os_str()), Some(&mut avail as *mut u64), None, None) }.ok()?;
    Some(avail)
}

#[cfg(not(any(unix, windows)))]
pub fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// One transfer endpoint: offers files (provider) and fetches tickets.
pub struct Xfer {
    endpoint: Endpoint,
    relay: Option<String>,
    /// State dir: `offers.json`, `out/` (stored copies), `part/` (fetches).
    dir: PathBuf,
    key: Option<AttachmentKey>,
    offers: Mutex<HashMap<String, Offer>>,
    /// Bytes streamed out by the provider (tests check resume with it).
    pub served: AtomicU64,
    connect_timeout_ms: AtomicU64,
    read_idle_ms: AtomicU64,
}

impl Xfer {
    /// Binds an endpoint that uses `relay` (the chatmail relay's advertised
    /// iroh relay) or no relay at all, with its state in `dir`. Offers saved
    /// by an earlier run are served again; stale partials are removed.
    pub async fn start(secret: SecretKey, relay: Option<String>, dir: PathBuf, key: Option<AttachmentKey>) -> Result<Arc<Xfer>> {
        let builder = Endpoint::builder()
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(relay_mode_for(relay.as_deref())?);
        // Tests run a local relay with a self-signed certificate.
        #[cfg(test)]
        let builder = builder.insecure_skip_relay_cert_verify(relay.as_deref().is_some_and(|r| r.contains("localhost") || r.contains("127.0.0.1")));
        let endpoint = builder
            .bind()
            .await
            .context("binding transfer endpoint")?;
        std::fs::create_dir_all(&dir)?;
        let offers = match read_private(&dir.join("offers.json"), key.as_ref()) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => HashMap::new(),
        };
        clean_parts(&dir.join("part"), PART_MAX_AGE);
        let x = Arc::new(Xfer {
            endpoint,
            relay,
            dir,
            key,
            offers: Mutex::new(offers),
            served: AtomicU64::new(0),
            connect_timeout_ms: AtomicU64::new(20_000),
            read_idle_ms: AtomicU64::new(READ_IDLE.as_millis() as u64),
        });
        let me = x.clone();
        tokio::spawn(async move { me.accept_loop().await });
        Ok(x)
    }

    /// How long a fetch waits for a path before calling the sender unreachable.
    pub fn set_connect_timeout(&self, d: Duration) {
        self.connect_timeout_ms.store(d.as_millis() as u64, Ordering::Relaxed);
    }

    /// How long a fetch waits for handshake answer or body bytes before
    /// giving up (resumable). Tests shorten it.
    pub fn set_read_idle(&self, d: Duration) {
        self.read_idle_ms.store(d.as_millis() as u64, Ordering::Relaxed);
    }

    fn read_idle(&self) -> Duration {
        Duration::from_millis(self.read_idle_ms.load(Ordering::Relaxed))
    }

    pub fn node_id(&self) -> NodeId {
        self.endpoint.node_id()
    }

    fn persist(&self) {
        let bytes = {
            let o = self.offers.lock().unwrap();
            serde_json::to_vec(&*o).unwrap_or_default()
        };
        if let Err(e) = write_private(&self.dir.join("offers.json"), &bytes, self.key.as_ref()) {
            eprintln!("xfer: saving offers failed: {e:#}");
        }
    }

    /// Stores a copy of `path` and offers it; returns its ticket (valid for
    /// `ttl`). `name` is the file name the receiver sees.
    pub async fn offer(&self, path: &Path, name: Option<&str>, ttl: Duration) -> Result<Ticket> {
        let src = path.to_path_buf();
        let out_dir = self.dir.join("out");
        let key = self.key.clone();
        let (hash, size, stored) = tokio::task::spawn_blocking(move || store_copy(&src, &out_dir, key.as_ref())).await??;
        let name = name
            .map(str::to_string)
            .or_else(|| path.file_name().and_then(|n| n.to_str()).map(str::to_string))
            .unwrap_or_else(|| "file".into());
        let exp = now() + ttl.as_secs();
        let sec = HEXLOWER.encode(&crate::random_bytes::<16>());
        let addrs = match tokio::time::timeout(Duration::from_secs(5), self.endpoint.node_addr()).await {
            Ok(Ok(na)) => na.direct_addresses.into_iter().collect(),
            _ => Vec::new(),
        };
        self.offers.lock().unwrap().insert(
            hash.clone(),
            Offer { path: stored, size, exp, sec: sec.clone(), name: name.clone(), delivered: 0 },
        );
        self.persist();
        Ok(Ticket {
            v: 1,
            proto: IROH_PROTO.into(),
            node: self.node_id().to_string(),
            relay: self.relay.clone(),
            addrs,
            hash,
            size,
            name,
            exp,
            sec,
        })
    }

    /// Stops offering a file (delivered, mailed, or expired) and deletes the
    /// stored copy.
    pub fn withdraw(&self, hash: &str) {
        let gone = self.offers.lock().unwrap().remove(hash);
        if let Some(o) = gone {
            let _ = std::fs::remove_file(&o.path);
            self.persist();
        }
    }

    /// The open offer for `hash`, if any.
    pub fn status(&self, hash: &str) -> Option<Offer> {
        self.offers.lock().unwrap().get(hash).cloned()
    }

    /// Forgets offers that expired more than a week ago (the UI handles
    /// fresh expiries: it mails undelivered files, then withdraws them).
    /// Returns how many went.
    pub fn sweep(&self) -> usize {
        let t = now();
        let dropped: Vec<Offer> = {
            let mut o = self.offers.lock().unwrap();
            let keys: Vec<String> = o.iter().filter(|(_, v)| v.exp + OFFER_KEEP <= t).map(|(k, _)| k.clone()).collect();
            keys.iter().filter_map(|k| o.remove(k)).collect()
        };
        for o in &dropped {
            let _ = std::fs::remove_file(&o.path);
        }
        if !dropped.is_empty() {
            self.persist();
        }
        dropped.len()
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(connecting) = incoming.accept() else { return };
                if let Ok(conn) = connecting.await {
                    let _ = me.serve(conn).await;
                }
            });
        }
    }

    /// Provider side: one request per bi stream, `{hash, offset, sec}` →
    /// header + the plaintext from `offset`. A wrong secret looks exactly
    /// like an unknown file.
    async fn serve(&self, conn: Connection) -> Result<()> {
        loop {
            let Ok((mut send, mut recv)) = conn.accept_bi().await else { return Ok(()) };
            let req: Request = serde_json::from_slice(&read_frame(&mut recv).await?)?;
            let offer = {
                let o = self.offers.lock().unwrap();
                o.get(&req.hash).filter(|o| ct_eq(o.sec.as_bytes(), req.sec.as_bytes())).cloned()
            };
            let resp = match &offer {
                None => Response { ok: false, err: "not-offered".into(), size: 0 },
                Some(o) if o.exp <= now() => Response { ok: false, err: "expired".into(), size: 0 },
                Some(o) if req.offset > o.size => Response { ok: false, err: "range".into(), size: o.size },
                Some(o) => Response { ok: true, err: String::new(), size: o.size },
            };
            write_frame(&mut send, &serde_json::to_vec(&resp)?).await?;
            if resp.ok {
                let o = offer.unwrap();
                let mut rx = spawn_reader(o.path.clone(), self.key.clone(), req.offset);
                let mut sent = req.offset;
                while let Some(chunk) = rx.recv().await {
                    let chunk = chunk?;
                    send.write_all(&chunk).await?;
                    sent += chunk.len() as u64;
                    self.served.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                }
                if sent == o.size {
                    let first = {
                        let mut m = self.offers.lock().unwrap();
                        match m.get_mut(&req.hash) {
                            Some(e) if e.delivered == 0 => {
                                e.delivered = now();
                                true
                            }
                            _ => false,
                        }
                    };
                    if first {
                        self.persist();
                    }
                }
            }
            send.finish()?;
        }
    }

    /// Fetches `ticket` into `out_dir/<name>` (sealed when the profile has a
    /// key), resuming a `.part` left by an interrupted run. `progress(done,
    /// size)` is called per chunk.
    pub async fn fetch(&self, ticket: &Ticket, out_dir: &Path, progress: impl FnMut(u64, u64)) -> std::result::Result<PathBuf, FetchError> {
        self.fetch_from(ticket, out_dir, &[], progress).await
    }

    /// [`Xfer::fetch`] that may also dial the sender's own chatmail relay
    /// (`peers`, see [`allowed_relay`]).
    pub async fn fetch_from(
        &self,
        ticket: &Ticket,
        out_dir: &Path,
        peers: &[String],
        mut progress: impl FnMut(u64, u64),
    ) -> std::result::Result<PathBuf, FetchError> {
        if ticket.proto != IROH_PROTO {
            return Err(FetchError::OtherProto(ticket.proto.clone()));
        }
        if ticket.exp <= now() {
            return Err(FetchError::Expired);
        }
        if ticket.size > MAX_FILE {
            return Err(FetchError::TooLarge);
        }
        let io = |e: anyhow::Error| FetchError::Io(format!("{e:#}"));
        let part_dir = self.dir.join("part");
        tokio::fs::create_dir_all(&part_dir).await.map_err(|e| io(e.into()))?;
        let part = part_dir.join(format!("{}.part", ticket.hash));
        let mut offset = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        if offset > ticket.size {
            let _ = tokio::fs::remove_file(&part).await;
            offset = 0;
        }
        // The rest of the partial, plus the sealed copy written next to it.
        let need = (ticket.size - offset) + if self.key.is_some() { ticket.size } else { 0 } + SPACE_MARGIN;
        let _ = tokio::fs::create_dir_all(out_dir).await;
        for d in [part_dir.as_path(), out_dir] {
            if free_space(d).is_some_and(|free| free < need) {
                return Err(FetchError::NoSpace(need));
            }
        }

        let node: NodeId = ticket.node.parse().map_err(|_| FetchError::Unreachable("bad node id".into()))?;
        let mut addr = NodeAddr::new(node).with_direct_addresses(ticket.addrs.iter().copied());
        if let Some(url) = allowed_relay(ticket.relay.as_deref(), self.relay.as_deref(), peers) {
            addr = addr.with_relay_url(url);
        }
        let conn = match tokio::time::timeout(Duration::from_millis(self.connect_timeout_ms.load(Ordering::Relaxed)), self.endpoint.connect(addr, ALPN)).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => return Err(FetchError::Unreachable(format!("{e:#}"))),
            Err(_) => return Err(FetchError::Unreachable("timed out".into())),
        };

        // The whole request/response handshake is bounded like a body read:
        // a peer that accepts the connection but never answers the request
        // frame (backgrounded mid-handshake, wedged accept loop) must not
        // park xfer_fetch — and the card's busy ring — forever.
        let handshake = async {
            let (mut send, mut recv) = conn.open_bi().await.map_err(|e| io(e.into()))?;
            let req = Request { hash: ticket.hash.clone(), offset, sec: ticket.sec.clone() };
            write_frame(&mut send, &serde_json::to_vec(&req).unwrap()).await.map_err(io)?;
            send.finish().map_err(|e| io(e.into()))?;
            let resp: Response = serde_json::from_slice(&read_frame(&mut recv).await.map_err(io)?)
                .map_err(|e| io(e.into()))?;
            Ok::<_, FetchError>((recv, resp))
        };
        let (mut recv, resp) = match tokio::time::timeout(self.read_idle(), handshake).await {
            Ok(r) => r?,
            Err(_) => return Err(FetchError::Io("stalled".into())),
        };
        if !resp.ok {
            let e = match resp.err.as_str() {
                "expired" => FetchError::Expired,
                "not-offered" => FetchError::NotOffered,
                other => FetchError::Io(other.to_string()),
            };
            if e.wants_email() {
                let _ = tokio::fs::remove_file(&part).await;
            }
            return Err(e);
        }
        if resp.size != ticket.size {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(FetchError::HashMismatch);
        }
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part)
            .await
            .map_err(|e| io(e.into()))?;
        let mut done = offset;
        progress(done, ticket.size);
        let mut buf = vec![0u8; CHUNK];
        loop {
            // A sender that went to the background stops sending without
            // closing: give up after READ_IDLE so the UI can resume/retry.
            let n = match tokio::time::timeout(self.read_idle(), recv.read(&mut buf)).await {
                Ok(Ok(Some(n))) => n,
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    let _ = f.flush().await;
                    return Err(FetchError::Io(e.to_string())); // the .part stays: resume next time
                }
                Err(_) => {
                    let _ = f.flush().await;
                    return Err(FetchError::Io("stalled".into()));
                }
            };
            done += n as u64;
            if done > ticket.size {
                drop(f);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(FetchError::HashMismatch);
            }
            f.write_all(&buf[..n]).await.map_err(|e| io(e.into()))?;
            progress(done, ticket.size);
        }
        f.flush().await.map_err(|e| io(e.into()))?;
        drop(f);
        conn.close(0u32.into(), b"done");
        if done != ticket.size {
            return Err(FetchError::Io(format!("short read {done}/{}", ticket.size)));
        }
        if sha256_file(&part, None).await.map_err(io)? != ticket.hash {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(FetchError::HashMismatch);
        }
        let (part2, out_dir2, name, key) = (part.clone(), out_dir.to_path_buf(), ticket.name.clone(), self.key.clone());
        tokio::task::spawn_blocking(move || finish_received(&part2, &out_dir2, &name, key.as_ref()))
            .await
            .map_err(|e| FetchError::Io(e.to_string()))?
            .map_err(io)
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// Reads the plaintext of `path` from `offset` on a blocking thread.
fn spawn_reader(path: PathBuf, key: Option<AttachmentKey>, offset: u64) -> tokio::sync::mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let mut r = match AttachmentReader::open(&path, key.as_ref()) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.blocking_send(Err(std::io::Error::other(e.to_string())));
                return;
            }
        };
        if let Err(e) = r.seek(SeekFrom::Start(offset)) {
            let _ = tx.blocking_send(Err(e));
            return;
        }
        loop {
            let mut buf = vec![0u8; CHUNK];
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    buf.truncate(n);
                    if tx.blocking_send(Ok(buf)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
    });
    rx
}

/// Deletes `.part` files under `dir` older than `max_age`.
fn clean_parts(dir: &Path, max_age: Duration) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// -- Tauri commands -----------------------------------------------------------

/// The app's transfer endpoint, (re)bound for the current advertised relay.
#[derive(Default)]
pub struct XferState {
    inner: tokio::sync::Mutex<Option<Arc<Xfer>>>,
}

/// The endpoint's secret key: sealed under the attachment key when the
/// profile has one (older plaintext keys are re-sealed), otherwise a
/// plaintext file readable only by this user.
fn load_or_create_key(dir: &Path, key: Option<&AttachmentKey>) -> Result<SecretKey> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("identity.key");
    if let Ok(raw) = read_private(&path, key) {
        if let Ok(b) = HEXLOWER.decode(String::from_utf8_lossy(&raw).trim().as_bytes()) {
            if let Ok(b) = <[u8; 32]>::try_from(b) {
                let sealed = velta_attachment::is_encrypted(&path).unwrap_or(false);
                if key.is_some() && !sealed {
                    write_private(&path, HEXLOWER.encode(&b).as_bytes(), key)?;
                }
                return Ok(SecretKey::from_bytes(&b));
            }
        }
    }
    // Missing, unreadable (sealed under a key we no longer have) or corrupt:
    // a new node id. Open tickets then fail over to email.
    let b: [u8; 32] = crate::random_bytes();
    write_private(&path, HEXLOWER.encode(&b).as_bytes(), key)?;
    Ok(SecretKey::from_bytes(&b))
}

fn attachment_key() -> Option<AttachmentKey> {
    crate::ATTACHMENT_KEY.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// How long a command waits for the endpoint (its lock, a bind) before it
/// reports Velta Dash unavailable instead of hanging the UI.
pub const ENSURE_MAX: Duration = Duration::from_secs(15);

impl XferState {
    /// The running endpoint, if any; the lock is released before this
    /// returns. xfer_status and xfer_withdraw used to match on the guard
    /// itself and call ensure() in the None arm: the guard lived for the
    /// whole match, so a cold call (the boot sweep with open offers, before
    /// anything bound the endpoint) locked the same mutex twice and
    /// deadlocked every later xfer_* call. Dash health timed out and
    /// xfer_offer never returned.
    pub async fn running(&self) -> Option<Arc<Xfer>> {
        let g = self.inner.lock().await;
        g.clone()
    }

    /// The running endpoint for `relay`, (re)bound with its state in `dir`.
    pub async fn ensure_at(&self, relay: Option<String>, dir: PathBuf) -> Result<Arc<Xfer>, String> {
        let mut g = self.inner.lock().await;
        if let Some(x) = g.as_ref() {
            // No relay known this call (metadata not loaded yet): keep the
            // running endpoint rather than restarting it relay-less, which
            // would cut transfers in flight and strip the relay from offers.
            if x.relay == relay || relay.is_none() {
                return Ok(x.clone());
            }
        }
        let key = attachment_key();
        let secret = load_or_create_key(&dir, key.as_ref()).map_err(|e| e.to_string())?;
        if let Some(old) = g.take() {
            // Its offers are on disk; the new endpoint loads them. A close
            // stuck on a dead peer must not hold the lock.
            let _ = tokio::time::timeout(Duration::from_secs(3), old.close()).await;
        }
        let new = Xfer::start(secret, relay, dir, key).await.map_err(|e| format!("{e:#}"))?;
        *g = Some(new.clone());
        Ok(new)
    }

    /// The running endpoint whatever its relay, or a new one (status and
    /// withdraw only read the offer list).
    pub async fn running_or_start(&self, relay: Option<String>, dir: PathBuf) -> Result<Arc<Xfer>, String> {
        match self.running().await {
            Some(x) => Ok(x),
            None => self.ensure_at(relay, dir).await,
        }
    }
}

fn state_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("xfer"))
}

/// `fut` bounded by [`ENSURE_MAX`], with an error the UI can show.
async fn bounded<T>(fut: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(ENSURE_MAX, fut)
        .await
        .unwrap_or_else(|_| Err(format!("the Velta Dash endpoint did not start within {} s", ENSURE_MAX.as_secs())))
}

async fn ensure(state: &XferState, app: &tauri::AppHandle, relay: Option<String>) -> Result<Arc<Xfer>, String> {
    let dir = state_dir(app)?;
    bounded(state.ensure_at(relay, dir)).await
}

async fn running_or_start(state: &XferState, app: &tauri::AppHandle, relay: Option<String>) -> Result<Arc<Xfer>, String> {
    let dir = state_dir(app)?;
    bounded(state.running_or_start(relay, dir)).await
}

/// Offers a file for an iroh transfer; returns the ticket string to mail.
/// `relay` is the chatmail relay's advertised iroh relay (get_server_metadata),
/// or null for direct paths only. `name` is the name the receiver sees.
#[tauri::command]
pub async fn xfer_offer(
    state: tauri::State<'_, XferState>,
    app: tauri::AppHandle,
    path: String,
    relay: Option<String>,
    name: Option<String>,
    ttl_secs: Option<u64>,
) -> Result<String, String> {
    let x = ensure(&state, &app, relay).await?;
    x.sweep();
    let ttl = ttl_secs.map(Duration::from_secs).unwrap_or(DEFAULT_TTL);
    Ok(x.offer(Path::new(&path), name.as_deref(), ttl).await.map_err(|e| format!("{e:#}"))?.encode())
}

/// Fetches a ticket into the accounts dir. Returns `{path}` on success, or
/// `{error, code, email}` where `email: true` means "ask the sender to mail it".
#[tauri::command]
pub async fn xfer_fetch(
    state: tauri::State<'_, XferState>,
    app: tauri::AppHandle,
    ticket: String,
    relay: Option<String>,
    peers: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let t = match Ticket::decode(&ticket) {
        Ok(t) => t,
        Err(e) => return Ok(serde_json::json!({ "error": format!("{e:#}"), "code": "bad-ticket", "email": true })),
    };
    let x = ensure(&state, &app, relay).await?;
    let dir = crate::accounts_dir(&app).join("xfer-in");
    let hash = t.hash.clone();
    let mut last = 0u64;
    let mut first = true; // the 0-byte event flips the card to "Fetching 0%"
    let peers = peers.unwrap_or_default();
    let res = x
        .fetch_from(&t, &dir, &peers, |done, size| {
            if first || done == size || done - last >= 1024 * 1024 {
                first = false;
                last = done;
                let _ = app.emit("xfer-progress", serde_json::json!({ "hash": hash, "done": done, "size": size }));
            }
        })
        .await;
    Ok(match res {
        Ok(p) => serde_json::json!({ "path": p.to_string_lossy() }),
        Err(e) => serde_json::json!({ "error": e.to_string(), "code": e.code(), "email": e.wants_email() }),
    })
}

/// Stops offering a file (delivered, mailed, or expired) and deletes the
/// stored copy.
#[tauri::command]
pub async fn xfer_withdraw(
    state: tauri::State<'_, XferState>,
    app: tauri::AppHandle,
    hash: String,
    relay: Option<String>,
) -> Result<(), String> {
    let x = running_or_start(&state, &app, relay).await?;
    x.withdraw(&hash);
    Ok(())
}

/// State of open offers for the UI's resend loop: `{hash: {size, exp,
/// delivered, path} | null}`. `path` is the stored copy to mail when a
/// ticket expires undelivered. Starts the endpoint (serving the saved
/// offers again) if it is not running yet.
#[tauri::command]
pub async fn xfer_status(
    state: tauri::State<'_, XferState>,
    app: tauri::AppHandle,
    hashes: Vec<String>,
    relay: Option<String>,
) -> Result<serde_json::Value, String> {
    let x = running_or_start(&state, &app, relay).await?;
    let mut out = serde_json::Map::new();
    for h in hashes {
        let v = x.status(&h).map(|o| {
            serde_json::json!({ "size": o.size, "exp": o.exp, "delivered": o.delivered, "path": o.path.to_string_lossy() })
        });
        out.insert(h, v.unwrap_or(serde_json::Value::Null));
    }
    Ok(serde_json::Value::Object(out))
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap()
}

/// SHA-256 of a file (the first `limit` bytes if set), lowercase hex.
/// #551: one blocking-thread pass with plain reads: a whole-file hash on
/// tokio::fs costs a blocking-pool hop per read and parks nothing else.
pub async fn sha256_file(path: &Path, limit: Option<u64>) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        let mut f = std::fs::File::open(&path)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        let mut left = limit.unwrap_or(u64::MAX);
        while left > 0 {
            let want = buf.len().min(left.min(usize::MAX as u64) as usize);
            let n = match f.read(&mut buf[..want]) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            };
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            left -= n as u64;
        }
        Ok(HEXLOWER.encode(&h.finalize()))
    })
    .await?
}

async fn write_frame(s: &mut iroh035::endpoint::SendStream, b: &[u8]) -> Result<()> {
    s.write_all(&(b.len() as u32).to_be_bytes()).await?;
    s.write_all(b).await?;
    Ok(())
}

async fn read_frame(r: &mut iroh035::endpoint::RecvStream) -> Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_REQ {
        bail!("frame too large");
    }
    let mut b = vec![0u8; n];
    r.read_exact(&mut b).await?;
    Ok(b)
}

/// Plaintext size of a file the composer is about to send (sealed uploads
/// are VLTA ciphertext on disk), without reading it into the webview.
#[tauri::command]
pub async fn xfer_file_size(path: String) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        let key = attachment_key();
        AttachmentReader::open(Path::new(&path), key.as_ref()).map(|r| r.len()).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pre-send check: can this device offer a file right now? Starts the
/// endpoint if needed and waits up to 4 s for it to reach its home relay.
/// `{ready, relay, relayConnected, direct}`: `relayConnected` false with a
/// relay means a receiver on another network can't reach us right now.
#[tauri::command]
pub async fn xfer_health(state: tauri::State<'_, XferState>, app: tauri::AppHandle, relay: Option<String>) -> Result<serde_json::Value, String> {
    // Answers within ~11 s whatever happens; a failure is a reason the
    // composer can show, not a rejected call.
    let x = match tokio::time::timeout(Duration::from_secs(5), state.ensure_at(relay.clone(), state_dir(&app)?)).await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return Ok(serde_json::json!({ "ready": false, "relay": relay, "relayConnected": false, "error": e })),
        Err(_) => return Ok(serde_json::json!({ "ready": false, "relay": relay, "relayConnected": false, "error": "timeout" })),
    };
    let relay_connected = match x.relay {
        Some(_) => tokio::time::timeout(Duration::from_secs(4), x.endpoint.home_relay().initialized()).await.is_ok(),
        None => false,
    };
    let direct = match tokio::time::timeout(Duration::from_secs(2), x.endpoint.node_addr()).await {
        Ok(Ok(na)) => na.direct_addresses.len(),
        _ => 0,
    };
    Ok(serde_json::json!({ "ready": true, "relay": x.relay, "relayConnected": relay_connected, "direct": direct }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("velta-xfer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn data(n: usize, seed: u8) -> Vec<u8> {
        (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    fn akey(b: u8) -> AttachmentKey {
        AttachmentKey::from_db_key(&format!("x'{}'", format!("{b:02x}").repeat(32))).unwrap().unwrap()
    }

    fn skey() -> SecretKey {
        SecretKey::from_bytes(&crate::random_bytes())
    }

    async fn node(tag: &str, key: Option<AttachmentKey>) -> Arc<Xfer> {
        Xfer::start(skey(), None, tmp(tag), key).await.unwrap()
    }

    async fn pair(tag: &str) -> (Arc<Xfer>, Arc<Xfer>) {
        (node(&format!("{tag}-a"), None).await, node(&format!("{tag}-b"), None).await)
    }

    #[test]
    fn route_rule_and_no_n0_relays() {
        assert!(!use_iroh(true, THRESHOLD, true, true), "exactly 6 MB goes by email");
        assert!(use_iroh(true, THRESHOLD + 1, true, true));
        assert!(!use_iroh(true, THRESHOLD + 1, true, false), "Delta Chat contacts get email");
        assert!(!use_iroh(true, THRESHOLD + 1, false, true), "groups get email");
        assert!(!use_iroh(false, THRESHOLD + 1, true, true), "setting off");
        assert!(matches!(relay_mode_for(None).unwrap(), RelayMode::Disabled), "no advertised relay: no relay at all, never n0");
        assert!(matches!(relay_mode_for(Some("https://iroh.relay.example/")).unwrap(), RelayMode::Custom(_)));
        assert!(relay_mode_for(Some("not a url")).is_err());
    }

    #[test]
    fn fetch_only_dials_our_own_or_the_senders_chatmail_relay() {
        let own = Some("https://iroh.relay.example/");
        let none: &[String] = &[];
        assert!(allowed_relay(Some("https://IROH.relay.example"), own, none).is_some(), "same relay, normalised");
        assert!(allowed_relay(Some("https://use1-1.relay.n0.iroh.iroh.link./"), own, none).is_none(), "n0 never");
        assert!(allowed_relay(Some("https://other.example/"), own, none).is_none(), "another server: direct only");
        assert!(allowed_relay(Some("https://iroh.relay.example/"), None, none).is_none(), "we advertise none: direct only");
        assert!(allowed_relay(None, own, none).is_none());
        // The sender's own chatmail relay (their mail domain) is allowed:
        // phones on two different relays still meet through the sender's.
        let peer = vec!["Other.Example".to_string()];
        assert!(allowed_relay(Some("https://other.example/"), own, &peer).is_some(), "sender's chatmail relay");
        assert!(allowed_relay(Some("https://iroh.other.example"), None, &peer).is_some(), "iroh.<domain> form, even with no own relay");
        assert!(allowed_relay(Some("http://other.example/"), own, &peer).is_none(), "plain http never");
        assert!(allowed_relay(Some("https://evil.other.example.attacker.net/"), own, &peer).is_none(), "suffix tricks");
        assert!(allowed_relay(Some("https://use1-1.relay.n0.iroh.iroh.link/"), own, &peer).is_none(), "still never n0");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn phones_on_two_relays_meet_through_the_senders_relay() {
        let (_m1, url1, _s1) = iroh035::test_utils::run_relay_server().await.unwrap();
        let (_m2, url2, _s2) = iroh035::test_utils::run_relay_server().await.unwrap();
        let a = Xfer::start(skey(), Some(url1.to_string()), tmp("t8-a"), None).await.unwrap();
        let b = Xfer::start(skey(), Some(url2.to_string()), tmp("t8-b"), None).await.unwrap();
        b.set_connect_timeout(Duration::from_secs(8));
        let src = tmp("src8");
        let bytes = data(700_000, 8);
        std::fs::write(src.join("x.bin"), &bytes).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(10), a.endpoint.home_relay().initialized()).await;
        let mut t = a.offer(&src.join("x.bin"), None, DEFAULT_TTL).await.unwrap();
        t.addrs.clear(); // 4G / CGNAT: no usable direct address
        let refused = b.fetch(&t, &tmp("dst8a"), |_, _| {}).await;
        assert!(matches!(refused, Err(FetchError::Unreachable(_))), "a foreign relay is not dialled by default");
        let out = b.fetch_from(&t, &tmp("dst8b"), &[url1.to_string()], |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(out).unwrap(), bytes);
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_peer_that_accepts_but_never_answers_stalls_out_instead_of_hanging() {
        // The sender that wedges mid-handshake (backgrounded phone, stuck
        // accept loop): the connection opens, the request frame goes out, no
        // response ever comes back. The fetch must give up (resumable), not
        // park xfer_fetch — and the card's busy ring — forever.
        let silent = Endpoint::builder()
            .secret_key(skey())
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let hold = silent.clone();
        tokio::spawn(async move {
            while let Some(incoming) = hold.accept().await {
                tokio::spawn(async move {
                    if let Ok(connecting) = incoming.accept() {
                        if let Ok(_conn) = connecting.await {
                            std::future::pending::<()>().await; // held open, never served
                        }
                    }
                });
            }
        });
        let na = tokio::time::timeout(Duration::from_secs(5), silent.node_addr()).await.unwrap().unwrap();
        let t = Ticket {
            v: 1,
            proto: IROH_PROTO.into(),
            node: silent.node_id().to_string(),
            relay: None,
            addrs: na.direct_addresses.into_iter().collect(),
            hash: "ab".repeat(32),
            size: 7_000_000,
            name: "film.mp4".into(),
            exp: now() + 3600,
            sec: "00".repeat(16),
        };
        let b = node("silent-b", None).await;
        b.set_read_idle(Duration::from_secs(1));
        let started = std::time::Instant::now();
        let r = b.fetch(&t, &tmp("silent-dst"), |_, _| {}).await;
        assert!(matches!(r, Err(FetchError::Io(ref e)) if e == "stalled"), "got {r:?}");
        assert!(started.elapsed() < Duration::from_secs(10), "gave up promptly");
        silent.close().await;
        b.close().await;
    }

    #[test]
    fn ticket_round_trip_and_validation() {
        let t = Ticket {
            v: 1,
            proto: IROH_PROTO.into(),
            node: SecretKey::from_bytes(&[7u8; 32]).public().to_string(),
            relay: Some("https://iroh.relay.example/".into()),
            addrs: vec!["192.168.1.2:1234".parse().unwrap()],
            hash: "ab".repeat(32),
            size: 7_000_000,
            name: "film.mp4".into(),
            exp: 4_000_000_000,
            sec: "cd".repeat(16),
        };
        let s = t.encode();
        assert!(s.starts_with(TICKET_PREFIX));
        assert_eq!(Ticket::decode(&s).unwrap(), t);
        for bad in [
            Ticket { name: "../x".into(), ..t.clone() },
            Ticket { name: ".".into(), ..t.clone() },
            Ticket { hash: "zz".repeat(32), ..t.clone() },
            Ticket { v: 2, ..t.clone() },
            Ticket { relay: Some("::".into()), ..t.clone() },
            Ticket { sec: "x".repeat(200), ..t.clone() },
        ] {
            assert!(Ticket::decode(&bad.encode()).is_err(), "{bad:?}");
        }
        assert!(Ticket::decode("VELTAP2P1:abc").is_err());
        // Tickets from builds before the secret still decode.
        let old = Ticket { sec: String::new(), ..t.clone() };
        assert!(!old.encode().is_empty() && Ticket::decode(&old.encode()).unwrap().sec.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fetches_directly_and_verifies_the_hash() {
        let (a, b) = pair("t1").await;
        let src = tmp("src1");
        let bytes = data(7 * 1024 * 1024 + 333, 1);
        std::fs::write(src.join("big.bin"), &bytes).unwrap();
        let t = Ticket::decode(&a.offer(&src.join("big.bin"), None, DEFAULT_TTL).await.unwrap().encode()).unwrap();
        assert!(t.size > THRESHOLD);
        assert_eq!(t.relay, None);
        assert_eq!(t.sec.len(), 32, "a fresh random secret per ticket");
        let dst = tmp("dst1");
        let mut last = 0;
        let out = b.fetch(&t, &dst, |d, _| last = d).await.unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), bytes);
        assert_eq!(last, t.size);
        assert_eq!(out.file_name().unwrap(), "big.bin");
        assert_eq!(std::fs::read_dir(b.dir.join("part")).unwrap().count(), 0, "no partial left");
        assert!(a.status(&t.hash).unwrap().delivered > 0, "the provider saw a complete delivery");
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_hash_alone_does_not_fetch_a_file() {
        let (a, b) = pair("t7").await;
        let src = tmp("src7");
        std::fs::write(src.join("s.bin"), data(100_000, 9)).unwrap();
        let t = a.offer(&src.join("s.bin"), None, DEFAULT_TTL).await.unwrap();
        let dst = tmp("dst7");
        for sec in [String::new(), "00".repeat(16)] {
            let e = b.fetch(&Ticket { sec, ..t.clone() }, &dst, |_, _| {}).await.unwrap_err();
            assert_eq!(e, FetchError::NotOffered, "wrong or missing secret looks like no offer");
        }
        assert_eq!(a.served.load(Ordering::Relaxed), 0);
        assert!(b.fetch(&t, &dst, |_, _| {}).await.is_ok());
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn interrupted_fetch_resumes_from_the_part_file() {
        let (a, b) = pair("t2").await;
        let src = tmp("src2");
        let bytes = data(3 * 1024 * 1024, 2);
        std::fs::write(src.join("r.bin"), &bytes).unwrap();
        let t = a.offer(&src.join("r.bin"), None, DEFAULT_TTL).await.unwrap();
        let dst = tmp("dst2");
        // An earlier run got the first 1 MB, then the link dropped.
        let have = 1024 * 1024;
        std::fs::create_dir_all(b.dir.join("part")).unwrap();
        std::fs::write(b.dir.join("part").join(format!("{}.part", t.hash)), &bytes[..have]).unwrap();
        let out = b.fetch(&t, &dst, |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), bytes);
        assert_eq!(a.served.load(Ordering::Relaxed), (bytes.len() - have) as u64, "only the rest was sent");
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hash_mismatch_is_rejected_and_the_partial_deleted() {
        let (a, b) = pair("t3").await;
        let src = tmp("src3");
        std::fs::write(src.join("h.bin"), data(512 * 1024, 3)).unwrap();
        let t = a.offer(&src.join("h.bin"), None, DEFAULT_TTL).await.unwrap();
        // The source may change freely now (a copy is offered); corrupt the copy.
        std::fs::write(a.status(&t.hash).unwrap().path, data(512 * 1024, 4)).unwrap();
        let dst = tmp("dst3");
        assert_eq!(b.fetch(&t, &dst, |_, _| {}).await.unwrap_err(), FetchError::HashMismatch);
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0, "nothing left behind");
        assert_eq!(std::fs::read_dir(b.dir.join("part")).unwrap().count(), 0, "no partial either");
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn too_large_tickets_are_refused_before_connecting() {
        let b = node("t8", None).await;
        let t = Ticket {
            v: 1,
            proto: IROH_PROTO.into(),
            node: skey().public().to_string(),
            relay: None,
            addrs: vec![],
            hash: "ab".repeat(32),
            size: MAX_FILE + 1,
            name: "huge.bin".into(),
            exp: now() + 60,
            sec: "cd".repeat(16),
        };
        let e = b.fetch(&t, &tmp("dst8"), |_, _| {}).await.unwrap_err();
        assert_eq!(e, FetchError::TooLarge);
        assert!(e.wants_email());
        assert!(!FetchError::NoSpace(1).wants_email(), "a full disk needs the user");
        #[cfg(unix)]
        assert!(free_space(&std::env::temp_dir()).is_some());
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn expired_withdrawn_unreachable_and_other_proto_fall_back_to_email() {
        let (a, b) = pair("t4").await;
        let src = tmp("src4");
        std::fs::write(src.join("e.bin"), data(1000, 5)).unwrap();
        let dst = tmp("dst4");

        let t = a.offer(&src.join("e.bin"), None, DEFAULT_TTL).await.unwrap();
        let e = b.fetch(&Ticket { exp: 1, ..t.clone() }, &dst, |_, _| {}).await.unwrap_err();
        assert_eq!(e, FetchError::Expired);
        assert!(e.wants_email());

        let e = b.fetch(&Ticket { proto: "iroh-1".into(), ..t.clone() }, &dst, |_, _| {}).await.unwrap_err();
        assert!(matches!(e, FetchError::OtherProto(_)) && e.wants_email());

        let stored = a.status(&t.hash).unwrap().path;
        a.withdraw(&t.hash);
        assert!(!stored.exists(), "withdraw deletes the stored copy");
        let e = b.fetch(&t, &dst, |_, _| {}).await.unwrap_err();
        assert_eq!(e, FetchError::NotOffered);
        assert!(e.wants_email());

        // Sender offline: no relay advertised, so no path at all (no n0).
        let gone = a.offer(&src.join("e.bin"), None, DEFAULT_TTL).await.unwrap();
        a.close().await;
        b.set_connect_timeout(Duration::from_secs(3));
        let e = b.fetch(&gone, &dst, |_, _| {}).await.unwrap_err();
        assert!(matches!(e, FetchError::Unreachable(_)), "{e:?}");
        assert!(e.wants_email());
        assert!(!FetchError::Io("x".into()).wants_email(), "a broken stream resumes over iroh");
        b.close().await;
    }

    /// Seal-time sidecar: offer links the sealed upload. A sidecar on
    /// plaintext, or one that is not lowercase hex, still reseals.
    #[test]
    fn sealed_sidecar_is_linked_plaintext_sidecar_is_not() {
        let k = akey(0x31);
        let src = tmp("linksrc");
        let bytes = data(64 * 1024, 3);
        std::fs::write(src.join("plain.bin"), &bytes).unwrap();
        let upload = src.join("up.bin");
        velta_attachment::encrypt_file(&k, &src.join("plain.bin"), &upload).unwrap();
        let mut h = Sha256::new();
        h.update(&bytes);
        let dig = h.finalize();
        let expect = HEXLOWER.encode(&dig);
        write_plaintext_hash(&upload, &dig);

        let (hash, len, stored) = store_copy(&upload, &tmp("linkout"), Some(&k)).unwrap();
        assert_eq!(hash, expect);
        assert_eq!(len, bytes.len() as u64);
        assert_eq!(std::fs::read(&stored).unwrap(), std::fs::read(&upload).unwrap());
        assert_eq!(AttachmentReader::open(&stored, Some(&k)).unwrap().read_all().unwrap(), bytes);
        std::fs::remove_file(&stored).unwrap();
        assert!(upload.exists(), "dropping the offer name keeps the upload");

        write_plaintext_hash(&src.join("plain.bin"), &dig);
        let (_, _, resealed) = store_copy(&src.join("plain.bin"), &tmp("plainout"), Some(&k)).unwrap();
        assert!(velta_attachment::is_encrypted(&resealed).unwrap());
        assert_ne!(std::fs::read(&resealed).unwrap(), std::fs::read(src.join("plain.bin")).unwrap());

        std::fs::write(sha_sidecar(&upload), "A".repeat(64)).unwrap();
        let (_, _, slow) = store_copy(&upload, &tmp("badside"), Some(&k)).unwrap();
        assert_ne!(std::fs::read(&slow).unwrap(), std::fs::read(&upload).unwrap());

        let (h2, len2, linked) = store_copy(&src.join("plain.bin"), &tmp("keyless"), None).unwrap();
        assert_eq!(h2, expect);
        assert_eq!(len2, bytes.len() as u64);
        assert_eq!(std::fs::read(linked).unwrap(), bytes);
    }

    /// Offers survive a restart of the sender's app, sealed at rest.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn offers_survive_a_restart_and_rest_sealed() {
        let dir = tmp("t9-a");
        let k = akey(0x11);
        let secret = load_or_create_key(&dir, Some(&k)).unwrap();
        assert!(velta_attachment::is_encrypted(&dir.join("identity.key")).unwrap(), "identity key sealed");
        assert_eq!(load_or_create_key(&dir, Some(&k)).unwrap().public(), secret.public(), "stable node id");
        let a = Xfer::start(secret.clone(), None, dir.clone(), Some(k.clone())).await.unwrap();
        // The composer's uploads copy is VLTA ciphertext: the receiver must
        // get the plaintext.
        let src = tmp("src9");
        let bytes = data(2 * 1024 * 1024 + 5, 11);
        std::fs::write(src.join("plain.bin"), &bytes).unwrap();
        velta_attachment::encrypt_file(&k, &src.join("plain.bin"), &src.join("upload.bin")).unwrap();
        let t = a.offer(&src.join("upload.bin"), Some("photo.raw"), DEFAULT_TTL).await.unwrap();
        assert_eq!(t.name, "photo.raw");
        assert_eq!(t.size, bytes.len() as u64, "plaintext size, not the VLTA size");
        assert!(velta_attachment::is_encrypted(&dir.join("offers.json")).unwrap(), "offer list sealed");
        assert!(velta_attachment::is_encrypted(&a.status(&t.hash).unwrap().path).unwrap(), "stored copy sealed");
        a.close().await;
        drop(a);

        let a2 = Xfer::start(secret, None, dir.clone(), Some(k.clone())).await.unwrap();
        let t2 = Ticket { addrs: a2.endpoint.node_addr().await.unwrap().direct_addresses.into_iter().collect(), ..t.clone() };
        let b = node("t9-b", Some(akey(0x22))).await;
        let out = b.fetch(&t2, &tmp("dst9"), |_, _| {}).await.unwrap();
        assert!(velta_attachment::is_encrypted(&out).unwrap(), "received file sealed under the receiver's key");
        assert_eq!(AttachmentReader::open(&out, Some(&akey(0x22))).unwrap().read_all().unwrap(), bytes);
        assert!(a2.status(&t.hash).unwrap().delivered > 0);
        a2.close().await;
        drop(a2);
        let a3 = Xfer::start(skey(), None, dir, Some(k)).await.unwrap();
        assert!(a3.status(&t.hash).unwrap().delivered > 0, "delivery is remembered");
        a3.close().await;
        b.close().await;
    }

    #[test]
    fn keyless_identity_is_owner_only_and_stale_parts_go() {
        let dir = tmp("t10");
        load_or_create_key(&dir, None).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("identity.key")).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "owner-only: {mode:o}");
        }
        let parts = dir.join("part");
        std::fs::create_dir_all(&parts).unwrap();
        std::fs::write(parts.join("x.part"), b"old").unwrap();
        clean_parts(&parts, Duration::ZERO);
        assert_eq!(std::fs::read_dir(&parts).unwrap().count(), 0);
    }

    /// Across networks: no direct address in the ticket, so the bytes must go
    /// through the relay the chatmail server advertises (a local iroh 0.35
    /// relay here, the same server software chatmail relays run).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fetches_through_the_advertised_relay_without_direct_addresses() {
        let (_map, url, _server) = iroh035::test_utils::run_relay_server().await.unwrap();
        let relay = Some(url.to_string());
        let a = Xfer::start(skey(), relay.clone(), tmp("t6-a"), None).await.unwrap();
        let b = Xfer::start(skey(), relay.clone(), tmp("t6-b"), None).await.unwrap();
        let src = tmp("src6");
        let bytes = data(1024 * 1024 + 7, 7);
        std::fs::write(src.join("via.bin"), &bytes).unwrap();
        // Let the provider register with its home relay first.
        let _ = tokio::time::timeout(Duration::from_secs(10), a.endpoint.home_relay().initialized()).await;
        let mut t = a.offer(&src.join("via.bin"), None, DEFAULT_TTL).await.unwrap();
        assert_eq!(t.relay, relay, "the ticket names the advertised relay");
        t.addrs.clear();
        let out = b.fetch(&t, &tmp("dst6"), |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(out).unwrap(), bytes);
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_same_ticket_serves_several_devices_until_withdrawn() {
        let a = node("t5", None).await;
        let src = tmp("src5");
        let bytes = data(200_000, 6);
        std::fs::write(src.join("m.bin"), &bytes).unwrap();
        let t = a.offer(&src.join("m.bin"), None, DEFAULT_TTL).await.unwrap();
        for i in 0..3 {
            let d = node(&format!("t5-{i}"), None).await;
            let out = d.fetch(&t, &tmp(&format!("dst5-{i}")), |_, _| {}).await.unwrap();
            assert_eq!(std::fs::read(out).unwrap(), bytes);
            d.close().await;
        }
        assert_eq!(a.sweep(), 0);
        a.close().await;
    }

    /// Desktop regression: the boot sweep's xfer_status runs before anything
    /// bound the endpoint. It used to deadlock the state lock, so the
    /// composer's health check and xfer_offer then hung forever.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_cold_status_call_then_health_and_offer_do_not_deadlock() {
        let st = XferState::default();
        let dir = tmp("cold");
        let a = tokio::time::timeout(Duration::from_secs(20), st.running_or_start(None, dir.clone()))
            .await
            .expect("cold xfer_status deadlocked")
            .unwrap();
        let b = tokio::time::timeout(Duration::from_secs(5), st.ensure_at(None, dir.clone()))
            .await
            .expect("ensure after a cold status deadlocked")
            .unwrap();
        assert_eq!(a.node_id(), b.node_id(), "one endpoint, reused");
        assert_eq!(st.running().await.map(|x| x.node_id()), Some(a.node_id()));
        let src = tmp("src-cold");
        let bytes = data(THRESHOLD as usize + 4099, 9);
        std::fs::write(src.join("big.mp4"), &bytes).unwrap();
        let t = tokio::time::timeout(Duration::from_secs(30), b.offer(&src.join("big.mp4"), None, DEFAULT_TTL))
            .await
            .expect("offer hung")
            .unwrap();
        let again = tokio::time::timeout(Duration::from_secs(5), st.running_or_start(None, dir.clone()))
            .await
            .expect("status after an offer deadlocked")
            .unwrap();
        assert!(again.status(&t.hash).is_some(), "the offer is listed");
        let r = node("cold-recv", None).await;
        let out = r.fetch(&t, &tmp("dst-cold"), |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(out).unwrap(), bytes);
        r.close().await;
        a.close().await;
    }
}
