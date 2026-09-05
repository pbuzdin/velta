//! Local-only P2P chat over iroh.
//!
//! A self-contained transport that has nothing to do with the Delta Chat core:
//! two Velta devices on the same network discover each other via an exchanged
//! invite ticket (QR / paste) and talk JSON-lines frames over one bidirectional
//! QUIC stream per session, following the pattern of Delta Chat's backup
//! transfer (`core/src/imex/transfer.rs`).
//!
//! Security model:
//! - Transport encryption is iroh's QUIC TLS; the endpoint identity is the
//!   ed25519 key whose public half is the [`NodeId`].
//! - The invite ticket carries `NodeId` + direct addresses + a pairing token,
//!   so scanning the QR authenticates both directions out-of-band: the peer's
//!   NodeId is pinned from the QR, and the pairing token proves the joiner
//!   actually scanned it. The token is never broadcast — LAN beacons carry
//!   only display names and addresses (discovery, not authorization).
//! - Pairing without a ticket (Nearby tap) sends an empty-token hello and
//!   only completes after the receiving user approves the request in the UI.
//! - Frames from NodeIds that were never paired are rejected.
//!
//! Persistence lives in `<AppLocalData>/p2p/`: `identity.key` (hex secret
//! key), `profile.json` (display name), `peers.json` and one
//! `messages-<node_id>.jsonl` per peer.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context as _, Result};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use iroh::{endpoint::{Connection, RecvStream, SendStream, TransportConfig}, Endpoint, NodeAddr, NodeId, RelayMode, SecretKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// ALPN protocol identifier for the Velta local chat protocol.
const ALPN: &[u8] = b"/velta/p2p/1";
/// Ticket prefix, mirrors the DCBACKUP style of out-of-band tickets.
const TICKET_PREFIX: &str = "VELTAP2P1:";
/// Compact binary ticket format tag (first payload byte).
const TICKET_FMT_BIN: u8 = 2;
/// Maximum size of a single JSON frame.
const MAX_FRAME: usize = 256 * 1024;
/// Connect attempt timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long handshake reads may take.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Idle timeout for long-lived chat connections.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the receiving side waits for the user to approve a pairing
/// request (and the requesting side for the resulting welcome).
const PAIR_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// UDP port for LAN beacons (presence + pairing credential broadcast).
const BEACON_PORT: u16 = 53717;
/// Beacon broadcast interval.
const BEACON_INTERVAL: Duration = Duration::from_secs(2);
/// A neighbor heard this long ago is considered gone.
const NEIGHBOR_TTL: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Chat frame exchanged on an established session (newline-delimited JSON).
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Frame {
    /// A chat message from the remote peer.
    Msg { id: String, ts: u64, text: String },
    /// Acknowledgement for a message delivered earlier.
    Ack { id: String },
    /// Session keepalive / opening frame.
    Ping,
}

/// Pairing handshake opener frame (only accepted from a not-yet-paired NodeId).
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Hello {
    Hello {
        token: String,
        name: String,
        addrs: Vec<String>,
    },
    Welcome { name: String },
}

/// Out-of-band invite ticket (the QR payload after [`TICKET_PREFIX`]).
#[derive(Debug, Serialize, Deserialize)]
struct Ticket {
    v: u8,
    node_id: String,
    addrs: Vec<String>,
    token: String,
    name: String,
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

/// A chat message as stored in memory / on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredMsg {
    id: String,
    ts: u64,
    /// "in" or "out"
    dir: String,
    /// "queued", "sent" or "acked" (out only); "acked" for inbound.
    state: String,
    text: String,
}

/// Peer row in `peers.json`.
#[derive(Debug, Serialize, Deserialize)]
struct PersistedPeer {
    node_id: String,
    name: String,
    addrs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PeersFile {
    peers: Vec<PersistedPeer>,
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

/// A handle to one live session task; frames are funneled through `tx` so the
/// session task is the single writer on its QUIC send stream.
struct LiveHandle {
    id: u64,
    tx: mpsc::UnboundedSender<Frame>,
}

struct Peer {
    name: String,
    addrs: Vec<SocketAddr>,
    live: Vec<LiveHandle>,
    connecting: bool,
    queued: Vec<StoredMsg>,
    msgs: Vec<StoredMsg>,
}

impl Peer {
    fn online(&self) -> bool {
        !self.live.is_empty()
    }
}

struct Inner {
    name: String,
    /// Pairing token of the currently advertised invite (rotated by each new
    /// invite). QR-proof only — never broadcast on the LAN.
    token: String,
    peers: HashMap<NodeId, Peer>,
    /// Devices heard on the LAN via UDP beacon but not yet paired.
    nearby: HashMap<NodeId, Nearby>,
    /// Inbound pairing requests awaiting user approval.
    pair_requests: HashMap<NodeId, PairRequest>,
}

/// A beacon-advertised device seen recently on the LAN.
struct Nearby {
    name: String,
    addrs: Vec<SocketAddr>,
    last_seen: std::time::Instant,
}

/// A pending inbound pairing request: resolved through the UI.
struct PairRequest {
    #[allow(dead_code)] // kept for diagnostics; the decision rides `tx`
    name: String,
    tx: tokio::sync::oneshot::Sender<bool>,
}

impl Nearby {
    fn fresh(&self) -> bool {
        self.last_seen.elapsed() < NEIGHBOR_TTL
    }
}

/// Where UI notifications go.
pub enum Sink {
    /// Emit `p2p-event` to the WebView.
    Tauri(tauri::AppHandle),
    /// Forward events to a test observer.
    #[cfg_attr(not(test), allow(dead_code))]
    Test(std::sync::mpsc::Sender<Value>),
}

impl Sink {
    fn emit(&self, value: Value) {
        match self {
            Sink::Tauri(app) => {
                use tauri::Emitter;
                let _ = app.emit("p2p-event", value);
            }
            Sink::Test(tx) => {
                let _ = tx.send(value);
            }
        }
    }
}

/// The P2P chat engine, shared between Tauri commands and session tasks.
pub struct P2p {
    dir: PathBuf,
    endpoint: Endpoint,
    sink: Sink,
    inner: Mutex<Inner>,
    handle_ids: AtomicU64,
    /// Shuts down accept/maintenance/session tasks so the endpoint socket is
    /// released when the engine is closed.
    cancel: tokio_util::sync::CancellationToken,
}

impl P2p {
    // -- lifecycle ----------------------------------------------------------

    /// Loads (or creates) the identity and store in `dir`, binds the endpoint
    /// and starts the accept + maintenance loops.
    pub async fn start(dir: PathBuf, sink: Sink) -> Result<Arc<P2p>> {
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;

        let secret = load_or_create_identity(&dir)?;
        let name = load_profile(&dir).unwrap_or_default();

        let mut transport_config = TransportConfig::default();
        transport_config.max_idle_timeout(Some(IDLE_TIMEOUT.try_into()?));
        let endpoint = Endpoint::builder()
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .discovery_local_network()
            .transport_config(transport_config)
            .bind()
            .await
            .context("binding P2P endpoint")?;

        let mut peers = HashMap::new();
        for persisted in load_peers(&dir) {
            let node_id = match NodeId::from_str(&persisted.node_id) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let addrs = persisted
                .addrs
                .iter()
                .filter_map(|a| a.parse::<SocketAddr>().ok())
                .collect();
            let msgs = load_messages(&dir, &node_id);
            peers.insert(
                node_id,
                Peer {
                    name: persisted.name,
                    addrs,
                    live: Vec::new(),
                    connecting: false,
                    queued: Vec::new(),
                    msgs,
                },
            );
        }

        let p2p = Arc::new(P2p {
            dir,
            endpoint,
            sink,
            inner: Mutex::new(Inner {
                name,
                token: random_id(),
                peers,
                nearby: HashMap::new(),
                pair_requests: HashMap::new(),
            }),
            handle_ids: AtomicU64::new(1),
            cancel: tokio_util::sync::CancellationToken::new(),
        });

        tauri::async_runtime::spawn({
            let p2p = p2p.clone();
            async move { p2p.accept_loop().await }
        });
        tauri::async_runtime::spawn({
            let p2p = p2p.clone();
            async move { p2p.maintenance_loop().await }
        });
        tauri::async_runtime::spawn({
            let p2p = p2p.clone();
            async move { p2p.beacon_loop().await }
        });

        Ok(p2p)
    }

    /// Stops all engine tasks so the endpoint socket is released. Callers
    /// should still drop their own `Arc` references afterwards.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn close(&self) {
        self.cancel.cancel();
        // Give the accept/maintenance/session tasks a moment to unwind.
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    pub fn node_id(&self) -> NodeId {
        self.endpoint.node_id()
    }

    // -- command API ---------------------------------------------------------

    /// Snapshot for the UI.
    pub fn status(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let peers: Vec<Value> = inner
            .peers
            .iter()
            .map(|(id, peer)| {
                let last_ts = peer.msgs.last().map(|m| m.ts).unwrap_or(0);
                json!({
                    "id": id.to_string(),
                    "name": peer.name,
                    "online": peer.online(),
                    "queued": peer.queued.len(),
                    "lastTs": last_ts,
                })
            })
            .collect();
        let nearby: Vec<Value> = inner
            .nearby
            .iter()
            .filter(|(id, n)| n.fresh() && !inner.peers.contains_key(*id))
            .map(|(id, n)| json!({ "id": id.to_string(), "name": n.name }))
            .collect();
        json!({
            "nodeId": self.node_id().to_string(),
            "name": inner.name,
            "peers": peers,
            "nearby": nearby,
        })
    }

    pub fn set_name(&self, name: String) -> Result<()> {
        let name = name.trim().to_string();
        if name.is_empty() || name.len() > 64 {
            bail!("name must be 1-64 characters");
        }
        self.inner.lock().unwrap().name = name.clone();
        std::fs::write(
            self.dir.join("profile.json"),
            serde_json::to_vec(&json!({ "name": name }))?,
        )?;
        Ok(())
    }

    /// Generates a fresh pairing token and returns the invite ticket string.
    ///
    /// Compact form: `VELTAP2P1:` + base32 of a binary payload
    /// `[fmt][node_id 32][token 12][n_addrs][addrs...]` (~52 bytes → one
    /// short alphanumeric-mode QR). The display name travels in the
    /// hello/welcome handshake, not in the ticket.
    pub async fn create_invite(&self) -> Result<String> {
        let token = random_id();
        let node_addr = self
            .endpoint
            .node_addr()
            .await
            .context("resolving own addresses")?;
        let addrs: Vec<String> = node_addr
            .direct_addresses
            .iter()
            .map(|a| a.to_string())
            .collect();
        self.inner.lock().unwrap().token = token.clone();
        Ok(encode_ticket(self.node_id(), &addrs, &token))
    }

    /// Pairs with the ticket issuer: connects, presents the pairing token and
    /// persists the peer. Returns the peer snapshot for the UI.
    pub async fn accept_invite(self: &Arc<Self>, ticket: &str) -> Result<Value> {
        let ticket = parse_ticket(ticket)?;
        let node_id = NodeId::from_str(&ticket.node_id).context("bad node id in ticket")?;
        if node_id == self.node_id() {
            bail!("that is your own invite");
        }
        let mut addrs = Vec::new();
        for a in &ticket.addrs {
            if let Ok(a) = a.parse::<SocketAddr>() {
                addrs.push(a);
            }
        }
        self.pair_connect(node_id, ticket.token, addrs, ticket.name)
            .await
    }

    /// Pairs with a nearby (beacon-advertised) device discovered on the LAN.
    /// The other device must approve the request before pairing completes.
    pub async fn pair_nearby(self: &Arc<Self>, peer_str: &str) -> Result<Value> {
        let node_id = NodeId::from_str(peer_str)?;
        let (addrs, name) = {
            let inner = self.inner.lock().unwrap();
            match inner.nearby.get(&node_id) {
                Some(n) if n.fresh() => (n.addrs.clone(), n.name.clone()),
                Some(_) => bail!("device is no longer nearby"),
                None => bail!("unknown nearby device"),
            }
        };
        // Empty token = pairing request; the receiving side prompts its user.
        self.pair_connect(node_id, String::new(), addrs, name).await
    }

    /// Shared pairing path: connect, prove the token via hello/welcome, persist
    /// the peer and serve the session.
    async fn pair_connect(
        self: &Arc<Self>,
        node_id: NodeId,
        token: String,
        addrs: Vec<SocketAddr>,
        name_hint: String,
    ) -> Result<Value> {
        if node_id == self.node_id() {
            bail!("that is your own invite");
        }
        let node_addr = NodeAddr::new(node_id).with_direct_addresses(addrs.clone());

        let conn = tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(node_addr, ALPN))
            .await
            .map_err(|_| anyhow!("connect timed out — are both devices on the same network?"))?
            .context("connect failed")?;
        let (mut send, mut recv) = conn.open_bi().await?;

        let my_name = self.inner.lock().unwrap().name.clone();
        let my_addrs = self
            .endpoint
            .node_addr()
            .await?
            .direct_addresses
            .iter()
            .map(|a| a.to_string())
            .collect();
        write_json(
            &mut send,
            &Hello::Hello {
                token,
                name: my_name,
                addrs: my_addrs,
            },
        )
        .await?;

        let mut framer = Framer::default();
        let inviter_name = match tokio::time::timeout(PAIR_APPROVAL_TIMEOUT, framer.read_json_frame(&mut recv)).await {
            Ok(Ok(Hello::Welcome { name })) => name,
            Ok(Ok(Hello::Hello { .. })) => bail!("unexpected hello from the inviter"),
            Ok(Err(e)) => bail!("handshake failed: {e}"),
            Err(_) => bail!("handshake timed out — the other device may not have approved"),
        };

        // Compact tickets/beacons carry no name — the welcome frame just
        // delivered it; a name hint (ticket v1, beacon) wins if present.
        let peer_name = if name_hint.is_empty() { inviter_name } else { name_hint };
        self.add_peer(node_id, peer_name, addrs).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        self.register_live(node_id, tx.clone());
        self.flush_queue(node_id, &tx);
        tauri::async_runtime::spawn(
            self.clone()
                .session_task(node_id, send, recv, tx, rx, framer),
        );
        self.sink
            .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": true }));
        Ok(self.peer_json(&node_id))
    }

    /// Queues a message for delivery, sending immediately if the peer is
    /// online. Returns the message id.
    pub fn send(self: &Arc<Self>, peer_str: &str, text: &str) -> Result<String> {
        let node_id = NodeId::from_str(peer_str)?;
        let text = text.to_string();
        if text.is_empty() || text.len() > 64 * 1024 {
            bail!("message must be 1-64k characters");
        }
        let id = random_id();
        let ts = now_ms();

        let now_online = {
            let mut inner = self.inner.lock().unwrap();
            let peer = inner
                .peers
                .get_mut(&node_id)
                .ok_or_else(|| anyhow!("unknown peer"))?;
            // Drop handles whose session already died but wasn't reaped yet.
            peer.live.retain(|h| !h.tx.is_closed());
            let mut sent_now = false;
            if let Some(handle) = peer.live.first() {
                let frame = Frame::Msg {
                    id: id.clone(),
                    ts,
                    text: text.clone(),
                };
                if handle.tx.send(frame).is_ok() {
                    sent_now = true;
                }
            }
            let mut stored = StoredMsg {
                id: id.clone(),
                ts,
                dir: "out".into(),
                state: if sent_now { "sent" } else { "queued" }.into(),
                text,
            };
            if !sent_now {
                peer.queued.push(stored.clone());
                stored.state = "queued".into();
            }
            peer.msgs.push(stored);
            let msgs = peer.msgs.clone();
            self.persist_messages(&node_id, &msgs);
            sent_now
        };
        if !now_online {
            self.clone().trigger_connect(node_id);
        }
        Ok(id)
    }

    /// Last `limit` messages of a peer, oldest first.
    pub fn messages(&self, peer_str: &str, limit: usize) -> Result<Vec<Value>> {
        let node_id = NodeId::from_str(peer_str)?;
        let inner = self.inner.lock().unwrap();
        let peer = inner
            .peers
            .get(&node_id)
            .ok_or_else(|| anyhow!("unknown peer"))?;
        let start = peer.msgs.len().saturating_sub(limit);
        Ok(peer.msgs[start..]
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect())
    }

    /// Forces a connect attempt for a peer.
    pub fn retry(self: &Arc<Self>, peer_str: &str) -> Result<()> {
        let node_id = NodeId::from_str(peer_str)?;
        self.clone().trigger_connect(node_id);
        Ok(())
    }

    // -- internals ----------------------------------------------------------

    fn peer_json(&self, node_id: &NodeId) -> Value {
        let inner = self.inner.lock().unwrap();
        match inner.peers.get(node_id) {
            Some(peer) => json!({
                "id": node_id.to_string(),
                "name": peer.name,
                "online": peer.online(),
                "queued": peer.queued.len(),
            }),
            None => Value::Null,
        }
    }

    async fn add_peer(&self, node_id: NodeId, name: String, addrs: Vec<SocketAddr>) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let peer = inner.peers.entry(node_id).or_insert_with(|| Peer {
            name: String::new(),
            addrs: Vec::new(),
            live: Vec::new(),
            connecting: false,
            queued: Vec::new(),
            msgs: load_messages(&self.dir, &node_id),
        });
        if !name.is_empty() {
            peer.name = name;
        }
        if !addrs.is_empty() {
            peer.addrs = addrs;
        }
        let peers: Vec<PersistedPeer> = inner
            .peers
            .iter()
            .map(|(id, p)| PersistedPeer {
                node_id: id.to_string(),
                name: p.name.clone(),
                addrs: p.addrs.iter().map(|a| a.to_string()).collect(),
            })
            .collect();
        std::fs::write(
            self.dir.join("peers.json"),
            serde_json::to_vec(&PeersFile { peers })?,
        )?;
        Ok(())
    }

    fn register_live(&self, node_id: NodeId, tx: mpsc::UnboundedSender<Frame>) -> u64 {
        let id = self.handle_ids.fetch_add(1, Ordering::Relaxed);
        let mut inner = self.inner.lock().unwrap();
        if let Some(peer) = inner.peers.get_mut(&node_id) {
            peer.live.push(LiveHandle { id, tx });
        }
        id
    }

    /// Queues all pending messages of `node_id` into `tx` (the session's write
    /// path) and marks them "sent".
    fn flush_queue(&self, node_id: NodeId, tx: &mpsc::UnboundedSender<Frame>) {
        let mut inner = self.inner.lock().unwrap();
        let peer = match inner.peers.get_mut(&node_id) {
            Some(peer) => peer,
            None => return,
        };
        for msg in peer.queued.drain(..) {
            if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                eprintln!("[p2p-dbg] flushing queued msg {} to {}", msg.id, node_id);
            }
            tx.send(Frame::Msg {
                id: msg.id.clone(),
                ts: msg.ts,
                text: msg.text.clone(),
            })
            .ok();
            let mut sent = msg;
            sent.state = "sent".into();
            peer.msgs.push(sent);
        }
        let msgs = peer.msgs.clone();
        self.persist_messages(&node_id, &msgs);
    }

    fn remove_live(&self, node_id: NodeId, handle_id: u64) {
        let now_offline = {
            let mut inner = self.inner.lock().unwrap();
            let mut offline = false;
            if let Some(peer) = inner.peers.get_mut(&node_id) {
                peer.live.retain(|h| h.id != handle_id);
                offline = !peer.online();
            }
            offline
        };
        if now_offline {
            self.sink
                .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": false }));
        }
    }

    fn trigger_connect(self: &Arc<Self>, node_id: NodeId) {
        let should = {
            let mut inner = self.inner.lock().unwrap();
            match inner.peers.get_mut(&node_id) {
                Some(peer) => {
                    peer.live.retain(|h| !h.tx.is_closed());
                    if peer.connecting || peer.online() {
                        false
                    } else {
                        peer.connecting = true;
                        true
                    }
                }
                None => false,
            }
        };
        if should {
            let p2p = self.clone();
            tauri::async_runtime::spawn(async move {
                p2p.connect_and_serve(node_id).await;
            });
        }
    }

    async fn set_connecting(&self, node_id: NodeId, value: bool) {
        if let Some(peer) = self.inner.lock().unwrap().peers.get_mut(&node_id) {
            peer.connecting = value;
        }
    }

    /// One connect attempt; on success the session takes over, on failure the
    /// `connecting` flag is released so a later trigger can retry.
    async fn connect_and_serve(self: Arc<Self>, node_id: NodeId) {
        let addr = {
            let inner = self.inner.lock().unwrap();
            inner
                .peers
                .get(&node_id)
                .map(|p| NodeAddr::new(node_id).with_direct_addresses(p.addrs.clone()))
        };
        let Some(addr) = addr else { return };

        if std::env::var("VELTA_P2P_DEBUG").is_ok() {
            eprintln!("[p2p-dbg] dialing {} addrs={:?}", node_id, addr.direct_addresses);
        }
        let attempt = async {
            let conn = self.endpoint.connect(addr, ALPN).await?;
            let (mut send, recv) = conn.open_bi().await?;
            // Opening frame so the accepting side has a stream to write on.
            write_json(&mut send, &Frame::Ping).await?;
            Ok::<_, anyhow::Error>((conn, send, recv))
        };
        let connected = match tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                    eprintln!("[p2p-dbg] connect error: {e:#}");
                }
                self.set_connecting(node_id, false).await;
                self.sink.emit(json!({
                    "kind": "error",
                    "peerId": node_id.to_string(),
                    "message": format!("connect failed: {e:#}"),
                }));
                return;
            }
            Err(_) => {
                if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                    eprintln!("[p2p-dbg] connect timed out");
                }
                self.set_connecting(node_id, false).await;
                self.sink.emit(json!({
                    "kind": "error",
                    "peerId": node_id.to_string(),
                    "message": "connect timed out — peer unreachable on this network",
                }));
                return;
            }
        };
        let (conn, send, recv) = connected;

        let (tx, rx) = mpsc::unbounded_channel();
        self.register_live(node_id, tx.clone());
        self.set_connecting(node_id, false).await;
        self.flush_queue(node_id, &tx);
        self.sink
            .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": true }));
        self.session_task(node_id, send, recv, tx, rx, Framer::default())
            .await;
        drop(conn);
    }

    /// The single writer/reader for one session. Exits on stream end; cleans
    /// up its live handle afterwards. `framer` must be carried over from the
    /// handshake: it may already hold buffered bytes that arrived in the same
    /// read as the handshake frame.
    async fn session_task(
        self: Arc<Self>,
        node_id: NodeId,
        mut send: SendStream,
        mut recv: RecvStream,
        tx: mpsc::UnboundedSender<Frame>,
        mut rx: mpsc::UnboundedReceiver<Frame>,
        mut framer: Framer,
    ) {
        let handle_id = {
            let inner = self.inner.lock().unwrap();
            inner
                .peers
                .get(&node_id)
                .and_then(|p| p.live.iter().find(|h| h.tx.same_channel(&tx)))
                .map(|h| h.id)
                .unwrap_or(0)
        };
        if std::env::var("VELTA_P2P_DEBUG").is_ok() {
            eprintln!("[p2p-dbg] session task started for {}", node_id);
        }
        // Keepalive: without traffic QUIC idles out after IDLE_TIMEOUT and the
        // peer shows offline even though both engines are healthy.
        let mut next_ping = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => break,
                _ = tokio::time::sleep_until(next_ping) => {
                    next_ping = tokio::time::Instant::now() + Duration::from_secs(20);
                    if write_json(&mut send, &Frame::Ping).await.is_err() {
                        break;
                    }
                }
                frame = rx.recv() => {
                    match frame {
                        Some(frame) => {
                            if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                                eprintln!("[p2p-dbg] session writing frame to {}", node_id);
                            }
                            if write_json(&mut send, &frame).await.is_err() {
                                if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                                    eprintln!("[p2p-dbg] write to {} failed", node_id);
                                }
                                break;
                            }
                        }
                        None => break, // all senders dropped
                    }
                }
                read = framer.read_frame(&mut recv) => {
                    match read {
                        Ok(Some(frame)) => {
                            if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                                eprintln!("[p2p-dbg] session got frame from {}", node_id);
                            }
                            self.handle_frame(node_id, frame, &tx);
                        }
                        _ => {
                            if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                                eprintln!("[p2p-dbg] session {} read ended", node_id);
                            }
                            break;
                        }
                    }
                }
            }
        }
        self.remove_live(node_id, handle_id);
    }

    fn handle_frame(&self, node_id: NodeId, frame: Frame, tx: &mpsc::UnboundedSender<Frame>) {
        match frame {
            Frame::Ping => {}
            Frame::Ack { id } => {
                {
                    let mut inner = self.inner.lock().unwrap();
                    if let Some(peer) = inner.peers.get_mut(&node_id) {
                        for msg in peer.msgs.iter_mut().rev() {
                            if msg.id == id && msg.dir == "out" {
                                msg.state = "acked".into();
                                break;
                            }
                        }
                        let msgs = peer.msgs.clone();
                        self.persist_messages(&node_id, &msgs);
                    }
                }
                self.sink
                    .emit(json!({ "kind": "ack", "peerId": node_id.to_string(), "id": id }));
            }
            Frame::Msg { id, ts, text } => {
                // Dedupe: both sides may open sessions simultaneously.
                let dup = {
                    let inner = self.inner.lock().unwrap();
                    inner
                        .peers
                        .get(&node_id)
                        .map(|p| p.msgs.iter().any(|m| m.dir == "in" && m.id == id))
                        .unwrap_or(true)
                };
                if dup {
                    tx.send(Frame::Ack { id }).ok();
                    return;
                }
                {
                    let mut inner = self.inner.lock().unwrap();
                    if let Some(peer) = inner.peers.get_mut(&node_id) {
                        peer.msgs.push(StoredMsg {
                            id: id.clone(),
                            ts,
                            dir: "in".into(),
                            state: "acked".into(),
                            text: text.clone(),
                        });
                        let msgs = peer.msgs.clone();
                        self.persist_messages(&node_id, &msgs);
                    }
                }
                tx.send(Frame::Ack { id: id.clone() }).ok();
                self.sink.emit(json!({
                    "kind": "message",
                    "peerId": node_id.to_string(),
                    "id": id,
                    "ts": ts,
                    "text": text,
                }));
            }
        }
    }

    async fn accept_loop(self: Arc<Self>) {
        loop {
            let incoming = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => break,
                incoming = self.endpoint.accept() => incoming,
            };
            let Some(incoming) = incoming else {
                break; // endpoint closed
            };
            let conn = match incoming.accept() {
                Ok(conn) => conn,
                Err(_) => continue,
            };
            let p2p = self.clone();
            tauri::async_runtime::spawn(async move {
                if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                    eprintln!("[p2p-dbg] incoming connection from peer");
                }
                // Connection-level problems (bad handshake, stray scanner) are
                // non-fatal for the accept loop.
                if let Ok(conn) = conn.await {
                    let _ = p2p.handle_incoming(conn).await;
                }
            });
        }
    }

    /// Routes one inbound connection: pairing handshake for unknown NodeIds
    /// (token must match the currently advertised invite), plain session for
    /// known peers.
    async fn handle_incoming(self: Arc<Self>, conn: Connection) -> Result<()> {
        let node_id = conn.remote_node_id().context("no remote node id")?;
        let paired = {
            let inner = self.inner.lock().unwrap();
            inner.peers.contains_key(&node_id)
        };

        let (mut send, mut recv) = conn.accept_bi().await?;
        if std::env::var("VELTA_P2P_DEBUG").is_ok() {
            eprintln!("[p2p-dbg] handle_incoming {} paired={}", node_id, paired);
        }
        if paired {
            // The opener's first frame is a Ping; consume it, then serve.
            let mut framer = Framer::default();
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, framer.read_frame::<Frame>(&mut recv))
                .await
            {
                Ok(Ok(Some(_))) => {
                    if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                        eprintln!("[p2p-dbg] paired conn from {} handshake frame ok", node_id);
                    }
                }
                _ => {
                    if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                        eprintln!("[p2p-dbg] paired conn from {} ping read failed", node_id);
                    }
                    bail!("bad session from paired peer");
                }
            }
            let (tx, rx) = mpsc::unbounded_channel();
            self.register_live(node_id, tx.clone());
            self.flush_queue(node_id, &tx);
            self.sink
                .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": true }));
            self.session_task(node_id, send, recv, tx, rx, framer).await;
            return Ok(());
        }

        // Pairing: expect Hello. A hello presenting our current invite token
        // is QR proof (the joiner scanned it) — accept. An empty token is a
        // discovery-based request and needs explicit user approval. Anything
        // else is a stale/forged credential and is rejected without a prompt.
        let expected_token = self.inner.lock().unwrap().token.clone();
        let mut framer = Framer::default();
        let (token, peer_name, addr_strs) = match tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            framer.read_json_frame::<Hello>(&mut recv),
        )
        .await
        {
            Ok(Ok(Hello::Hello { token, name, addrs })) => (token, name, addrs),
            _ => bail!("bad pairing handshake"),
        };
        if token != expected_token {
            if !token.is_empty() {
                bail!("wrong pairing token");
            }
            let (decision_tx, decision_rx) = tokio::sync::oneshot::channel();
            {
                let mut inner = self.inner.lock().unwrap();
                // A repeat request from the same device replaces the old one;
                // its connection loses the race and times out on its own.
                if let Some(old) = inner.pair_requests.insert(
                    node_id,
                    PairRequest { name: peer_name.clone(), tx: decision_tx },
                ) {
                    let _ = old.tx.send(false);
                }
            }
            self.sink.emit(json!({
                "kind": "pair-request",
                "peerId": node_id.to_string(),
                "name": peer_name,
            }));
            match tokio::time::timeout(PAIR_APPROVAL_TIMEOUT, decision_rx).await {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => bail!("pairing request denied"),
                Ok(Err(_)) | Err(_) => bail!("pairing request timed out"),
            }
        }
        let mut addrs = Vec::new();
        for a in &addr_strs {
            if let Ok(a) = a.parse::<SocketAddr>() {
                addrs.push(a);
            }
        }
        self.add_peer(node_id, peer_name, addrs).await?;
        let my_name = self.inner.lock().unwrap().name.clone();
        write_json(&mut send, &Hello::Welcome { name: my_name }).await?;

        let (tx, rx) = mpsc::unbounded_channel();
        self.register_live(node_id, tx.clone());
        self.flush_queue(node_id, &tx);
        self.sink.emit(json!({
            "kind": "pairing",
            "peerId": node_id.to_string(),
            "name": self.peer_json(&node_id)["name"].clone(),
        }));
        self.sink
            .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": true }));
        self.session_task(node_id, send, recv, tx, rx, framer).await;
        Ok(())
    }

    async fn maintenance_loop(self: Arc<Self>) {
        loop {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(10)) => {}
            }
            let targets: Vec<NodeId> = {
                let inner = self.inner.lock().unwrap();
                inner
                    .peers
                    .iter()
                    // Re-dial for presence too, not only queued traffic, so a
                    // healthy peer doesn't flip to "offline" after idling.
                    .filter(|(_, p)| !p.online())
                    .map(|(id, _)| *id)
                    .collect()
            };
            for id in targets {
                self.trigger_connect(id);
            }
        }
    }

    /// LAN presence beacons: every `BEACON_INTERVAL` this engine broadcasts
    /// its display name, NodeId and direct addresses on `BEACON_PORT`, and
    /// records every other engine it hears in `nearby`. The frontend lists
    /// fresh entries as "Nearby devices" — tapping one sends a pairing
    /// request that the other device must approve. Beacons never carry the
    /// pairing token: discovery is not authorization.
    async fn beacon_loop(self: Arc<Self>) {
        // SO_REUSEADDR so a desktop app and a debug hub can coexist on one
        // machine (delivery to both is best-effort on Windows).
        let std_sock = match socket2::Socket::new(
            socket2::Domain::IPV4,
            socket2::Type::DGRAM,
            Some(socket2::Protocol::UDP),
        ) {
            Ok(s) => s,
            Err(e) => {
                crate::log(&format!("beacon socket create failed: {e}"));
                return;
            }
        };
        let _ = std_sock.set_reuse_address(true);
        let bind_addr: SocketAddr = format!("0.0.0.0:{BEACON_PORT}").parse().unwrap();
        if std_sock.bind(&bind_addr.into()).is_err() {
            crate::log(&format!("beacon port {BEACON_PORT} unavailable — LAN presence disabled"));
            return;
        }
        let _ = std_sock.set_broadcast(true);
        let _ = std_sock.set_nonblocking(true);
        let socket = match tokio::net::UdpSocket::from_std(std_sock.into()) {
            Ok(s) => s,
            Err(e) => {
                crate::log(&format!("beacon socket convert failed: {e}"));
                return;
            }
        };

        let mut buf = [0u8; 1024];
        let mut next_send = tokio::time::Instant::now();
        loop {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => break,
                received = socket.recv_from(&mut buf) => {
                    if let Ok((n, from)) = received {
                        if let Ok(beacon) = serde_json::from_slice::<Value>(&buf[..n]) {
                            self.hear_beacon(&beacon, from);
                        }
                    }
                }
                _ = tokio::time::sleep_until(next_send) => {
                    next_send = tokio::time::Instant::now() + BEACON_INTERVAL;
                    let Ok(na) = self.endpoint.node_addr().await else { continue };
                    let mut targets: Vec<SocketAddr> =
                        vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), BEACON_PORT)];
                    for a in &na.direct_addresses {
                        if let IpAddr::V4(v4) = a.ip() {
                            let o = v4.octets();
                            // /24 subnet broadcast for the interface + global broadcast
                            targets.push(SocketAddr::new(
                                IpAddr::V4(Ipv4Addr::new(o[0], o[1], o[2], 255)),
                                BEACON_PORT,
                            ));
                        }
                    }
                    targets.dedup();
                    let payload = json!({
                        "name": self.inner.lock().unwrap().name.clone(),
                        "node_id": self.node_id().to_string(),
                        "addrs": na.direct_addresses.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
                    });
                    let data = payload.to_string();
                    for t in &targets {
                        let _ = socket.send_to(data.as_bytes(), *t).await;
                    }
                }
            }
        }
    }

    /// Resolves a pending pairing request (UI approval). Unknown/stale
    /// requests error so a stale dialog can't approve a gone connection.
    pub fn approve_pair(&self, node_id_str: &str, accept: bool) -> Result<()> {
        let node_id = NodeId::from_str(node_id_str)?;
        let request = self
            .inner
            .lock()
            .unwrap()
            .pair_requests
            .remove(&node_id)
            .ok_or_else(|| anyhow!("no pending pairing request from that device"))?;
        let _ = request.tx.send(accept);
        Ok(())
    }

    /// Records a heard beacon into the neighbor table (dedupes own beacons,
    /// refreshes last_seen for known ones, announces genuinely new ones).
    fn hear_beacon(&self, beacon: &Value, from: SocketAddr) {
        let node_id_str = beacon["node_id"].as_str().unwrap_or("");
        let Ok(node_id) = NodeId::from_str(node_id_str) else {
            return;
        };
        if node_id == self.node_id() {
            return; // our own broadcast bounced back
        }
        let name = beacon["name"].as_str().unwrap_or("").to_string();
        let mut addrs: Vec<SocketAddr> = beacon["addrs"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().and_then(|s| s.parse().ok())).collect())
            .unwrap_or_default();
        if !addrs.contains(&from) {
            addrs.push(from);
        }

        let mut inner = self.inner.lock().unwrap();
        let is_new = !inner.nearby.contains_key(&node_id);
        let entry = inner.nearby.entry(node_id).or_insert(Nearby {
            name: String::new(),
            addrs: Vec::new(),
            last_seen: std::time::Instant::now(),
        });
        entry.last_seen = std::time::Instant::now();
        if !name.is_empty() {
            entry.name = name.clone();
        }
        if !addrs.is_empty() {
            entry.addrs = addrs;
        }
        // Prune stale neighbors occasionally.
        if inner.nearby.len() > 64 {
            inner.nearby.retain(|_, n| n.fresh());
        }
        drop(inner);
        if is_new {
            self.sink.emit(json!({
                "kind": "nearby",
                "peerId": node_id.to_string(),
                "name": name,
            }));
        }
    }

    /// Rewrites the peer's message file (small volume; simplicity wins).
    fn persist_messages(&self, node_id: &NodeId, msgs: &[StoredMsg]) {
        let mut buf = String::new();
        for msg in msgs {
            if let Ok(line) = serde_json::to_string(msg) {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        let _ = std::fs::write(self.messages_path(node_id), buf);
    }

    fn messages_path(&self, node_id: &NodeId) -> PathBuf {
        self.dir
            .join(format!("messages-{}.jsonl", HEXLOWER.encode(node_id.as_ref())))
    }
}

// ---------------------------------------------------------------------------
// Frame reading / helpers
// ---------------------------------------------------------------------------

/// Owns the receive buffer so leftover bytes survive across frames; must be
/// kept alive for the lifetime of a session (a fresh reader per frame would
/// drop buffered bytes).
#[derive(Default)]
struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    async fn read_json_frame<T: for<'de> Deserialize<'de>>(
        &mut self,
        recv: &mut RecvStream,
    ) -> Result<T> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=pos).collect();
                return Ok(serde_json::from_slice(&line[..pos])?);
            }
            if self.buf.len() > MAX_FRAME {
                bail!("frame too large");
            }
            let mut chunk = [0u8; 4096];
            let n = recv
                .read(&mut chunk)
                .await?
                .ok_or_else(|| anyhow!("stream ended"))?;
            if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                eprintln!("[p2p-dbg] framer read {} bytes", n);
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }

    /// Like [`Framer::read_json_frame`] but reports clean stream end as `None`.
    async fn read_frame<T: for<'de> Deserialize<'de>>(
        &mut self,
        recv: &mut RecvStream,
    ) -> Result<Option<T>> {
        self.read_json_frame(recv).await.map(Some)
    }
}

async fn write_json<T: Serialize>(send: &mut SendStream, value: &T) -> Result<()> {
    let mut line = serde_json::to_vec(value)?;
    line.push(b'\n');
    send.write_all(&line).await?;
    if std::env::var("VELTA_P2P_DEBUG").is_ok() {
        eprintln!("[p2p-dbg] wrote {} bytes onto stream", line.len());
    }
    Ok(())
}

fn parse_ticket(ticket: &str) -> Result<Ticket> {
    let encoded = ticket
        .trim()
        .strip_prefix(TICKET_PREFIX)
        .ok_or_else(|| anyhow!("not a Velta P2P invite"))?;

    // v2 compact binary (base32, alphanumeric-QR friendly).
    if let Ok(bytes) = data_encoding::BASE32_NOPAD.decode(encoded.to_ascii_uppercase().as_bytes())
    {
        if bytes.first() == Some(&TICKET_FMT_BIN) {
            if let Ok(t) = parse_ticket_bin(&bytes) {
                return Ok(t);
            }
        }
    }

    // v1 legacy: base64url JSON.
    let bytes = BASE64URL_NOPAD
        .decode(encoded.as_bytes())
        .context("bad ticket encoding")?;
    let ticket: Ticket = serde_json::from_slice(&bytes)?;
    if ticket.v != 1 {
        bail!("unsupported invite version {}", ticket.v);
    }
    Ok(ticket)
}

/// v2 binary ticket: `[fmt=2][node_id 32][token 12][n][addrs...]` where each
/// addr is `[family 1=ipv4/2=ipv6][ip][port u16 be]`.
fn parse_ticket_bin(bytes: &[u8]) -> Result<Ticket> {
    if bytes.len() < 46 {
        bail!("ticket too short");
    }
    let mut node_bytes = [0u8; 32];
    node_bytes.copy_from_slice(&bytes[1..33]);
    let node_id = NodeId::from_bytes(&node_bytes).map_err(|e| anyhow!("bad node id: {e}"))?;
    let token = HEXLOWER.encode(&bytes[33..45]);
    let n_addrs = bytes[45] as usize;
    let mut pos = 46;
    let mut addrs = Vec::with_capacity(n_addrs);
    for _ in 0..n_addrs {
        if pos + 1 > bytes.len() {
            bail!("truncated ticket address");
        }
        let family = bytes[pos];
        let ip_len = match family {
            4 => 4,
            6 => 16,
            _ => bail!("bad address family"),
        };
        if pos + 1 + ip_len + 2 > bytes.len() {
            bail!("truncated ticket address");
        }
        let ip = if family == 4 {
            IpAddr::V4(Ipv4Addr::new(bytes[pos + 1], bytes[pos + 2], bytes[pos + 3], bytes[pos + 4]))
        } else {
            let mut o = [0u8; 16];
            o.copy_from_slice(&bytes[pos + 1..pos + 17]);
            IpAddr::V6(Ipv6Addr::from(o))
        };
        let port = u16::from_be_bytes([bytes[pos + 1 + ip_len], bytes[pos + 2 + ip_len]]);
        addrs.push(SocketAddr::new(ip, port).to_string());
        pos += 1 + ip_len + 2;
    }
    Ok(Ticket {
        v: 2,
        node_id: node_id.to_string(),
        addrs,
        token,
        name: String::new(),
    })
}

/// v2 ticket encoder — see [`P2p::create_invite`]. Keeps at most 3 addresses,
/// private IPv4 first, so the QR stays small on multi-adapter machines
/// (mDNS discovery still covers any dropped addresses).
fn encode_ticket(node_id: NodeId, addrs: &[String], token: &str) -> String {
    let mut parsed: Vec<SocketAddr> = addrs.iter().filter_map(|a| a.parse().ok()).collect();
    parsed.sort_by_key(|sa| match sa.ip() {
        IpAddr::V4(v4) if v4.is_private() => 0,
        IpAddr::V4(_) => 1,
        IpAddr::V6(_) => 2,
    });
    parsed.truncate(3);

    let mut buf = vec![TICKET_FMT_BIN];
    buf.extend_from_slice(node_id.as_ref());
    if let Ok(t) = HEXLOWER.decode(token.as_bytes()) {
        buf.extend_from_slice(&t);
    }
    buf.push(parsed.len().min(8) as u8);
    for sa in parsed.iter() {
        match sa.ip() {
            IpAddr::V4(ip) => {
                buf.push(4);
                buf.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                buf.push(6);
                buf.extend_from_slice(&ip.octets());
            }
        }
        buf.extend_from_slice(&sa.port().to_be_bytes());
    }
    // Base32 output (A-Z2-7) keeps the whole ticket in the QR alphanumeric
    // charset: 5.5 bits per character instead of 8 in byte mode.
    format!("{TICKET_PREFIX}{}", data_encoding::BASE32_NOPAD.encode(&buf))
}

fn random_id() -> String {
    let mut bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    HEXLOWER.encode(&bytes)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_or_create_identity(dir: &std::path::Path) -> Result<SecretKey> {
    let path = dir.join("identity.key");
    if let Ok(hex) = std::fs::read_to_string(&path) {
        let bytes = HEXLOWER
            .decode(hex.trim().as_bytes())
            .context("bad identity key")?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("identity key must be 32 bytes"))?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let secret = SecretKey::from_bytes(&bytes);
    std::fs::write(&path, HEXLOWER.encode(&bytes))?;
    Ok(secret)
}

fn load_profile(dir: &std::path::Path) -> Option<String> {
    let data = std::fs::read(dir.join("profile.json")).ok()?;
    let value: Value = serde_json::from_slice(&data).ok()?;
    value["name"].as_str().map(|s| s.to_string())
}

fn load_peers(dir: &std::path::Path) -> Vec<PersistedPeer> {
    std::fs::read(dir.join("peers.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<PeersFile>(&data).ok())
        .map(|f| f.peers)
        .unwrap_or_default()
}

fn load_messages(dir: &std::path::Path, node_id: &NodeId) -> Vec<StoredMsg> {
    let path = dir.join(format!("messages-{}.jsonl", HEXLOWER.encode(node_id.as_ref())));
    let Ok(data) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    data.lines()
        .filter_map(|line| serde_json::from_str::<StoredMsg>(line).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri glue: managed state + commands
// ---------------------------------------------------------------------------

/// Shareable handle to the engine slot, for the async startup task.
pub type EngineSlot = std::sync::Arc<Mutex<Option<Arc<P2p>>>>;

/// Managed state; the commands take `State<'_, P2pState>`, so exactly this
/// type (not a wrapper) must be passed to `app.manage()`. The engine fills in
/// asynchronously after setup, so commands must tolerate it not being ready
/// for the first moments.
pub struct P2pState {
    engine: EngineSlot,
}

impl P2pState {
    pub fn empty() -> Self {
        Self {
            engine: std::sync::Arc::new(Mutex::new(None)),
        }
    }

    /// A clone of the engine slot to hand to [`spawn_startup`].
    pub fn slot(&self) -> EngineSlot {
        self.engine.clone()
    }
}

fn engine(state: &P2pState) -> Result<Arc<P2p>> {
    state
        .engine
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| anyhow!("P2P engine is still starting"))
}

/// Starts the engine on Tauri's async runtime and publishes it into `slot`.
pub fn spawn_startup(app: tauri::AppHandle, slot: EngineSlot, dir: PathBuf) {
    tauri::async_runtime::spawn(async move {
        match P2p::start(dir, Sink::Tauri(app.clone())).await {
            Ok(engine) => {
                *slot.lock().unwrap() = Some(engine);
                crate::log("p2p chat engine started");
            }
            Err(e) => crate::log(&format!("p2p chat engine failed to start: {e:#}")),
        }
    });
}

#[tauri::command]
pub fn p2p_status(state: tauri::State<'_, P2pState>) -> Result<Value, String> {
    engine(&state).map_err(|e| e.to_string()).map(|e| e.status())
}

#[tauri::command]
pub fn p2p_set_name(state: tauri::State<'_, P2pState>, name: String) -> Result<(), String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .set_name(name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn p2p_create_invite(state: tauri::State<'_, P2pState>) -> Result<String, String> {
    let engine = engine(&state).map_err(|e| e.to_string())?;
    engine.create_invite().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn p2p_accept_invite(
    state: tauri::State<'_, P2pState>,
    ticket: String,
) -> Result<Value, String> {
    let engine = engine(&state).map_err(|e| e.to_string())?;
    engine.accept_invite(&ticket).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_send(
    state: tauri::State<'_, P2pState>,
    peer_id: String,
    text: String,
) -> Result<String, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .send(&peer_id, &text)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_messages(
    state: tauri::State<'_, P2pState>,
    peer_id: String,
    limit: Option<usize>,
) -> Result<Vec<Value>, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .messages(&peer_id, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_retry(state: tauri::State<'_, P2pState>, peer_id: String) -> Result<(), String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .retry(&peer_id)
        .map_err(|e| e.to_string())
}

/// Pairs with a nearby (LAN-beaconed) device: the frontend calls this when the
/// user taps a device in the "Nearby" list — no QR needed.
#[tauri::command]
pub async fn p2p_pair_nearby(
    state: tauri::State<'_, P2pState>,
    node_id: String,
) -> Result<Value, String> {
    let engine = engine(&state).map_err(|e| e.to_string())?;
    engine.pair_nearby(&node_id).await.map_err(|e| e.to_string())
}

/// Approves or denies a pending pairing request (the `pair-request` event).
#[tauri::command]
pub fn p2p_approve_pair(
    state: tauri::State<'_, P2pState>,
    node_id: String,
    accept: bool,
) -> Result<(), String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .approve_pair(&node_id, accept)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("velta-p2p-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn start(tag: &str) -> (Arc<P2p>, std_mpsc::Receiver<Value>) {
        let (tx, rx) = std_mpsc::channel();
        let p2p = P2p::start(temp_dir(tag), Sink::Test(tx)).await.unwrap();
        p2p.set_name(tag.to_string()).unwrap();
        (p2p, rx)
    }

    fn wait_for(rx: &std_mpsc::Receiver<Value>, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for event");
            let event = rx.recv_timeout(remaining).expect("event channel closed");
            if pred(&event) {
                return event;
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pair_and_chat() {
        let (alice, alice_rx) = start("alice").await;
        let (bob, bob_rx) = start("bob").await;
        let alice_id = alice.node_id().to_string();
        let bob_id = bob.node_id().to_string();

        // Alice shows an invite, Bob accepts it.
        let ticket = alice.create_invite().await.unwrap();
        let peer = bob.accept_invite(&ticket).await.unwrap();
        assert_eq!(peer["name"], "alice");
        assert_eq!(peer["id"], alice_id.as_str());

        // The pairing event reaches Alice.
        wait_for(&alice_rx, 15, |e| e["kind"] == "pairing");

        // Bob -> Alice, with ack.
        let id1 = bob.send(&alice_id, "hi alice").unwrap();
        let got = wait_for(&alice_rx, 15, |e| e["kind"] == "message");
        assert_eq!(got["text"], "hi alice");
        wait_for(&bob_rx, 15, |e| e["kind"] == "ack" && e["id"] == id1.as_str());

        // Alice -> Bob, with ack.
        let id2 = alice.send(&bob_id, "hi bob").unwrap();
        let got2 = wait_for(&bob_rx, 15, |e| {
            e["kind"] == "message" && e["text"] == "hi bob"
        });
        assert_eq!(got2["text"], "hi bob");
        wait_for(&alice_rx, 15, |e| e["kind"] == "ack" && e["id"] == id2.as_str());

        // Histories line up on both sides. Each side shows both messages:
        // Bob's outbound "hi alice" (acked) and Alice's inbound "hi bob",
        // mirrored on Alice's side.
        let bob_view = bob.messages(&alice_id, 10).unwrap();
        assert_eq!(bob_view.len(), 2);
        assert_eq!(bob_view[0]["text"], "hi alice");
        assert_eq!(bob_view[0]["state"], "acked");
        assert_eq!(bob_view[1]["text"], "hi bob");
        assert_eq!(bob_view[1]["state"], "acked");
        let alice_view = alice.messages(&bob_id, 10).unwrap();
        assert_eq!(alice_view.len(), 2);
        assert_eq!(alice_view[0]["text"], "hi alice");
        assert_eq!(alice_view[1]["text"], "hi bob");
        assert_eq!(alice_view.last().unwrap()["state"], "acked");

        // A third device cannot send to a peer it is not paired with.
        let (mallory, _mallory_rx) = start("mallory").await;
        assert!(mallory.send(&bob_id, "let me in").is_err());

        // Status snapshots are sane.
        let status = alice.status();
        assert_eq!(status["name"], "alice");
        assert_eq!(status["peers"].as_array().unwrap().len(), 1);
        assert_eq!(status["peers"][0]["id"], bob_id.as_str());
    }

    #[test]
    fn compact_ticket_round_trip() {
        let node_id = NodeId::from_str(
            "23fbcff734e1238a16777de016743d93259eef9e3b79d2ac74d3cff5f60e9a0e",
        )
        .unwrap();
        let addrs = vec![
            "192.168.2.185:54218".to_string(),
            "[2a02:2168::478]:54219".to_string(),
        ];
        let ticket = encode_ticket(node_id, &addrs, "5488806feb792fa616ed954c");

        // Short and fully alphanumeric (QR alnum-mode friendly, incl. ':').
        assert!(ticket.starts_with("VELTAP2P1:"));
        assert!(ticket.len() < 130, "ticket too long: {ticket}");
        assert!(ticket[TICKET_PREFIX.len()..]
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));

        // The typical case — one IPv4 — stays under ~95 chars (QR v5-L).
        let v4_only = encode_ticket(node_id, &addrs[..1], "5488806feb792fa616ed954c");
        assert!(v4_only.len() <= 100, "v4 ticket too long: {v4_only}");

        let parsed = parse_ticket(&ticket).unwrap();
        assert_eq!(parsed.node_id, node_id.to_string());
        assert_eq!(parsed.token, "5488806feb792fa616ed954c");
        assert_eq!(parsed.addrs, addrs);
        assert_eq!(parsed.name, "");

        // Legacy v1 (base64url JSON, with name) still parses.
        let legacy_json = serde_json::json!({
            "v": 1, "node_id": node_id.to_string(),
            "addrs": ["192.168.2.185:1234"],
            "token": "aabbccddeeff001122334455", "name": "Old"
        });
        let legacy = format!(
            "VELTAP2P1:{}",
            data_encoding::BASE64URL_NOPAD
                .encode(&serde_json::to_vec(&legacy_json).unwrap())
        );
        let parsed_legacy = parse_ticket(&legacy).unwrap();
        assert_eq!(parsed_legacy.name, "Old");
        assert_eq!(parsed_legacy.token, "aabbccddeeff001122334455");
    }

    /// A tokenless beacon tap must not pair by itself: the receiving device
    /// gets a `pair-request` and only pairs after explicit approval.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn nearby_pairing_requires_approval() {
        let (alice, alice_rx) = start("alice3").await;
        let (bob, bob_rx) = start("bob3").await;
        let alice_id = alice.node_id().to_string();
        let bob_id = bob.node_id().to_string();

        // Bob hears Alice's (tokenless) beacon and taps "Pair".
        let na = alice.endpoint.node_addr().await.unwrap();
        let beacon = json!({
            "name": "alice3",
            "node_id": alice_id,
            "addrs": na.direct_addresses.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        });
        bob.hear_beacon(&beacon, "127.0.0.1:1".parse().unwrap());

        let tap = |bob: Arc<P2p>, alice_id: String| {
            tauri::async_runtime::spawn(async move { bob.pair_nearby(&alice_id).await })
        };

        // First request: denied. Alice never pairs and the initiator fails.
        let flow = tap(bob.clone(), alice_id.clone());
        let request = wait_for(&alice_rx, 15, |e| e["kind"] == "pair-request");
        assert_eq!(request["name"], "bob3");
        assert!(alice.status()["peers"].as_array().unwrap().is_empty());
        alice.approve_pair(&bob_id, false).unwrap();
        assert!(flow.await.unwrap().is_err());
        assert!(alice.status()["peers"].as_array().unwrap().is_empty());
        assert!(bob.status()["peers"].as_array().unwrap().is_empty());

        // Second request: approved → both sides paired, chat round-trips.
        let flow = tap(bob.clone(), alice_id.clone());
        wait_for(&alice_rx, 15, |e| e["kind"] == "pair-request");
        alice.approve_pair(&bob_id, true).unwrap();
        let peer = flow.await.unwrap().unwrap();
        assert_eq!(peer["name"], "alice3");
        wait_for(&alice_rx, 15, |e| e["kind"] == "pairing");
        let id = bob.send(&alice_id, "approved").unwrap();
        let got = wait_for(&alice_rx, 15, |e| {
            e["kind"] == "message" && e["text"] == "approved"
        });
        assert_eq!(got["text"], "approved");
        wait_for(&bob_rx, 15, |e| e["kind"] == "ack" && e["id"] == id.as_str());

        // A stale approval has nothing to resolve.
        assert!(alice.approve_pair(&bob_id, true).is_err());
    }

    /// Queued messages are flushed once the peer becomes reachable.
    ///
    /// Bob restarts from his directory (same identity, Alice still paired),
    /// while Alice's original endpoint keeps listening — so Bob's stored
    /// address for Alice is still valid and the queue flush is deterministic.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn offline_queue_flushes() {        let (alice, alice_rx) = start("alice2").await;
        let (bob, _bob_rx) = start("bob2").await;
        let alice_id = alice.node_id().to_string();
        let bob_id = bob.node_id().to_string();

        // Bob pairs with Alice and is then torn down.
        let ticket = alice.create_invite().await.unwrap();
        bob.accept_invite(&ticket).await.unwrap();
        wait_for(&alice_rx, 15, |e| e["kind"] == "pairing");
        // Same path start("bob2") used — no wipe here, the store must survive.
        let dir_b = std::env::temp_dir()
            .join(format!("velta-p2p-test-bob2-{}", std::process::id()));
        // Shut the engine down properly: spawned tasks keep the endpoint alive,
        // so a plain drop would leave a zombie endpoint bound to Bob's NodeId.
        bob.close().await;
        drop(bob);

        // Bob comes back from the same store, Alice is already paired with his
        // NodeId (persisted on her side, un-restarted). He queues a message
        // while no session exists yet; the connect + flush path must deliver it.
        let (bob2, bob2_rx) = {
            let (tx, rx) = std_mpsc::channel();
            let p2p = P2p::start(dir_b, Sink::Test(tx)).await.unwrap();
            (p2p, rx)
        };
        assert_eq!(bob2.node_id().to_string(), bob_id);
        assert_eq!(bob2.status()["peers"].as_array().unwrap().len(), 1);

        let id = bob2.send(&alice_id, "while you were away").unwrap();

        // First dial attempt after a cold start can stall (iroh address
        // probing), the 10s maintenance retry then delivers — allow 60s.
        let got = wait_for(&alice_rx, 60, |e| e["kind"] == "message");
        assert_eq!(got["text"], "while you were away");
        wait_for(&bob2_rx, 60, |e| e["kind"] == "ack" && e["id"] == id.as_str());
    }
}
