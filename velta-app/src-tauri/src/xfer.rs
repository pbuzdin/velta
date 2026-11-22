//! #470: automatic iroh file transfer for Velta ↔ Velta 1:1 chats.
//!
//! An attachment over [`THRESHOLD`] to a Velta contact is not mailed. The
//! sender keeps the file, offers it here and mails a small end-to-end
//! encrypted message carrying a [`Ticket`] (node id, SHA-256, size, expiry,
//! iroh protocol version, the sender's iroh relay). The receiver fetches it
//! over iroh: direct when reachable, otherwise through the chatmail relay's
//! advertised iroh relay. Fetches are chunked, resumable (`.part` file) and
//! hash-verified. Every failure that the email path can fix (expired ticket,
//! sender unreachable, other iroh version) is a [`FetchError`] whose
//! [`FetchError::wants_email`] is true: the caller then asks the sender to
//! re-send the file as a normal attachment.
//!
//! iroh version: 0.35, the one core and every chatmail relay's iroh relay
//! speak today (relays broke wire compatibility in 0.91). The ticket names
//! the version so a later 1.x path can be negotiated.
//!
//! Relays: ONLY the relay the chatmail server advertises. With none
//! advertised the endpoint runs with relays disabled (direct paths only) and
//! an unreachable sender falls back to email. n0's public relays are never
//! used: their 0.35 relays shut down on 2026-12-31.

use std::{
    collections::HashMap,
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
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Attachments strictly larger than this go over iroh (6 MB).
pub const THRESHOLD: u64 = 6 * 1024 * 1024;
pub const ALPN: &[u8] = b"/velta/xfer/1";
pub const TICKET_PREFIX: &str = "VXFER1:";
/// The iroh wire this build speaks for transfers.
pub const IROH_PROTO: &str = "iroh-0.35";
/// Default ticket lifetime (the sender re-sends by email after this).
pub const DEFAULT_TTL: Duration = Duration::from_secs(24 * 3600);
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
        t.node.parse::<NodeId>().context("bad node id")?;
        if let Some(r) = &t.relay {
            r.parse::<RelayUrl>().context("bad relay url")?;
        }
        if t.name.is_empty() || t.name.len() > 255 || t.name.contains(['/', '\\', '\0']) || t.name == ".." {
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
    /// The sender no longer offers this file (deleted, restarted, expired there).
    NotOffered,
    /// The bytes did not hash to the ticket; the partial is deleted.
    HashMismatch,
    /// Local I/O or a broken stream; retrying resumes from the `.part`.
    Io(String),
}

impl FetchError {
    /// True when the email fallback (sender re-sends as an attachment) is the
    /// right answer. Io errors resume over iroh instead.
    pub fn wants_email(&self) -> bool {
        !matches!(self, FetchError::Io(_))
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

/// Route decision for one attachment (the JS side mirrors it in iroh-xfer.js).
pub fn use_iroh(enabled: bool, size: u64, one_to_one: bool, peer_is_velta: bool) -> bool {
    enabled && one_to_one && peer_is_velta && size > THRESHOLD
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug, Serialize, Deserialize)]
struct Request {
    hash: String,
    offset: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Response {
    ok: bool,
    #[serde(default)]
    err: String,
    #[serde(default)]
    size: u64,
}

struct Offer {
    path: PathBuf,
    size: u64,
    exp: u64,
}

/// One transfer endpoint: offers files (provider) and fetches tickets.
pub struct Xfer {
    endpoint: Endpoint,
    relay: Option<String>,
    offers: Mutex<HashMap<String, Offer>>,
    /// Bytes streamed out by the provider (tests check resume with it).
    pub served: AtomicU64,
    connect_timeout_ms: AtomicU64,
}

impl Xfer {
    /// Binds an endpoint that uses `relay` (the chatmail relay's advertised
    /// iroh relay) or no relay at all.
    pub async fn start(secret: SecretKey, relay: Option<String>) -> Result<Arc<Xfer>> {
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
        let x = Arc::new(Xfer {
            endpoint,
            relay,
            offers: Mutex::new(HashMap::new()),
            served: AtomicU64::new(0),
            connect_timeout_ms: AtomicU64::new(20_000),
        });
        let me = x.clone();
        tokio::spawn(async move { me.accept_loop().await });
        Ok(x)
    }

    /// How long a fetch waits for a path before calling the sender unreachable.
    pub fn set_connect_timeout(&self, d: Duration) {
        self.connect_timeout_ms.store(d.as_millis() as u64, Ordering::Relaxed);
    }

    pub fn node_id(&self) -> NodeId {
        self.endpoint.node_id()
    }

    /// Offers `path` and returns its ticket (valid for `ttl`).
    pub async fn offer(&self, path: &Path, ttl: Duration) -> Result<Ticket> {
        let size = tokio::fs::metadata(path).await?.len();
        let hash = sha256_file(path, None).await?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        let exp = now() + ttl.as_secs();
        let addrs = match tokio::time::timeout(Duration::from_secs(5), self.endpoint.node_addr()).await {
            Ok(Ok(na)) => na.direct_addresses.into_iter().collect(),
            _ => Vec::new(),
        };
        self.offers.lock().unwrap().insert(hash.clone(), Offer { path: path.to_path_buf(), size, exp });
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
        })
    }

    /// Stops offering a file (all receivers fetched it, or it expired).
    pub fn withdraw(&self, hash: &str) {
        self.offers.lock().unwrap().remove(hash);
    }

    /// Drops expired offers; returns how many went.
    pub fn sweep(&self) -> usize {
        let t = now();
        let mut o = self.offers.lock().unwrap();
        let before = o.len();
        o.retain(|_, v| v.exp > t);
        before - o.len()
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

    /// Provider side: one request per bi stream, `{hash, offset}` → header +
    /// the file from `offset`.
    async fn serve(&self, conn: Connection) -> Result<()> {
        loop {
            let Ok((mut send, mut recv)) = conn.accept_bi().await else { return Ok(()) };
            let req: Request = serde_json::from_slice(&read_frame(&mut recv).await?)?;
            let offer = {
                let o = self.offers.lock().unwrap();
                o.get(&req.hash).map(|o| (o.path.clone(), o.size, o.exp))
            };
            let resp = match offer {
                None => Response { ok: false, err: "not-offered".into(), size: 0 },
                Some((_, _, exp)) if exp <= now() => Response { ok: false, err: "expired".into(), size: 0 },
                Some((_, size, _)) if req.offset > size => Response { ok: false, err: "range".into(), size },
                Some((_, size, _)) => Response { ok: true, err: String::new(), size },
            };
            write_frame(&mut send, &serde_json::to_vec(&resp)?).await?;
            if resp.ok {
                let (path, ..) = offer.unwrap();
                let mut f = tokio::fs::File::open(&path).await?;
                f.seek(std::io::SeekFrom::Start(req.offset)).await?;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    let n = f.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    send.write_all(&buf[..n]).await?;
                    self.served.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
            send.finish()?;
        }
    }

    /// Fetches `ticket` into `dir/<name>`, resuming a `<name>.<hash8>.part`
    /// left by an interrupted run. `progress(done, size)` is called per chunk.
    pub async fn fetch(
        &self,
        ticket: &Ticket,
        dir: &Path,
        mut progress: impl FnMut(u64, u64),
    ) -> std::result::Result<PathBuf, FetchError> {
        if ticket.proto != IROH_PROTO {
            return Err(FetchError::OtherProto(ticket.proto.clone()));
        }
        if ticket.exp <= now() {
            return Err(FetchError::Expired);
        }
        let io = |e: anyhow::Error| FetchError::Io(format!("{e:#}"));
        let node: NodeId = ticket.node.parse().map_err(|_| FetchError::Unreachable("bad node id".into()))?;
        let mut addr = NodeAddr::new(node).with_direct_addresses(ticket.addrs.iter().copied());
        if let Some(r) = &ticket.relay {
            // The sender's relay is reachable only if it is the kind we allow.
            let url: RelayUrl = r.parse().map_err(|_| FetchError::Unreachable("bad relay url".into()))?;
            addr = addr.with_relay_url(url);
        }
        let conn = match tokio::time::timeout(Duration::from_millis(self.connect_timeout_ms.load(Ordering::Relaxed)), self.endpoint.connect(addr, ALPN)).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => return Err(FetchError::Unreachable(format!("{e:#}"))),
            Err(_) => return Err(FetchError::Unreachable("timed out".into())),
        };

        tokio::fs::create_dir_all(dir).await.map_err(|e| io(e.into()))?;
        let part = dir.join(format!("{}.{}.part", ticket.name, &ticket.hash[..8]));
        let mut offset = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        if offset > ticket.size {
            let _ = tokio::fs::remove_file(&part).await;
            offset = 0;
        }
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| io(e.into()))?;
        write_frame(&mut send, &serde_json::to_vec(&Request { hash: ticket.hash.clone(), offset }).unwrap())
            .await
            .map_err(io)?;
        send.finish().map_err(|e| io(e.into()))?;
        let resp: Response = serde_json::from_slice(&read_frame(&mut recv).await.map_err(io)?)
            .map_err(|e| io(e.into()))?;
        if !resp.ok {
            return Err(match resp.err.as_str() {
                "expired" => FetchError::Expired,
                "not-offered" => FetchError::NotOffered,
                other => FetchError::Io(other.to_string()),
            });
        }
        if resp.size != ticket.size {
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
            let n = match recv.read(&mut buf).await {
                Ok(Some(n)) => n,
                Ok(None) => break,
                Err(e) => {
                    let _ = f.flush().await;
                    return Err(FetchError::Io(e.to_string())); // the .part stays: resume next time
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
        let out = unique_path(dir, &ticket.name);
        tokio::fs::rename(&part, &out).await.map_err(|e| io(e.into()))?;
        Ok(out)
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

// -- Tauri commands -----------------------------------------------------------

/// The app's transfer endpoint, (re)bound for the current advertised relay.
#[derive(Default)]
pub struct XferState {
    inner: tokio::sync::Mutex<Option<Arc<Xfer>>>,
}

fn load_or_create_key(dir: &Path) -> Result<SecretKey> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("identity.key");
    if let Ok(hex) = std::fs::read_to_string(&path) {
        let b: [u8; 32] = HEXLOWER
            .decode(hex.trim().as_bytes())?
            .try_into()
            .map_err(|_| anyhow::anyhow!("bad transfer key"))?;
        return Ok(SecretKey::from_bytes(&b));
    }
    let b: [u8; 32] = crate::random_bytes();
    std::fs::write(&path, HEXLOWER.encode(&b))?;
    Ok(SecretKey::from_bytes(&b))
}

async fn ensure(state: &XferState, app: &tauri::AppHandle, relay: Option<String>) -> Result<Arc<Xfer>, String> {
    use tauri::Manager;
    let mut g = state.inner.lock().await;
    if let Some(x) = g.as_ref() {
        if x.relay == relay {
            return Ok(x.clone());
        }
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("xfer");
    let key = load_or_create_key(&dir).map_err(|e| e.to_string())?;
    let new = Xfer::start(key, relay).await.map_err(|e| format!("{e:#}"))?;
    if let Some(old) = g.replace(new.clone()) {
        // Same key, new relay: carry the open offers over.
        let moved: Vec<(String, Offer)> = old.offers.lock().unwrap().drain().collect();
        new.offers.lock().unwrap().extend(moved);
        old.close().await;
    }
    Ok(new)
}

/// Offers a file for an iroh transfer; returns the ticket string to mail.
/// `relay` is the chatmail relay's advertised iroh relay (get_server_metadata),
/// or null for direct paths only.
#[tauri::command]
pub async fn xfer_offer(
    state: tauri::State<'_, XferState>,
    app: tauri::AppHandle,
    path: String,
    relay: Option<String>,
    ttl_secs: Option<u64>,
) -> Result<String, String> {
    let x = ensure(&state, &app, relay).await?;
    x.sweep();
    let ttl = ttl_secs.map(Duration::from_secs).unwrap_or(DEFAULT_TTL);
    Ok(x.offer(Path::new(&path), ttl).await.map_err(|e| format!("{e:#}"))?.encode())
}

/// Fetches a ticket into the accounts dir. Returns `{path}` on success, or
/// `{error, email}` where `email: true` means "ask the sender to mail it".
#[tauri::command]
pub async fn xfer_fetch(
    state: tauri::State<'_, XferState>,
    app: tauri::AppHandle,
    ticket: String,
    relay: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let t = match Ticket::decode(&ticket) {
        Ok(t) => t,
        Err(e) => return Ok(serde_json::json!({ "error": format!("{e:#}"), "email": true })),
    };
    let x = ensure(&state, &app, relay).await?;
    let dir = crate::accounts_dir(&app).join("xfer-in");
    let hash = t.hash.clone();
    let mut last = 0u64;
    let res = x
        .fetch(&t, &dir, |done, size| {
            if done == size || done - last >= 1024 * 1024 {
                last = done;
                let _ = app.emit("xfer-progress", serde_json::json!({ "hash": hash, "done": done, "size": size }));
            }
        })
        .await;
    Ok(match res {
        Ok(p) => serde_json::json!({ "path": p.to_string_lossy() }),
        Err(e) => serde_json::json!({ "error": e.to_string(), "email": e.wants_email() }),
    })
}

/// Stops offering a file (every known receiver has it, or it was mailed).
#[tauri::command]
pub async fn xfer_withdraw(state: tauri::State<'_, XferState>, hash: String) -> Result<(), String> {
    if let Some(x) = state.inner.lock().await.as_ref() {
        x.withdraw(&hash);
    }
    Ok(())
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
pub async fn sha256_file(path: &Path, limit: Option<u64>) -> Result<String> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut left = limit.unwrap_or(u64::MAX);
    while left > 0 {
        let want = buf.len().min(left.min(usize::MAX as u64) as usize);
        let n = f.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(HEXLOWER.encode(&h.finalize()))
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

    async fn pair() -> (Arc<Xfer>, Arc<Xfer>) {
        let key = || SecretKey::from_bytes(&crate::random_bytes());
        (Xfer::start(key(), None).await.unwrap(), Xfer::start(key(), None).await.unwrap())
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
        };
        let s = t.encode();
        assert!(s.starts_with(TICKET_PREFIX));
        assert_eq!(Ticket::decode(&s).unwrap(), t);
        for bad in [
            Ticket { name: "../x".into(), ..t.clone() },
            Ticket { hash: "zz".repeat(32), ..t.clone() },
            Ticket { v: 2, ..t.clone() },
            Ticket { relay: Some("::".into()), ..t.clone() },
        ] {
            assert!(Ticket::decode(&bad.encode()).is_err(), "{bad:?}");
        }
        assert!(Ticket::decode("VELTAP2P1:abc").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fetches_directly_and_verifies_the_hash() {
        let (a, b) = pair().await;
        let src = tmp("src1");
        let bytes = data(7 * 1024 * 1024 + 333, 1);
        std::fs::write(src.join("big.bin"), &bytes).unwrap();
        let t = Ticket::decode(&a.offer(&src.join("big.bin"), DEFAULT_TTL).await.unwrap().encode()).unwrap();
        assert!(t.size > THRESHOLD);
        assert_eq!(t.relay, None);
        let dst = tmp("dst1");
        let mut last = 0;
        let out = b.fetch(&t, &dst, |d, _| last = d).await.unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), bytes);
        assert_eq!(last, t.size);
        assert_eq!(out.file_name().unwrap(), "big.bin");
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn interrupted_fetch_resumes_from_the_part_file() {
        let (a, b) = pair().await;
        let src = tmp("src2");
        let bytes = data(3 * 1024 * 1024, 2);
        std::fs::write(src.join("r.bin"), &bytes).unwrap();
        let t = a.offer(&src.join("r.bin"), DEFAULT_TTL).await.unwrap();
        let dst = tmp("dst2");
        // An earlier run got the first 1 MB, then the link dropped.
        let have = 1024 * 1024;
        std::fs::write(dst.join(format!("r.bin.{}.part", &t.hash[..8])), &bytes[..have]).unwrap();
        let out = b.fetch(&t, &dst, |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), bytes);
        assert_eq!(a.served.load(Ordering::Relaxed), (bytes.len() - have) as u64, "only the rest was sent");
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hash_mismatch_is_rejected_and_the_partial_deleted() {
        let (a, b) = pair().await;
        let src = tmp("src3");
        std::fs::write(src.join("h.bin"), data(512 * 1024, 3)).unwrap();
        let t = a.offer(&src.join("h.bin"), DEFAULT_TTL).await.unwrap();
        std::fs::write(src.join("h.bin"), data(512 * 1024, 4)).unwrap(); // same size, other bytes
        let dst = tmp("dst3");
        assert_eq!(b.fetch(&t, &dst, |_, _| {}).await.unwrap_err(), FetchError::HashMismatch);
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0, "nothing left behind");
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn expired_withdrawn_unreachable_and_other_proto_fall_back_to_email() {
        let (a, b) = pair().await;
        let src = tmp("src4");
        std::fs::write(src.join("e.bin"), data(1000, 5)).unwrap();
        let dst = tmp("dst4");

        let t = a.offer(&src.join("e.bin"), DEFAULT_TTL).await.unwrap();
        let e = b.fetch(&Ticket { exp: 1, ..t.clone() }, &dst, |_, _| {}).await.unwrap_err();
        assert_eq!(e, FetchError::Expired);
        assert!(e.wants_email());

        let e = b.fetch(&Ticket { proto: "iroh-1".into(), ..t.clone() }, &dst, |_, _| {}).await.unwrap_err();
        assert!(matches!(e, FetchError::OtherProto(_)) && e.wants_email());

        a.withdraw(&t.hash);
        let e = b.fetch(&t, &dst, |_, _| {}).await.unwrap_err();
        assert_eq!(e, FetchError::NotOffered);
        assert!(e.wants_email());

        // Sender offline: no relay advertised, so no path at all (no n0).
        let gone = a.offer(&src.join("e.bin"), DEFAULT_TTL).await.unwrap();
        a.close().await;
        b.set_connect_timeout(Duration::from_secs(3));
        let b2 = b;
        let e = b2.fetch(&gone, &dst, |_, _| {}).await.unwrap_err();
        assert!(matches!(e, FetchError::Unreachable(_)), "{e:?}");
        assert!(e.wants_email());
        assert!(!FetchError::Io("x".into()).wants_email(), "a broken stream resumes over iroh");
        b2.close().await;
    }

    /// Across networks: no direct address in the ticket, so the bytes must go
    /// through the relay the chatmail server advertises (a local iroh 0.35
    /// relay here, the same server software chatmail relays run).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fetches_through_the_advertised_relay_without_direct_addresses() {
        let (_map, url, _server) = iroh035::test_utils::run_relay_server().await.unwrap();
        let relay = Some(url.to_string());
        let key = || SecretKey::from_bytes(&crate::random_bytes());
        let a = Xfer::start(key(), relay.clone()).await.unwrap();
        let b = Xfer::start(key(), relay.clone()).await.unwrap();
        let src = tmp("src6");
        let bytes = data(1024 * 1024 + 7, 7);
        std::fs::write(src.join("via.bin"), &bytes).unwrap();
        // Let the provider register with its home relay first.
        let _ = tokio::time::timeout(Duration::from_secs(10), a.endpoint.home_relay().initialized()).await;
        let mut t = a.offer(&src.join("via.bin"), DEFAULT_TTL).await.unwrap();
        assert_eq!(t.relay, relay, "the ticket names the advertised relay");
        t.addrs.clear();
        let out = b.fetch(&t, &tmp("dst6"), |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(out).unwrap(), bytes);
        a.close().await;
        b.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_same_ticket_serves_several_devices_until_withdrawn() {
        let key = || SecretKey::from_bytes(&crate::random_bytes());
        let a = Xfer::start(key(), None).await.unwrap();
        let src = tmp("src5");
        let bytes = data(200_000, 6);
        std::fs::write(src.join("m.bin"), &bytes).unwrap();
        let t = a.offer(&src.join("m.bin"), DEFAULT_TTL).await.unwrap();
        for i in 0..3 {
            let d = Xfer::start(key(), None).await.unwrap();
            let out = d.fetch(&t, &tmp(&format!("dst5-{i}")), |_, _| {}).await.unwrap();
            assert_eq!(std::fs::read(out).unwrap(), bytes);
            d.close().await;
        }
        assert_eq!(a.sweep(), 0);
        a.close().await;
    }
}
