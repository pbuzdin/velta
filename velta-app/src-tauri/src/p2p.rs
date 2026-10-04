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
use data_encoding::BASE64;
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use iroh::{endpoint::{Connection, ConnectOptions, RecvStream, SendStream, TransportConfig}, Endpoint, NodeAddr, NodeId, RelayMode, SecretKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

mod groups;
use groups::{
    append_log, check_group_name, delete_log, eff_ts, evaluate_incoming, load_group_log, load_groups, new_gid,
    read_log, roster_events, save_groups, scan_log, sys_kind, sys_rec, Evaluation, GroupFileRec, GroupLogRec, GroupMember,
    GroupRec, GroupState, RosterEvent, MAX_GROUPS, LEGACY_MAX_GROUP_MEMBERS, MAX_GROUP_MEMBERS, MAX_GROUP_TEXT, MAX_MEMBER_ADDRS, SYS_DIR,
};
use std::collections::{BTreeMap, HashSet};

/// ALPN of the original Velta local chat protocol (1:1 chat, files).
const ALPN_V1: &[u8] = b"/velta/p2p/1";
/// ALPN of protocol 2. Today it carries exactly the v1 frames; the version is
/// negotiated by TLS before any frame so later versions can add frame types
/// that a v1 peer will never see (it only offers/accepts v1).
const ALPN_V2: &[u8] = b"/velta/p2p/2";
/// ALPNs this build accepts and offers, preferred first. The first entry is
/// the primary ALPN of an outgoing dial, the rest are fallbacks.
fn default_alpns() -> Vec<Vec<u8>> {
    vec![ALPN_V2.to_vec(), ALPN_V1.to_vec()]
}
/// Protocol number of an established connection (negotiated ALPN); anything
/// that is not v2 is v1.
fn proto_of(conn: &Connection) -> u8 {
    match conn.alpn() {
        Some(a) if a == ALPN_V2 => 2,
        _ => 1,
    }
}
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Frame {
    /// A chat message from the remote peer. `reply_to` quotes another
    /// message by its id (optional for wire compatibility with old peers).
    Msg { id: String, ts: u64, text: String, #[serde(default)] reply_to: Option<String>, #[serde(default)] reply_text: Option<String> },
    /// Acknowledgement for a message delivered earlier.
    Ack { id: String },
    /// Media transfer: header, then base64 chunks, then completion.
    /// `caption` is optional for wire compatibility with older peers.
    FileBegin { id: String, ts: u64, name: String, size: u64, mime: String, #[serde(default)] caption: String },
    FileChunk { id: String, data: String },
    FileEnd { id: String },
    /// Session keepalive / opening frame.
    Ping,
    // -- Group frames: protocol 2 sessions only, never sent on a v1 session --
    /// A group's signed roster (create/add/remove/rename/disband, or relayed
    /// by any member that holds a newer one).
    GroupState { state: GroupState },
    /// Sent by both sides when a session opens (per shared group) and by a
    /// receiver that sees a gap. `have` = highest contiguous seq the sender
    /// stored from the *receiver*; `name` = the sender's own device name.
    GroupSync { gid: String, epoch: u64, have: u64, #[serde(default)] name: String },
    /// One message of the author's per-group sequence. `from` must equal the
    /// session's authenticated node id.
    GroupMsg {
        gid: String,
        from: String,
        seq: u64,
        id: String,
        ts: u64,
        text: String,
        #[serde(default)]
        reply_to: Option<String>,
        #[serde(default)]
        reply_text: Option<String>,
    },
    /// Cumulative: "I hold your seqs 1..=have".
    GroupAck { gid: String, have: u64 },
    /// Member -> creator: take me out of the roster.
    GroupLeave { gid: String },
    /// "I don't know this gid / am no longer in it", believed only about the
    /// sender itself.
    GroupGone { gid: String },
    /// "I am typing" (`on`) / "I stopped": a transient hint for the chat with
    /// `gid` (a group) or the 1:1 chat with the sender (`gid` absent). Sent
    /// live on protocol-2 sessions only (a 1.4.x peer would drop the session on
    /// a frame it doesn't know), never stored, queued or replayed.
    Typing { #[serde(default)] gid: Option<String>, on: bool },
    /// Media in a group, to one member at a time over its own session (the
    /// sender streams a separate copy to each online member). Header, base64
    /// chunks, completion; protocol-2 sessions only, never queued or replayed.
    /// `from` is the session's authenticated node, never claimed in the frame.
    GroupFileBegin { gid: String, id: String, ts: u64, name: String, size: u64, mime: String, #[serde(default)] caption: String },
    GroupFileChunk { gid: String, id: String, data: String },
    GroupFileEnd { gid: String, id: String },
    /// "The largest group I understand" (sent once per v2 session, right after
    /// the opening Ping). A 1.4.56/57 peer skips it as an unknown frame and
    /// never sends one, so a missing value means "at most 4".
    GroupCaps { max: u8 },
    /// Any frame type this build does not know (a newer peer's extension).
    /// It is skipped instead of failing the parse, which used to end the
    /// whole session. Never sent on purpose.
    #[serde(other)]
    Unknown,
}

impl Frame {
    /// Group frames are the only frames an *introduced* member may send.
    fn is_group(&self) -> bool {
        matches!(
            self,
            Frame::GroupState { .. }
                | Frame::GroupSync { .. }
                | Frame::GroupMsg { .. }
                | Frame::GroupAck { .. }
                | Frame::GroupLeave { .. }
                | Frame::GroupGone { .. }
                | Frame::GroupCaps { .. }
                | Frame::Typing { gid: Some(_), .. }
                | Frame::GroupFileBegin { .. }
                | Frame::GroupFileChunk { .. }
                | Frame::GroupFileEnd { .. }
        )
    }

    /// Group media frames: bulk data, handled apart from the small group
    /// frames (own receive path, exempt from the per-second frame limit).
    fn is_group_file(&self) -> bool {
        matches!(
            self,
            Frame::GroupFileBegin { .. } | Frame::GroupFileChunk { .. } | Frame::GroupFileEnd { .. }
        )
    }
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
    /// Unknown handshake type from a newer peer; the handshake is refused
    /// cleanly with a normal "unexpected" error instead of a parse error.
    #[serde(other)]
    Unknown,
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
    /// Id of the message this one replies to (local chat replies).
    #[serde(default)]
    reply_to: Option<String>,
    /// Quoted text sent alongside `reply_to` so the receiver can render the
    /// header without looking the message up.
    #[serde(default)]
    reply_text: Option<String>,
    /// Present for media messages (phase 2 local chat media).
    #[serde(default)]
    file: Option<StoredFile>,
}

/// Where a media file lives on THIS device once the transfer completed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredFile {
    name: String,
    size: u64,
    mime: String,
    path: String,
}

/// An inbound media transfer assembled across FileBegin/FileChunk frames.
struct FileRx {
    partial: PathBuf,
    dir: PathBuf,
    name: String,
    size: u64,
    mime: String,
    caption: String,
    ts: u64,
    got: u64,
    /// `Some(gid)` for a group transfer (its own frames, 32 MiB cap, files
    /// under `g-<gid>`); `None` for a 1:1 transfer. A frame of one kind never
    /// touches a transfer of the other.
    gid: Option<String>,
}

/// Cap for one local-chat media transfer.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
// V-10/#67: a peer must not pin memory/fds with many parallel inbound
// transfers on top of the per-file 256 MB cap. Global bound across peers
// keeps the whole engine bounded too.
const MAX_INBOUND_FILES_PER_PEER: usize = 3;
const MAX_INBOUND_FILES_TOTAL: usize = 8;
/// Cap for one media file in a local group (it is sent once per member).
const MAX_GROUP_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Raw bytes per group file chunk (base64 ~128 KB < MAX_FRAME).
const GROUP_FILE_CHUNK: usize = 96 * 1024;
/// Chunks one sender may have queued on a session at a time: the session
/// writer hands a credit back after each chunk hit the wire, so a slow
/// receiver holds the sender back and memory stays O(chunk) per recipient.
const GROUP_FILE_CREDITS: usize = 4;
/// Finished/failed group transfers whose per-member state is kept in memory.
const MAX_GROUP_XFERS: usize = 32;

/// Strip any path components and odd characters from a peer-supplied name —
/// the name is untrusted and must never escape the blob directory.
fn sanitize_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        .collect::<String>()
        .trim()
        .to_string();
    let mut out = base;
    if out.len() > 80 {
        out = out.chars().take(80).collect();
    }
    if out.is_empty() {
        "file.bin".into()
    } else {
        out
    }
}

/// Transfer ids arrive from the peer and are used in on-disk file names:
/// allow only short alphanumeric/`-`/`_` tokens.
fn is_safe_transfer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Best-effort mime from extension (rendering is driven by the extension
/// downstream, so unknown types degrade to a generic file card).
fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
    .into()
}

/// `name`, `name (1)`, `name (2)`, … — never overwrite an existing blob.
fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let stem = std::path::Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let ext = std::path::Path::new(name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let stamp = now_ms();
    for i in 0..1000u32 {
        let candidate = if i == 0 {
            dir.join(format!("{stem}{ext}"))
        } else {
            dir.join(format!("{stem} ({i}){ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{stamp}{ext}"))
}

/// Peer row in `peers.json`.
#[derive(Debug, Serialize, Deserialize)]
struct PersistedPeer {
    node_id: String,
    name: String,
    addrs: Vec<String>,
    /// Protocol of the last session with this peer (1, 2, or 0 = never
    /// connected / written by an older build). Old builds ignore the field.
    #[serde(default)]
    proto: u8,
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
    /// Negotiated protocol of this session (1 or 2).
    proto: u8,
    /// Backpressure for bulk group media: see [`GROUP_FILE_CREDITS`].
    credits: Arc<tokio::sync::Semaphore>,
}

/// How this device knows a peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerKind {
    /// Explicitly paired (QR token or approved Nearby tap): a 1:1 contact.
    Paired,
    /// Listed in the signed roster of a group we are in, never paired. May
    /// only exchange group frames; never persisted to `peers.json` (a
    /// downgrade to a build without groups would otherwise treat it as a
    /// paired contact), never listed, never messaged 1:1.
    Introduced,
}

struct Peer {
    kind: PeerKind,
    name: String,
    addrs: Vec<SocketAddr>,
    /// Protocol of the last session (persisted), 0 = unknown yet.
    proto: u8,
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
    /// Local group chats, by gid (mirror of `groups.json`).
    groups: BTreeMap<String, GroupRec>,
    /// Per-session group delivery state (never persisted).
    grt: GroupRt,
}

type FrameTx = mpsc::UnboundedSender<Frame>;

/// Unacked group messages kept in flight per member (replays are paged).
const GROUP_WINDOW: u64 = 200;
/// Group frames accepted per second on one session; the rest are dropped
/// (a flood cannot starve the engine; the sender's gap sync recovers).
const GROUP_FRAMES_PER_SEC: u32 = 500;
/// Typing hints from one sender for one chat that repeat the same state
/// faster than this are not forwarded to the UI (the sender repeats every 3 s).
const TYPING_MIN_GAP: Duration = Duration::from_millis(500);

/// What the peer told us in its latest `GroupSync` on a live session.
struct GroupLink {
    /// The peer's epoch of the group.
    epoch: u64,
    /// Highest own seq already put on a session towards this peer.
    pushed: u64,
}

#[derive(Default)]
struct GroupRt {
    links: HashMap<(String, NodeId), GroupLink>,
    /// Members that said `GroupGone` for a gid: skipped until a newer state.
    gone: HashSet<(String, NodeId)>,
    /// `have` value for which a gap sync was already sent (no sync storms).
    gap_sent: HashMap<(String, NodeId), u64>,
    /// Last display timestamp per group, loaded lazily from the log.
    ts_eff: HashMap<String, u64>,
    /// Last typing hint per (chat key, sender): repeats within
    /// [`TYPING_MIN_GAP`] are dropped before they reach the UI.
    typing_seen: HashMap<(String, NodeId), (bool, std::time::Instant)>,
    /// Largest group each peer announced (`GroupCaps`), this run only. A peer
    /// that never announced one is a build with the old cap of 4.
    caps: HashMap<NodeId, u8>,
}

/// The tx of a live protocol-2 session to `node`; v1 sessions yield `None`
/// so a 1.4.x peer never sees a frame it would choke on.
fn v2_tx(peers: &HashMap<NodeId, Peer>, node: &NodeId) -> Option<FrameTx> {
    peers
        .get(node)?
        .live
        .iter()
        .find(|h| h.proto >= 2 && !h.tx.is_closed())
        .map(|h| h.tx.clone())
}

/// A live protocol-2 session to a member, with its media backpressure.
struct FileLink {
    tx: FrameTx,
    credits: Arc<tokio::sync::Semaphore>,
    handle: u64,
}

fn v2_link(peers: &HashMap<NodeId, Peer>, node: &NodeId) -> Option<FileLink> {
    peers
        .get(node)?
        .live
        .iter()
        .find(|h| h.proto >= 2 && !h.tx.is_closed())
        .map(|h| FileLink { tx: h.tx.clone(), credits: h.credits.clone(), handle: h.id })
}

/// Outgoing group media: what is sent and how it went for each member. In
/// memory only (an interrupted send is retried from the stored copy).
struct GroupXfer {
    gid: String,
    path: PathBuf,
    name: String,
    size: u64,
    mime: String,
    caption: String,
    ts: u64,
    members: BTreeMap<String, MemberXfer>,
}

#[derive(Clone)]
struct MemberXfer {
    /// "sending" | "done" | "failed" | "offline" (not online at send time).
    state: &'static str,
    sent: u64,
    /// The session carrying it, so a dying session fails only its own sends.
    handle: u64,
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
    /// Media blobs land here (must sit under the accounts dir so the existing
    /// blobfile/media pipeline can serve them).
    blobs_dir: PathBuf,
    /// In-progress inbound file transfers keyed by (sending node, transfer
    /// id). The id is chosen by the sender, so it is only unique per sender:
    /// keying by id alone let one paired peer clobber (or finish) another
    /// peer's transfer that happened to use the same id.
    rx_files: Mutex<HashMap<(NodeId, String), FileRx>>,
    /// Outgoing group media by transfer id.
    group_xfers: Mutex<HashMap<String, GroupXfer>>,
    endpoint: Endpoint,
    /// The identity key: signs group states (iroh also holds it for TLS).
    secret: SecretKey,
    /// ALPNs accepted and offered when dialing (see [`default_alpns`]).
    alpns: Vec<Vec<u8>>,
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
    pub async fn start(dir: PathBuf, blobs_dir: PathBuf, sink: Sink) -> Result<Arc<P2p>> {
        Self::start_with_alpns(dir, blobs_dir, sink, default_alpns()).await
    }

    /// [`P2p::start`] with an explicit ALPN list. Production always passes
    /// [`default_alpns`]; tests start a v1-only engine to stand in for a
    /// released 1.4.x build.
    async fn start_with_alpns(
        dir: PathBuf,
        blobs_dir: PathBuf,
        sink: Sink,
        alpns: Vec<Vec<u8>>,
    ) -> Result<Arc<P2p>> {
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        std::fs::create_dir_all(&blobs_dir).with_context(|| format!("create {}", blobs_dir.display()))?;

        let secret = load_or_create_identity(&dir)?;
        let name = load_profile(&dir).unwrap_or_default();

        let mut transport_config = TransportConfig::default();
        transport_config.max_idle_timeout(Some(IDLE_TIMEOUT.try_into()?));
        let endpoint = Endpoint::builder()
            .secret_key(secret.clone())
            .alpns(alpns.clone())
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
            let queued = queued_from(&msgs);
            peers.insert(
                node_id,
                Peer {
                    kind: PeerKind::Paired,
                    name: persisted.name,
                    addrs,
                    proto: persisted.proto,
                    live: Vec::new(),
                    connecting: false,
                    queued,
                    msgs,
                },
            );
        }

        let mut groups = load_groups(&dir);
        // The log is the truth for counters: a crash between "line written"
        // and "groups.json saved" must neither reuse a seq nor lose `have`.
        let me_hex = secret.public().to_string();
        for (gid, rec) in groups.iter_mut() {
            let scan = scan_log(&dir, gid, &me_hex);
            rec.next_seq = rec.next_seq.max(scan.own_max + 1);
            for (author, seq) in scan.in_max {
                let have = rec.have.entry(author).or_insert(0);
                *have = (*have).max(seq);
            }
        }
        rebuild_introduced(&mut peers, &groups, &secret.public());

        let p2p = Arc::new(P2p {
            dir,
            blobs_dir,
            rx_files: Mutex::new(HashMap::new()),
            group_xfers: Mutex::new(HashMap::new()),
            endpoint,
            secret,
            alpns,
            sink,
            inner: Mutex::new(Inner {
                name,
                token: random_id(),
                peers,
                nearby: HashMap::new(),
                pair_requests: HashMap::new(),
                groups,
                grt: GroupRt::default(),
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

        // Texts left queued by the previous run: dial now instead of waiting
        // for the first maintenance tick.
        let pending: Vec<NodeId> = {
            let inner = p2p.inner.lock().unwrap();
            inner.peers.iter().filter(|(_, p)| !p.queued.is_empty()).map(|(id, _)| *id).collect()
        };
        for id in pending {
            p2p.trigger_connect(id);
        }
        // Group members too: reconnect (and replay) right away.
        p2p.trigger_group_dials();

        Ok(p2p)
    }

    /// Stops all engine tasks so the endpoint socket is released. Callers
    /// should still drop their own `Arc` references afterwards.
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
            .filter(|(_, peer)| peer.kind == PeerKind::Paired)
            .map(|(id, peer)| {
                let last_ts = peer.msgs.last().map(|m| m.ts).unwrap_or(0);
                json!({
                    "id": id.to_string(),
                    "name": peer.name,
                    "online": peer.online(),
                    "queued": peer.queued.len(),
                    "lastTs": last_ts,
                    // Best live session's protocol, else the last known one.
                    "proto": peer.live.iter().map(|h| h.proto).max().unwrap_or(peer.proto),
                })
            })
            .collect();
        let nearby: Vec<Value> = inner
            .nearby
            .iter()
            .filter(|(id, n)| {
                n.fresh() && inner.peers.get(*id).map_or(true, |p| p.kind != PeerKind::Paired)
            })
            .map(|(id, n)| json!({ "id": id.to_string(), "name": n.name }))
            .collect();
        json!({
            "nodeId": self.node_id().to_string(),
            "name": inner.name,
            "peers": peers,
            "nearby": nearby,
            "groups": inner.groups.values().map(|g| self.group_json(&inner, g)).collect::<Vec<_>>(),
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

        let conn = tokio::time::timeout(CONNECT_TIMEOUT, self.dial(node_addr))
            .await
            .map_err(|_| anyhow!("connect timed out — are both devices on the same network?"))?
            .context("connect failed")?;
        let proto = proto_of(&conn);
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
            Ok(Ok(Hello::Hello { .. } | Hello::Unknown)) => bail!("unexpected hello from the inviter"),
            Ok(Err(e)) => bail!("handshake failed: {e}"),
            Err(_) => bail!("handshake timed out — the other device may not have approved"),
        };

        // Compact tickets/beacons carry no name — the welcome frame just
        // delivered it; a name hint (ticket v1, beacon) wins if present.
        let peer_name = if name_hint.is_empty() { inviter_name } else { name_hint };
        self.add_peer(node_id, peer_name, addrs).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        self.register_live(node_id, tx.clone(), proto);
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
    pub fn send(self: &Arc<Self>, peer_str: &str, text: &str, reply_to: Option<&str>, reply_text: Option<&str>) -> Result<Value> {
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
                .filter(|p| p.kind == PeerKind::Paired)
                .ok_or_else(|| anyhow!("unknown peer"))?;
            // Drop handles whose session already died but wasn't reaped yet.
            peer.live.retain(|h| !h.tx.is_closed());
            let mut sent_now = false;
            if let Some(handle) = peer.live.first() {
                let frame = Frame::Msg {
                    id: id.clone(),
                    ts,
                    text: text.clone(),
                    reply_to: reply_to.map(|s| s.to_string()),
                    reply_text: reply_text.map(|s| s.to_string()),
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
                reply_to: reply_to.map(|s| s.to_string()),
                reply_text: reply_text.map(|s| s.to_string()),
                file: None,
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
        // The UI surfaces the queued-vs-sent distinction: a queued text shows
        // a pending clock until flush_queue puts it on the wire.
        Ok(json!({ "id": id, "queued": !now_online }))
    }

    /// Sends a media file to a peer: copies it into our blobs dir, then
    /// streams FileBegin/FileChunk/FileEnd frames through the live session.
    /// Requires an online peer — offline queuing of large transfers is out of
    /// scope for this cut (ponytail: add spool-to-disk queue if users hit it).
    pub fn send_file(
        self: &Arc<Self>,
        peer_str: &str,
        src: &str,
        name: &str,
        caption: &str,
    ) -> Result<(String, PathBuf)> {
        const CHUNK_RAW: usize = 96 * 1024; // base64 ~128KB < MAX_FRAME
        const MAX_FILE: u64 = 256 * 1024 * 1024;
        let node_id = NodeId::from_str(peer_str)?;
        // Before the file is copied anywhere: only paired devices get 1:1 media.
        self.require_paired(&node_id)?;
        let meta = std::fs::metadata(src).context("source file missing")?;
        if !meta.is_file() {
            bail!("not a file");
        }
        if meta.len() > MAX_FILE {
            bail!("file too large for local chat (cap 256 MB)");
        }
        let safe = sanitize_name(name);
        let mime = mime_for(&safe);

        // Sender keeps a copy under blobs so the UI (and the transfer) read
        // from one canonical location that the media pipeline may serve.
        let dest_dir = self.blobs_dir.join("self");
        std::fs::create_dir_all(&dest_dir)?;
        let id = random_id();
        let dest = dest_dir.join(format!("{id}_{safe}"));
        std::fs::copy(src, &dest).with_context(|| format!("copy into blobs dir"))?;
        let size = std::fs::metadata(&dest)?.len();

        // Frames are built up-front; a mid-send session death loses the tail —
        // the peer's partial is discarded by the size check on FileEnd.
        let data = std::fs::read(&dest)?;
        let mut frames = Vec::new();
        frames.push(Frame::FileBegin {
            id: id.clone(),
            ts: now_ms(),
            name: safe.clone(),
            size,
            mime: mime.clone(),
            caption: caption.to_string(),
        });
        for chunk in data.chunks(CHUNK_RAW) {
            frames.push(Frame::FileChunk {
                id: id.clone(),
                data: BASE64.encode(chunk),
            });
        }
        frames.push(Frame::FileEnd { id: id.clone() });

        let ts = now_ms();
        let now_online = {
            let mut inner = self.inner.lock().unwrap();
            let peer = inner
                .peers
                .get_mut(&node_id)
                .filter(|p| p.kind == PeerKind::Paired)
                .ok_or_else(|| anyhow!("unknown peer"))?;
            peer.live.retain(|h| !h.tx.is_closed());
            let mut sent_now = false;
            if let Some(handle) = peer.live.first() {
                for f in &frames {
                    if handle.tx.send(f.clone()).is_err() {
                        sent_now = false;
                        break;
                    }
                    sent_now = true;
                }
            }
            let stored = StoredMsg {
                id: id.clone(),
                ts,
                dir: "out".into(),
                state: if sent_now { "sent" } else { "queued" }.into(),
                text: caption.to_string(),
                reply_to: None,
                reply_text: None,
                file: Some(StoredFile {
                    name: safe,
                    size,
                    mime,
                    path: dest.to_string_lossy().to_string(),
                }),
            };
            if !sent_now {
                bail!("peer is offline — media can't be queued yet, send text instead");
            }
            peer.msgs.push(stored);
            let msgs = peer.msgs.clone();
            self.persist_messages(&node_id, &msgs);
            sent_now
        };
        if !now_online {
            self.clone().trigger_connect(node_id);
        }
        Ok((id, dest))
    }

    /// Removes a paired device: closes its sessions, deletes the pairing,
    /// history and received blobs. The peer can re-pair with a fresh invite.
    pub fn remove_peer(self: &Arc<Self>, peer_str: &str) -> Result<()> {
        let node_id = NodeId::from_str(peer_str)?;
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.peers.get(&node_id).map(|p| p.kind) != Some(PeerKind::Paired) {
                bail!("unknown peer");
            }
            let peer = inner.peers.remove(&node_id).expect("checked above");
            // Dropping the senders breaks the sessions (rx.recv() -> None).
            drop(peer);
            inner.pair_requests.remove(&node_id);
            self.persist_peers(&inner)?;
            // Groups this device created are gone with it: we can't keep
            // talking to a creator we just forgot (and it can't be asked to
            // re-sign anything for us). Delete them here.
            let me = self.node_id().to_string();
            let theirs: Vec<String> = inner
                .groups
                .values()
                .filter(|g| g.state.creator == node_id.to_string() && g.state.creator != me)
                .map(|g| g.state.gid.clone())
                .collect();
            for gid in theirs {
                self.purge_group(&mut inner, &gid);
            }
            // Still a member of one of our groups? Then they stay reachable
            // for group traffic, downgraded to an introduced member.
            self.sync_introduced(&mut inner);
        }
        let _ = std::fs::remove_file(self.messages_path(&node_id));
        let _ = std::fs::remove_dir_all(self.blobs_dir.join(node_id.to_string()));
        self.sink
            .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": false }));
        Ok(())
    }

    /// Last `limit` messages of a peer, oldest first.
    pub fn messages(&self, peer_str: &str, limit: usize) -> Result<Vec<Value>> {
        let node_id = NodeId::from_str(peer_str)?;
        let inner = self.inner.lock().unwrap();
        let peer = inner
            .peers
            .get(&node_id)
            .filter(|p| p.kind == PeerKind::Paired)
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
        let peer = inner.peers.entry(node_id).or_insert_with(|| {
            let msgs = load_messages(&self.dir, &node_id);
            Peer {
                kind: PeerKind::Paired,
                name: String::new(),
                addrs: Vec::new(),
                proto: 0,
                live: Vec::new(),
                connecting: false,
                queued: queued_from(&msgs),
                msgs,
            }
        });
        if peer.kind == PeerKind::Introduced {
            // Paired directly after being introduced: now a real contact; the
            // sessions already open stay, 1:1 history starts from the log.
            peer.kind = PeerKind::Paired;
            peer.msgs = load_messages(&self.dir, &node_id);
            peer.queued = queued_from(&peer.msgs);
        }
        if !name.is_empty() {
            peer.name = name;
        }
        if !addrs.is_empty() {
            peer.addrs = addrs;
        }
        self.persist_peers(&inner)?;
        Ok(())
    }

    /// Rewrites peers.json (addresses + names) from the live map. Callers hold
    /// the inner lock; the small file keeps a blocking write acceptable.
    fn persist_peers(&self, inner: &Inner) -> Result<()> {
        // Introduced members never reach peers.json (see PeerKind).
        let peers: Vec<PersistedPeer> = inner
            .peers
            .iter()
            .filter(|(_, p)| p.kind == PeerKind::Paired)
            .map(|(id, p)| PersistedPeer {
                node_id: id.to_string(),
                name: p.name.clone(),
                addrs: p.addrs.iter().map(|a| a.to_string()).collect(),
                proto: p.proto,
            })
            .collect();
        std::fs::write(
            self.dir.join("peers.json"),
            serde_json::to_vec(&PeersFile { peers })?,
        )?;
        Ok(())
    }

    fn register_live(&self, node_id: NodeId, tx: mpsc::UnboundedSender<Frame>, proto: u8) -> u64 {
        let id = self.handle_ids.fetch_add(1, Ordering::Relaxed);
        let mut inner = self.inner.lock().unwrap();
        let mut changed = false;
        if let Some(peer) = inner.peers.get_mut(&node_id) {
            peer.live.push(LiveHandle { id, tx, proto, credits: Arc::new(tokio::sync::Semaphore::new(GROUP_FILE_CREDITS)) });
            if peer.proto != proto {
                peer.proto = proto;
                changed = true;
            }
        }
        if changed {
            let _ = self.persist_peers(&inner);
        }
        id
    }

    /// Opens a connection to `addr`, offering our ALPNs in preference order
    /// (v2 first, v1 as fallback). A released 1.4.x peer only knows v1, so
    /// TLS settles on v1 and the session behaves exactly as before.
    async fn dial(&self, addr: NodeAddr) -> Result<Connection> {
        let (primary, rest) = self.alpns.split_first().context("no ALPN configured")?;
        let opts = ConnectOptions::new().with_additional_alpns(rest.to_vec());
        let connecting = self.endpoint.connect_with_opts(addr, primary, opts).await?;
        Ok(connecting.await?)
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
                reply_to: msg.reply_to.clone(),
                reply_text: msg.reply_text.clone(),
            })
            .ok();
            // Tell the UI its pending text is on the wire now.
            self.sink.emit(json!({
                "kind": "msg-state", "peerId": node_id.to_string(),
                "id": msg.id.clone(), "state": "sent",
            }));
            // `send()` already stored this message (state "queued"): flip that
            // entry. Pushing a second "sent" copy used to leave a stale
            // "queued" twin with the same id in the log.
            match peer.msgs.iter_mut().rev().find(|m| m.dir == "out" && m.id == msg.id) {
                Some(stored) => stored.state = "sent".into(),
                None => {
                    let mut sent = msg;
                    sent.state = "sent".into();
                    peer.msgs.push(sent);
                }
            }
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
            if offline {
                // A new session starts from a fresh GroupSync.
                inner.grt.links.retain(|(_, n), _| *n != node_id);
                inner.grt.gap_sent.retain(|(_, n), _| *n != node_id);
            }
            offline
        };
        if now_offline {
            // Group media in flight from it can't continue (no resume): drop
            // the partials so they don't hold inbound slots forever. A 1:1
            // transfer is left alone.
            self.drop_group_inbound(|n, _| *n == node_id);
            self.emit_presence(node_id, false);
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
            let conn = self.dial(addr).await?;
            let proto = proto_of(&conn);
            let (mut send, recv) = conn.open_bi().await?;
            // Opening frame so the accepting side has a stream to write on.
            write_json(&mut send, &Frame::Ping).await?;
            Ok::<_, anyhow::Error>((conn, send, recv, proto))
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
        let (conn, send, recv, proto) = connected;

        let (tx, rx) = mpsc::unbounded_channel();
        self.register_live(node_id, tx.clone(), proto);
        self.set_connecting(node_id, false).await;
        self.flush_queue(node_id, &tx);
        self.emit_presence(node_id, true);
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
        let (handle_id, credits) = {
            let inner = self.inner.lock().unwrap();
            inner
                .peers
                .get(&node_id)
                .and_then(|p| p.live.iter().find(|h| h.tx.same_channel(&tx)))
                .map(|h| (h.id, h.credits.clone()))
                .unwrap_or_else(|| (0, Arc::new(tokio::sync::Semaphore::new(0))))
        };
        let mut send_progress: HashMap<String, (u64, u64)> = HashMap::new();
        if std::env::var("VELTA_P2P_DEBUG").is_ok() {
            eprintln!("[p2p-dbg] session task started for {}", node_id);
        }
        // Right after the opening Ping: tell the peer where each shared group
        // stands (protocol 2 sessions only).
        self.group_session_open(node_id, &tx);
        let mut group_window = (std::time::Instant::now(), 0u32);
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
                            // Send-side media progress: bytes confirmed written
                            // to the wire for this transfer.
                            if let Frame::FileBegin { id, size, .. } = &frame {
                                send_progress.insert(id.clone(), (0, *size));
                            }
                            if let Frame::FileChunk { id, data } = &frame {
                                let decoded = data.len() * 3 / 4;
                                let e = send_progress.entry(id.clone()).or_insert((0u64, 0u64));
                                e.0 += decoded as u64;
                                self.sink.emit(json!({
                                    "kind": "file-progress", "peerId": node_id.to_string(),
                                    "id": id, "dir": "send", "got": e.0, "size": e.1,
                                }));
                            }
                            if let Frame::FileEnd { id } = &frame {
                                send_progress.remove(id);
                                self.sink.emit(json!({
                                    "kind": "file-progress", "peerId": node_id.to_string(),
                                    "id": id, "dir": "send", "got": 0, "size": 0, "done": true,
                                }));
                            }
                            if write_json(&mut send, &frame).await.is_err() {
                                if std::env::var("VELTA_P2P_DEBUG").is_ok() {
                                    eprintln!("[p2p-dbg] write to {} failed", node_id);
                                }
                                break;
                            }
                            // Group media: a chunk on the wire hands its credit
                            // back to the streaming task and moves the progress.
                            match &frame {
                                Frame::GroupFileChunk { id, data, .. } => {
                                    credits.add_permits(1);
                                    self.group_file_wrote(node_id, id, (data.len() * 3 / 4) as u64);
                                }
                                Frame::GroupFileEnd { id, .. } => self.group_file_done(node_id, id),
                                _ => {}
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
                            let frame: Frame = frame;
                            if (frame.is_group() && !frame.is_group_file()) || matches!(frame, Frame::Typing { .. }) {
                                if group_window.0.elapsed() >= Duration::from_secs(1) {
                                    group_window = (std::time::Instant::now(), 0);
                                }
                                group_window.1 += 1;
                                if group_window.1 > GROUP_FRAMES_PER_SEC {
                                    continue;
                                }
                            }
                            let new_roster = matches!(frame, Frame::GroupState { .. });
                            self.handle_frame(node_id, frame, &tx);
                            if new_roster {
                                // A roster can introduce members to dial.
                                self.trigger_group_dials();
                            }
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
        // Session ended with transfers still in flight: their tail frames were
        // lost on the dead stream. Tell the UI which sends failed so it can
        // offer retry — there is no resume.
        for (id, _) in send_progress {
            self.sink.emit(json!({
                "kind": "file-progress", "peerId": node_id.to_string(),
                "id": id, "dir": "send", "failed": true,
            }));
        }
        // Group media over this session is lost too (per member: Retry).
        credits.close();
        self.group_files_failed(node_id, handle_id);
        self.remove_live(node_id, handle_id);
    }

    fn handle_frame(&self, node_id: NodeId, frame: Frame, tx: &mpsc::UnboundedSender<Frame>) {
        // An introduced member may only speak group frames: a 1:1 msg/file
        // from one would otherwise land in a peer record and surface as a
        // `p2p:` chat the user never paired.
        let introduced = self
            .inner
            .lock()
            .unwrap()
            .peers
            .get(&node_id)
            .map_or(false, |p| p.kind == PeerKind::Introduced);
        if introduced && !frame.is_group() {
            return;
        }
        if frame.is_group_file() {
            self.on_group_file(node_id, frame, tx);
            return;
        }
        if frame.is_group() {
            self.handle_group_frame(node_id, frame, tx);
            return;
        }
        match frame {
            Frame::Ping => {}
            // Dispatched above; kept for exhaustiveness.
            Frame::GroupState { .. }
            | Frame::GroupSync { .. }
            | Frame::GroupMsg { .. }
            | Frame::GroupAck { .. }
            | Frame::GroupLeave { .. }
            | Frame::GroupGone { .. }
            | Frame::GroupCaps { .. }
            | Frame::GroupFileBegin { .. }
            | Frame::GroupFileChunk { .. }
            | Frame::GroupFileEnd { .. } => {}
            // A newer peer's frame type: ignore it, keep the session.
            Frame::Unknown => {}
            // 1:1 typing hint (group typing is dispatched with the group frames).
            Frame::Typing { gid: None, on } => self.on_typing(node_id, on, tx),
            Frame::Typing { gid: Some(_), .. } => {}
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
            Frame::Msg { id, ts, text, reply_to, reply_text } => {
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
                            reply_to: reply_to.clone(),
                            reply_text: reply_text.clone(),
                            file: None,
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
                    "reply_to": reply_to,
                    "reply_text": reply_text,
                }));
            }
            Frame::FileBegin { id, ts, name, size, mime, caption } => {
                // The transfer id becomes part of the partial file's path, so a
                // peer-supplied id must be a plain token (ours are random_id()
                // hex) — never separators or "..".
                if !is_safe_transfer_id(&id) {
                    self.sink.emit(json!({
                        "kind": "error", "peerId": node_id.to_string(),
                        "message": "rejected file: malformed transfer id",
                    }));
                    return;
                }
                if size > MAX_FILE_BYTES {
                    self.sink.emit(json!({
                        "kind": "error", "peerId": node_id.to_string(),
                        "message": format!("rejected file: {} bytes over the cap", size),
                    }));
                    return;
                }
                // V-10/#67: concurrency limits on top of the size cap.
                {
                    let rx = self.rx_files.lock().unwrap();
                    if rx.get(&(node_id, id.clone())).map_or(false, |t| t.gid.is_some()) {
                        return;
                    }
                    let for_peer = rx.keys().filter(|(n, _)| *n == node_id).count();
                    if for_peer >= MAX_INBOUND_FILES_PER_PEER || rx.len() >= MAX_INBOUND_FILES_TOTAL {
                        drop(rx);
                        self.sink.emit(json!({
                            "kind": "error", "peerId": node_id.to_string(),
                            "message": "rejected file: too many concurrent transfers",
                        }));
                        return;
                    }
                }
                let dir = self.blobs_dir.join(node_id.to_string());
                let _ = std::fs::create_dir_all(&dir);
                let partial = dir.join(format!("partial-{id}"));
                match std::fs::File::create(&partial) {
                    Ok(_) => {
                        self.rx_files.lock().unwrap().insert(
                            (node_id, id.clone()),
                            FileRx { partial, dir, name: sanitize_name(&name), size, mime, caption, ts, got: 0, gid: None },
                        );
                    }
                    Err(e) => self.sink.emit(json!({
                        "kind": "error", "peerId": node_id.to_string(),
                        "message": format!("cannot receive file: {e}"),
                    })),
                }
            }
            Frame::FileChunk { id, data } => {
                let mut rx = self.rx_files.lock().unwrap();
                let key = (node_id, id.clone());
                if let Some(t) = rx.get_mut(&key).filter(|t| t.gid.is_none()) {
                    let bytes = match BASE64.decode(data.as_bytes()) {
                        Ok(b) => b,
                        Err(_) => { rx.remove(&key); return; }
                    };
                    if t.got + bytes.len() as u64 > t.size {
                        // Oversized or corrupt transfer — drop the partial.
                        rx.remove(&key);
                        return;
                    }
                    self.sink.emit(json!({
                        "kind": "file-progress", "peerId": node_id.to_string(),
                        "id": id, "dir": "recv", "got": t.got, "size": t.size,
                    }));
                    use std::io::Write;
                    if t.partial.exists() {
                        let mut f = std::fs::OpenOptions::new().append(true).open(&t.partial).ok();
                        if let Some(f) = f.as_mut() { let _ = f.write_all(&bytes); }
                    }
                    t.got += bytes.len() as u64;
                }
            }
            Frame::FileEnd { id } => {
                let done = {
                    let mut rx = self.rx_files.lock().unwrap();
                    let key = (node_id, id.clone());
                    // A group transfer is finished by its own frame only.
                    if rx.get(&key).map_or(false, |t| t.gid.is_some()) {
                        return;
                    }
                    rx.remove(&key)
                };
                let Some(t) = done else { return };
                let _ = std::fs::File::open(&t.partial).and_then(|f| f.sync_all());
                if t.got != t.size {
                    let _ = std::fs::remove_file(&t.partial);
                    return;
                }
                let final_path = unique_path(&t.dir, &t.name);
                if std::fs::rename(&t.partial, &final_path).is_err() {
                    return;
                }
                let display = final_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| t.name.clone());
                {
                    let mut inner = self.inner.lock().unwrap();
                    if let Some(peer) = inner.peers.get_mut(&node_id) {
                        peer.msgs.push(StoredMsg {
                            id: id.clone(),
                            ts: t.ts,
                            dir: "in".into(),
                            state: "acked".into(),
                            text: t.caption.clone(),
                            reply_to: None,
                            reply_text: None,
                            file: Some(StoredFile {
                                name: display.clone(),
                                size: t.got,
                                mime: t.mime.clone(),
                                path: final_path.to_string_lossy().to_string(),
                            }),
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
                    "ts": t.ts,
                    "text": t.caption,
                    "file": { "name": display, "size": t.got, "mime": t.mime,
                              "path": final_path.to_string_lossy() },
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
        let proto = proto_of(&conn);
        // Paired contacts and members of a group roster we are in are both
        // allowed a session; everyone else goes through pairing below.
        let kind = {
            let inner = self.inner.lock().unwrap();
            inner.peers.get(&node_id).map(|p| p.kind)
        };
        let paired = kind.is_some();

        let (mut send, mut recv) = conn.accept_bi().await?;
        if std::env::var("VELTA_P2P_DEBUG").is_ok() {
            eprintln!("[p2p-dbg] handle_incoming {} paired={}", node_id, paired);
        }
        // An introduced member may still pair for real with a QR token / an
        // approved tap: its first frame is a hello instead of the usual ping.
        let mut pre_hello: Option<Hello> = None;
        let mut pre_framer = Framer::default();
        let mut session = paired;
        if kind == Some(PeerKind::Introduced) {
            let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, pre_framer.read_json_frame::<Value>(&mut recv))
                .await;
            match first {
                Ok(Ok(v)) if v["type"] == "ping" => {}
                Ok(Ok(v)) if v["type"] == "hello" => {
                    pre_hello = serde_json::from_value::<Hello>(v).ok();
                    if pre_hello.is_none() {
                        bail!("bad pairing handshake");
                    }
                    session = false;
                }
                _ => bail!("bad session from introduced member"),
            }
        }
        if session && kind == Some(PeerKind::Introduced) {
            // Opening ping already consumed above; serve (group frames only).
            let (tx, rx) = mpsc::unbounded_channel();
            self.register_live(node_id, tx.clone(), proto);
            self.session_task(node_id, send, recv, tx, rx, pre_framer).await;
            return Ok(());
        }
        if session {
            // The opener's first frame is a Ping; consume it, then serve.
            let mut framer = Framer::default();
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, framer.read_frame::<Frame>(&mut recv))
                .await
            {
                // `Unknown` is rejected here on purpose: a `hello` from a
                // device we still list as paired (it forgot us) used to fail
                // the parse and must keep being refused, not become a session.
                Ok(Ok(Some(f))) if !matches!(f, Frame::Unknown) => {
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
            self.register_live(node_id, tx.clone(), proto);
            self.flush_queue(node_id, &tx);
            self.emit_presence(node_id, true);
            self.session_task(node_id, send, recv, tx, rx, framer).await;
            return Ok(());
        }

        // Pairing: expect Hello. A hello presenting our current invite token
        // is QR proof (the joiner scanned it) — accept. An empty token is a
        // discovery-based request and needs explicit user approval. Anything
        // else is a stale/forged credential and is rejected without a prompt.
        let expected_token = self.inner.lock().unwrap().token.clone();
        let mut framer = pre_framer;
        let hello = match pre_hello {
            Some(h) => Ok(Ok(h)),
            None => tokio::time::timeout(HANDSHAKE_TIMEOUT, framer.read_json_frame::<Hello>(&mut recv)).await,
        };
        let (token, peer_name, addr_strs) = match hello {
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
        self.register_live(node_id, tx.clone(), proto);
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
        let addrs_copy = addrs.clone(); // `addrs` moves into the nearby entry below

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
        // A paired peer whose addresses changed (DHCP, Wi-Fi roam) would be
        // dialed at a dead IP forever — beacons are the live address book.
        if !addrs_copy.is_empty() {
            if let Some(peer) = inner.peers.get_mut(&node_id) {
                if peer.addrs != addrs_copy {
                    peer.addrs = addrs_copy;
                    if peer.kind == PeerKind::Paired {
                        let _ = self.persist_peers(&inner); // best-effort, same as add_peer
                    }
                }
            }
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
// Local groups: engine state + API (no wire messaging yet, see groups.rs)
// ---------------------------------------------------------------------------

/// Label for a device that never told us its name (matches the UI's).
fn fallback_name(id: &NodeId) -> String {
    let s = id.to_string();
    format!("Device {}", &s[s.len() - 4..])
}

/// Whether a peer can take part in groups: its last/current session
/// negotiated protocol 2 (a released 1.4.x build speaks v1 only and would
/// drop the connection on a group frame).
fn group_capable(peer: &Peer) -> bool {
    peer.live.iter().map(|h| h.proto).max().unwrap_or(peer.proto) >= 2
}

/// Roster members of non-removed groups that we have not paired with become
/// `Introduced` entries, so the existing dial / session / presence machinery
/// reaches them. Paired entries are never touched (the local pairing name
/// wins). Roster addresses are only a hint for a member we know no address
/// of; beacons keep them fresh afterwards.
fn rebuild_introduced(peers: &mut HashMap<NodeId, Peer>, groups: &BTreeMap<String, GroupRec>, me: &NodeId) {
    for rec in groups.values().filter(|g| !g.removed) {
        for m in &rec.state.members {
            let Ok(id) = NodeId::from_str(&m.node_id) else { continue };
            if id == *me {
                continue;
            }
            let addrs: Vec<SocketAddr> = m.addrs.iter().filter_map(|a| a.parse().ok()).collect();
            let name = if m.name.is_empty() { fallback_name(&id) } else { m.name.clone() };
            match peers.get_mut(&id) {
                Some(p) if p.kind == PeerKind::Paired => {}
                Some(p) => {
                    // A name the member told us itself (GroupSync) wins.
                    if p.name.is_empty() {
                        p.name = name;
                    }
                    if p.addrs.is_empty() {
                        p.addrs = addrs;
                    }
                }
                None => {
                    peers.insert(
                        id,
                        Peer {
                            kind: PeerKind::Introduced,
                            name,
                            addrs,
                            proto: 0,
                            live: Vec::new(),
                            connecting: false,
                            queued: Vec::new(),
                            msgs: Vec::new(),
                        },
                    );
                }
            }
        }
    }
}

/// Drops `Introduced` entries no non-removed group lists anymore; dropping a
/// `Peer` drops its senders, which ends its sessions.
fn gc_introduced(peers: &mut HashMap<NodeId, Peer>, groups: &BTreeMap<String, GroupRec>) {
    let referenced: std::collections::HashSet<String> = groups
        .values()
        .filter(|g| !g.removed)
        .flat_map(|g| g.state.members.iter().map(|m| m.node_id.clone()))
        .collect();
    peers.retain(|id, p| p.kind == PeerKind::Paired || referenced.contains(&id.to_string()));
}

impl P2p {
    /// Presence goes to the UI only for paired contacts: the adapter would
    /// create a `p2p:` chat for any peer id it hears about.
    fn emit_presence(&self, node_id: NodeId, online: bool) {
        let introduced = self
            .inner
            .lock()
            .unwrap()
            .peers
            .get(&node_id)
            .map_or(false, |p| p.kind == PeerKind::Introduced);
        if !introduced {
            self.sink
                .emit(json!({ "kind": "presence", "peerId": node_id.to_string(), "online": online }));
        }
        // Members of our groups also get a group-scoped event, the only
        // presence an introduced member ever produces.
        let gids: Vec<String> = {
            let inner = self.inner.lock().unwrap();
            inner
                .groups
                .values()
                .filter(|g| !g.removed && g.state.contains(&node_id))
                .map(|g| g.state.gid.clone())
                .collect()
        };
        if !gids.is_empty() {
            self.sink.emit(json!({
                "kind": "group-presence", "peerId": node_id.to_string(), "online": online, "gids": gids,
            }));
        }
    }

    fn require_paired(&self, node_id: &NodeId) -> Result<()> {
        match self.inner.lock().unwrap().peers.get(node_id) {
            Some(p) if p.kind == PeerKind::Paired => Ok(()),
            _ => bail!("unknown peer"),
        }
    }

    /// Re-derives the introduced entries from the group rosters (add new,
    /// drop unreferenced). Call after every roster change and unpairing.
    fn sync_introduced(&self, inner: &mut Inner) {
        let me = self.node_id();
        let Inner { peers, groups, .. } = inner;
        rebuild_introduced(peers, groups, &me);
        gc_introduced(peers, groups);
    }

    fn persist_groups(&self, inner: &Inner) -> Result<()> {
        save_groups(&self.dir, &inner.groups)
    }

    /// Common tail of every roster change.
    fn groups_changed(&self, inner: &mut Inner) -> Result<()> {
        self.sync_introduced(inner);
        self.persist_groups(inner)
    }

    /// Sender of a live session that may carry group frames. Group frames are
    /// only ever sent through this: sessions negotiated on ALPN v1 yield
    /// `None`, so a 1.4.x peer never sees a frame it would choke on.
    #[cfg(test)]
    fn group_session(&self, node_id: &NodeId) -> Option<FrameTx> {
        v2_tx(&self.inner.lock().unwrap().peers, node_id)
    }

    /// How a device is called in a system line: our own name for a paired
    /// device, else the roster's.
    fn sys_name(&self, inner: &Inner, state: &GroupState, node_hex: &str) -> String {
        if let Ok(id) = NodeId::from_str(node_hex) {
            if let Some(p) = inner.peers.get(&id).filter(|p| !p.name.is_empty()) {
                return p.name.clone();
            }
            if let Some(m) = state.members.iter().find(|m| m.node_id == node_hex).filter(|m| !m.name.is_empty()) {
                return m.name.clone();
            }
            return fallback_name(&id);
        }
        "someone".to_string()
    }

    /// Writes system lines (`kind`, text) to the log of `gid`, oldest first,
    /// and tells the UI. Never fails the caller: a line that can't be stored
    /// is a diagnostic, not a reason to refuse a roster change.
    fn log_sys(&self, inner: &mut Inner, gid: &str, epoch: u64, lines: Vec<(&'static str, String)>) {
        for (i, (kind, text)) in lines.into_iter().enumerate() {
            let now = now_ms();
            let ts_eff = eff_ts(self.group_last_ts(inner, gid), now, now);
            let rec = sys_rec(kind, epoch, i, text, ts_eff);
            if let Err(e) = append_log(&self.dir, gid, &rec) {
                self.sink.emit(json!({ "kind": "error", "message": format!("could not store a group note: {e:#}") }));
                continue;
            }
            inner.grt.ts_eff.insert(gid.to_string(), ts_eff);
            self.sink.emit(json!({
                "kind": "group-system", "gid": gid, "id": rec.id, "sysKind": kind,
                "ts": ts_eff, "tsEff": ts_eff, "text": rec.text,
            }));
        }
    }

    /// System lines for a state change as the creator sees it ("You ...").
    fn creator_lines(&self, inner: &Inner, old: &GroupState, new: &GroupState, left: bool) -> Vec<(&'static str, String)> {
        roster_events(old, new)
            .into_iter()
            .map(|ev| match ev {
                RosterEvent::Added(id) => ("added", format!("You added {}", self.sys_name(inner, new, &id))),
                RosterEvent::Removed(id) if left => ("left", format!("{} left the group", self.sys_name(inner, old, &id))),
                RosterEvent::Removed(id) => ("removed", format!("You removed {}", self.sys_name(inner, old, &id))),
                RosterEvent::Renamed(n) => ("renamed", format!("You renamed the group to \u{201c}{n}\u{201d}")),
                RosterEvent::Disbanded => ("disbanded", "You disbanded the group".to_string()),
            })
            .collect()
    }

    /// System lines for a state change received from the creator.
    fn member_lines(&self, inner: &Inner, old: &GroupState, new: &GroupState) -> Vec<(&'static str, String)> {
        let me = self.node_id().to_string();
        let actor = self.sys_name(inner, new, &new.creator);
        roster_events(old, new)
            .into_iter()
            .map(|ev| match ev {
                RosterEvent::Added(id) if id == me => ("joined", format!("{actor} added you")),
                RosterEvent::Added(id) => ("added", format!("{actor} added {}", self.sys_name(inner, new, &id))),
                RosterEvent::Removed(id) if id == me => ("removed-me", "You were removed from the group".to_string()),
                // The signed roster doesn't say whether they left or were removed.
                RosterEvent::Removed(id) => ("gone", format!("{} is no longer in the group", self.sys_name(inner, old, &id))),
                RosterEvent::Renamed(n) => ("renamed", format!("{actor} renamed the group to \u{201c}{n}\u{201d}")),
                RosterEvent::Disbanded => ("disbanded", format!("{actor} disbanded the group")),
            })
            .collect()
    }

    fn group_json(&self, inner: &Inner, rec: &GroupRec) -> Value {
        let me = self.node_id();
        let members: Vec<Value> = rec
            .state
            .members
            .iter()
            .map(|m| {
                let id = NodeId::from_str(&m.node_id).ok();
                let peer = id.as_ref().and_then(|i| inner.peers.get(i));
                let is_me = id == Some(me);
                // Our own name for a paired device wins, then the name an
                // introduced member claimed for itself, then the roster's.
                let name = match peer {
                    Some(p) if !p.name.is_empty() => p.name.clone(),
                    _ => m.name.clone(),
                };
                json!({
                    "id": m.node_id,
                    "name": name,
                    "self": is_me,
                    "online": is_me || peer.map_or(false, |p| p.online()),
                    "introduced": peer.map_or(false, |p| p.kind == PeerKind::Introduced),
                })
            })
            .collect();
        json!({
            "gid": rec.state.gid,
            "name": rec.state.name,
            "creator": rec.state.creator,
            "epoch": rec.state.epoch,
            "closed": rec.state.closed,
            "removed": rec.removed,
            "canManage": rec.state.creator == me.to_string() && !rec.removed,
            "members": members,
        })
    }

    /// The signed state of a group (what a wire frame will carry).
    #[allow(dead_code)] // wire phase (Phase 2); tests use it now
    pub(crate) fn group_state(&self, gid: &str) -> Result<GroupState> {
        let inner = self.inner.lock().unwrap();
        inner.groups.get(gid).map(|g| g.state.clone()).ok_or_else(|| anyhow!("unknown group"))
    }

    /// All groups, for the UI.
    pub fn groups(&self) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        inner.groups.values().filter(|g| !g.hidden).map(|g| self.group_json(&inner, g)).collect()
    }

    /// A roster above [`LEGACY_MAX_GROUP_MEMBERS`] is rejected (silently) by
    /// v1.4.56/57, which report the same protocol as this build. So it is only
    /// offered when every other member announced a cap that fits it in this
    /// run (`GroupCaps`, sent on every v2 session open). A member that is
    /// offline or never announced one counts as an old build: the error says
    /// who, and that they must be online and updated.
    fn require_group_cap(&self, inner: &Inner, members: &[GroupMember]) -> Result<()> {
        if members.len() <= LEGACY_MAX_GROUP_MEMBERS {
            return Ok(());
        }
        let me = self.node_id().to_string();
        for m in members.iter().filter(|m| m.node_id != me) {
            let Ok(id) = NodeId::from_str(&m.node_id) else { continue };
            if (inner.grt.caps.get(&id).copied().unwrap_or(0) as usize) < members.len() {
                bail!(
                    "{} may not support groups of more than {LEGACY_MAX_GROUP_MEMBERS} (older Velta, or not online since the update) — update it and keep it online, or use a smaller group",
                    m.name
                );
            }
        }
        Ok(())
    }

    /// Roster entry for a paired device that may be invited.
    fn invitee_member(&self, inner: &Inner, id: NodeId) -> Result<GroupMember> {
        let peer = inner
            .peers
            .get(&id)
            .filter(|p| p.kind == PeerKind::Paired)
            .ok_or_else(|| anyhow!("only paired devices can be invited"))?;
        let name = if peer.name.is_empty() { fallback_name(&id) } else { peer.name.clone() };
        if !group_capable(peer) {
            bail!("{name} can't join local groups yet (older Velta, or not connected since the update)");
        }
        Ok(GroupMember {
            node_id: id.to_string(),
            name,
            addrs: peer.addrs.iter().take(MAX_MEMBER_ADDRS).map(|a| a.to_string()).collect(),
        })
    }

    /// Creates a group of this device plus 1..=4 paired devices (each must
    /// speak protocol 2; above 3 invitees each must also be a build that
    /// announced it handles groups of that size). Epoch 1, signed with the identity key. Delivering
    /// the state to the invitees is the wire phase's job.
    pub fn group_create(self: &Arc<Self>, name: &str, member_ids: &[String]) -> Result<Value> {
        let name = name.trim().to_string();
        check_group_name(&name)?;
        if member_ids.is_empty() {
            bail!("pick at least one member");
        }
        if member_ids.len() > MAX_GROUP_MEMBERS - 1 {
            bail!("a local group holds at most {MAX_GROUP_MEMBERS} members");
        }
        let me = self.node_id();
        let mut inner = self.inner.lock().unwrap();
        if inner.groups.values().filter(|g| !g.hidden).count() >= MAX_GROUPS {
            bail!("too many local groups (max {MAX_GROUPS}) — delete one first");
        }
        let my_name = if inner.name.is_empty() { fallback_name(&me) } else { inner.name.clone() };
        let mut members = vec![GroupMember { node_id: me.to_string(), name: my_name, addrs: Vec::new() }];
        for id in member_ids {
            let id = NodeId::from_str(id).map_err(|_| anyhow!("bad member id"))?;
            if id == me || members.iter().any(|m| m.node_id == id.to_string()) {
                bail!("duplicate member");
            }
            members.push(self.invitee_member(&inner, id)?);
        }
        self.require_group_cap(&inner, &members)?;
        let mut state = GroupState {
            gid: new_gid(),
            creator: me.to_string(),
            epoch: 1,
            name,
            closed: false,
            members,
            sig: String::new(),
        };
        state.sign(&self.secret)?;
        state.check()?;
        let gid = state.gid.clone();
        inner.groups.insert(gid.clone(), GroupRec::new(state));
        self.groups_changed(&mut inner)?;
        self.log_sys(&mut inner, &gid, 1, vec![("created", "You created the group".to_string())]);
        self.announce_state(&inner, &gid, &[]);
        Ok(self.group_json(&inner, &inner.groups[&gid]))
    }

    /// Creator-only edit: runs `edit` on a copy of the state, bumps the
    /// epoch, re-signs, validates and stores it.
    fn edit_group(
        &self,
        gid: &str,
        edit: impl FnOnce(&Inner, &mut GroupState) -> Result<()>,
    ) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.edit_group_locked(&mut inner, gid, false, edit)
    }

    /// `left`: the removal is a member's own leave request (system line
    /// "X left" instead of "You removed X").
    fn edit_group_locked(
        &self,
        inner: &mut Inner,
        gid: &str,
        left: bool,
        edit: impl FnOnce(&Inner, &mut GroupState) -> Result<()>,
    ) -> Result<Value> {
        let me = self.node_id();
        let rec = inner.groups.get(gid).ok_or_else(|| anyhow!("unknown group"))?;
        if rec.state.creator != me.to_string() {
            bail!("only the group's creator can change it");
        }
        if rec.removed {
            bail!("this group is closed");
        }
        let mut state = rec.state.clone();
        // Everyone in the old roster hears about the change, including a
        // member it just removed (that is how it learns).
        let before: Vec<String> = state.members.iter().map(|m| m.node_id.clone()).collect();
        let old_state = state.clone();
        edit(inner, &mut state)?;
        state.epoch += 1;
        state.sign(&self.secret)?;
        state.check()?;
        let lines = self.creator_lines(inner, &old_state, &state, left);
        let epoch = state.epoch;
        let rec = inner.groups.get_mut(gid).expect("checked above");
        rec.removed = state.closed;
        rec.state = state;
        self.groups_changed(inner)?;
        self.log_sys(inner, gid, epoch, lines);
        // Nobody replays under the old roster any more.
        inner.grt.gone.retain(|(g, _)| g != gid);
        if inner.groups[gid].removed {
            inner.grt.links.retain(|(g, _), _| g != gid);
        }
        self.announce_state(inner, gid, &before);
        let group = self.group_json(inner, &inner.groups[gid]);
        self.sink.emit(json!({ "kind": "group-state", "group": group.clone() }));
        Ok(group)
    }

    /// Adds a paired device (≤ 5 members in total).
    pub fn group_add(&self, gid: &str, node_id: &str) -> Result<Value> {
        let id = NodeId::from_str(node_id).map_err(|_| anyhow!("bad member id"))?;
        self.edit_group(gid, |inner, st| {
            if st.members.len() >= MAX_GROUP_MEMBERS {
                bail!("a local group holds at most {MAX_GROUP_MEMBERS} members");
            }
            if st.contains(&id) {
                bail!("already a member");
            }
            st.members.push(self.invitee_member(inner, id)?);
            self.require_group_cap(inner, &st.members)?;
            Ok(())
        })
    }

    /// Removes a member (not the creator). A member's own leave request is
    /// handled the same way by the creator.
    pub fn group_remove(&self, gid: &str, node_id: &str) -> Result<Value> {
        let id = NodeId::from_str(node_id).map_err(|_| anyhow!("bad member id"))?;
        self.edit_group(gid, |_, st| {
            if id.to_string() == st.creator {
                bail!("the creator can't be removed — disband the group instead");
            }
            if !st.contains(&id) {
                bail!("not a member");
            }
            st.members.retain(|m| m.node_id != id.to_string());
            Ok(())
        })
    }

    pub fn group_rename(&self, gid: &str, name: &str) -> Result<Value> {
        let name = name.trim().to_string();
        check_group_name(&name)?;
        self.edit_group(gid, |_, st| {
            st.name = name;
            Ok(())
        })
    }

    /// Creator closes the group: members mark it read-only.
    pub fn group_disband(&self, gid: &str) -> Result<Value> {
        self.edit_group(gid, |_, st| {
            st.closed = true;
            st.members.truncate(1); // the creator is always first
            Ok(())
        })
    }

    /// A member leaves: the group becomes read-only here (history kept) and
    /// `pending_leave` remembers to tell the creator once reachable.
    pub fn group_leave(&self, gid: &str) -> Result<Value> {
        let me = self.node_id();
        let mut inner = self.inner.lock().unwrap();
        let rec = inner.groups.get_mut(gid).ok_or_else(|| anyhow!("unknown group"))?;
        if rec.state.creator == me.to_string() {
            bail!("the creator can't leave — disband the group instead");
        }
        rec.removed = true;
        rec.pending_leave = true;
        let creator = rec.state.creator.clone();
        let epoch = rec.state.epoch;
        self.groups_changed(&mut inner)?;
        self.log_sys(&mut inner, gid, epoch, vec![("left-me", "You left the group".to_string())]);
        inner.grt.links.retain(|(g, _), _| g != gid);
        // Reachable creator: tell it now; otherwise the session-open hook
        // retries until its new roster (without us) arrives.
        if let Some(tx) = NodeId::from_str(&creator).ok().and_then(|c| v2_tx(&inner.peers, &c)) {
            let _ = tx.send(Frame::GroupLeave { gid: gid.to_string() });
        }
        Ok(self.group_json(&inner, &inner.groups[gid]))
    }

    /// Forgets a group completely: record, log, runtime links.
    fn purge_group(&self, inner: &mut Inner, gid: &str) {
        inner.groups.remove(gid);
        delete_log(&self.dir, gid);
        self.delete_group_blobs(gid);
        inner.grt.links.retain(|(g, _), _| g != gid);
        inner.grt.gone.retain(|(g, _)| g != gid);
        inner.grt.gap_sent.retain(|(g, _), _| g != gid);
        inner.grt.ts_eff.remove(gid);
        self.sync_introduced(inner);
        if let Err(e) = self.persist_groups(inner) {
            self.sink.emit(json!({ "kind": "error", "message": format!("could not save groups: {e:#}") }));
        }
        self.sink.emit(json!({ "kind": "group-deleted", "gid": gid }));
    }

    /// "Delete chat" for a group that is over (left, removed or disbanded):
    /// the local log goes. A leave the creator has not heard of yet keeps a
    /// hidden stub until it did.
    pub fn group_delete(&self, gid: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let rec = inner.groups.get_mut(gid).ok_or_else(|| anyhow!("unknown group"))?;
        if !rec.removed {
            bail!("leave or disband the group first");
        }
        if rec.pending_leave {
            rec.hidden = true;
            delete_log(&self.dir, gid);
            self.delete_group_blobs(gid);
            inner.grt.ts_eff.remove(gid);
            self.persist_groups(&inner)?;
            self.sink.emit(json!({ "kind": "group-deleted", "gid": gid }));
        } else {
            self.purge_group(&mut inner, gid);
        }
        Ok(())
    }

    /// Which groups an unpairing of `peer_str` touches: groups it created
    /// (they will be deleted here) and groups it is merely a member of (it
    /// stays reachable for them as an introduced member).
    pub fn peer_group_impact(&self, peer_str: &str) -> Result<Value> {
        let id = NodeId::from_str(peer_str)?.to_string();
        let me = self.node_id().to_string();
        let inner = self.inner.lock().unwrap();
        let mut created = Vec::new();
        let mut member = Vec::new();
        for g in inner.groups.values().filter(|g| !g.hidden) {
            let entry = json!({ "gid": g.state.gid, "name": g.state.name, "removed": g.removed });
            if g.state.creator == id && g.state.creator != me {
                created.push(entry);
            } else if !g.removed && g.state.contains(&NodeId::from_str(&id)?) {
                member.push(entry);
            }
        }
        Ok(json!({ "created": created, "member": member }))
    }

    /// Applies a signed state received from `from` over a session.
    ///
    /// * First contact for a group is accepted only from its creator, who
    ///   must be one of our *paired* devices (no consent dialog: the group
    ///   appears and can be left).
    /// * Later states are accepted from any current member (relay): the
    ///   creator's signature is what authenticates them.
    /// * A state with an epoch that is not newer is ignored (replays and
    ///   rollbacks are harmless).
    /// * At most [`MAX_GROUPS`] groups, at most 5 members per state.
    #[allow(dead_code)] // the wire path uses apply_state_locked; tests call this
    pub(crate) fn apply_group_state(&self, state: GroupState, from: NodeId) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.apply_state_locked(&mut inner, state, from)
    }

    fn apply_state_locked(&self, inner: &mut Inner, state: GroupState, from: NodeId) -> Result<Value> {
        let me = self.node_id();
        let verdict = evaluate_incoming(inner.groups.get(&state.gid), &state, &me)?;
        let gid = state.gid.clone();
        let mut newly_removed = None;
        let mut sys: Vec<(&'static str, String)> = Vec::new();
        let mut changed: Option<(GroupState, GroupState)> = None;
        let sys_epoch = state.epoch;
        let result = match verdict {
            Evaluation::Stale => return Ok(json!({ "result": "stale" })),
            Evaluation::Create => {
                let creator_paired = from.to_string() == state.creator
                    && inner.peers.get(&from).map(|p| p.kind) == Some(PeerKind::Paired);
                if !creator_paired {
                    bail!("a new group is accepted only from its creator, a paired device");
                }
                if inner.groups.values().filter(|g| !g.hidden).count() >= MAX_GROUPS {
                    bail!("too many local groups (max {MAX_GROUPS})");
                }
                let actor = self.sys_name(inner, &state, &state.creator);
                sys.push(("joined", format!("{actor} added you")));
                inner.groups.insert(gid.clone(), GroupRec::new(state));
                "created"
            }
            Evaluation::Update { removed_me } => {
                let rec = inner.groups.get_mut(&gid).expect("evaluated against it");
                if !rec.state.contains(&from) {
                    bail!("sender is not a member of that group");
                }
                let was_removed = rec.removed;
                let closed = state.closed;
                // Notes only while the chat is live: after a leave/removal
                // the history is frozen, and a deleted chat has no log.
                if !was_removed {
                    changed = Some((rec.state.clone(), state.clone()));
                }
                rec.state = state;
                // A member who asked to leave stays out even if the creator
                // has not processed the request yet.
                rec.removed = rec.pending_leave || removed_me;
                if removed_me {
                    // The creator processed our leave (or removed us).
                    rec.pending_leave = false;
                }
                if rec.removed && !was_removed {
                    newly_removed = Some(if closed { "closed" } else { "removed" });
                }
                "updated"
            }
        };
        if let Some((old, new)) = changed {
            sys = self.member_lines(inner, &old, &new);
        }
        self.groups_changed(inner)?;
        self.log_sys(inner, &gid, sys_epoch, sys);
        // A chat the user already deleted was only kept to tell the creator
        // about a leave; now that the creator answered, nothing is left.
        if inner.groups.get(&gid).map_or(false, |r| r.hidden && !r.pending_leave) {
            self.purge_group(inner, &gid);
            return Ok(json!({ "result": result }));
        }
        if let Some(reason) = newly_removed {
            self.sink.emit(json!({ "kind": "group-removed", "gid": gid, "reason": reason }));
        }
        self.after_state_applied(inner, &gid);
        Ok(json!({ "result": result, "group": self.group_json(inner, &inner.groups[&gid]) }))
    }

    /// A new roster is in force: forget stale "gone" marks, tell the UI, and
    /// restate where we stand (our epoch) to every member we are connected
    /// to, which also lets the author side start replaying.
    fn after_state_applied(&self, inner: &mut Inner, gid: &str) {
        inner.grt.gone.retain(|(g, _)| g != gid);
        let Some(rec) = inner.groups.get(gid) else { return };
        let group = self.group_json(inner, rec);
        self.sink.emit(json!({ "kind": "group-state", "group": group }));
        if rec.removed {
            inner.grt.links.retain(|(g, _), _| g != gid);
            return;
        }
        let me = self.node_id();
        let members: Vec<NodeId> = rec
            .state
            .members
            .iter()
            .filter_map(|m| NodeId::from_str(&m.node_id).ok())
            .filter(|id| *id != me)
            .collect();
        for m in &members {
            if let Some(tx) = v2_tx(&inner.peers, m) {
                let _ = tx.send(self.sync_frame(inner, rec, m));
            }
        }
        // Links of members that are gone from the roster are meaningless.
        inner.grt.links.retain(|(g, n), _| g != gid || members.contains(n));
        for m in &members {
            self.pump(inner, gid, m, None);
        }
    }

    // -- group wire protocol -------------------------------------------------

    fn my_name(&self, inner: &Inner) -> String {
        if inner.name.is_empty() { fallback_name(&self.node_id()) } else { inner.name.clone() }
    }

    /// Our `GroupSync` for `rec`, addressed to `to`.
    fn sync_frame(&self, inner: &Inner, rec: &GroupRec, to: &NodeId) -> Frame {
        Frame::GroupSync {
            gid: rec.state.gid.clone(),
            epoch: rec.state.epoch,
            have: rec.have.get(&to.to_string()).copied().unwrap_or(0),
            name: self.my_name(inner),
        }
    }

    /// Diagnostics line for something a peer sent that we refuse.
    fn group_warn(&self, node: &NodeId, message: String) {
        self.sink.emit(json!({ "kind": "error", "peerId": node.to_string(), "message": message }));
    }

    /// Sends the current signed state (then our `GroupSync`) to every
    /// roster member and to `extra` (members just removed) that is
    /// connected on protocol 2. Offline ones get it when they next sync.
    fn announce_state(&self, inner: &Inner, gid: &str, extra: &[String]) {
        let Some(rec) = inner.groups.get(gid) else { return };
        let me = self.node_id();
        let mut targets: Vec<NodeId> = Vec::new();
        for id in rec.state.members.iter().map(|m| &m.node_id).chain(extra.iter()) {
            if let Ok(n) = NodeId::from_str(id) {
                if n != me && !targets.contains(&n) {
                    targets.push(n);
                }
            }
        }
        for n in targets {
            let Some(tx) = v2_tx(&inner.peers, &n) else { continue };
            let _ = tx.send(Frame::GroupState { state: rec.state.clone() });
            if !rec.removed && rec.state.contains(&n) {
                let _ = tx.send(self.sync_frame(inner, rec, &n));
            }
        }
    }

    /// Dials every group member we are not connected to (the maintenance
    /// loop does the same every 10 s; this is the fast path).
    fn trigger_group_dials(self: &Arc<Self>) {
        let ids: Vec<NodeId> = {
            let inner = self.inner.lock().unwrap();
            let me = self.node_id();
            inner
                .groups
                .values()
                .filter(|g| !g.removed || g.pending_leave)
                .flat_map(|g| g.state.members.iter())
                .filter_map(|m| NodeId::from_str(&m.node_id).ok())
                .filter(|id| *id != me && inner.peers.contains_key(id))
                .collect()
        };
        for id in ids {
            self.trigger_connect(id);
        }
    }

    /// First frames of a new session: per shared group our state of the
    /// world; a creator whose invitee has not confirmed the roster sends it
    /// first, and a member that left retries its `GroupLeave`.
    fn group_session_open(&self, node_id: NodeId, tx: &FrameTx) {
        let me = self.node_id().to_string();
        let key = node_id.to_string();
        let inner = self.inner.lock().unwrap();
        let proto = inner
            .peers
            .get(&node_id)
            .and_then(|p| p.live.iter().find(|h| h.tx.same_channel(tx)))
            .map_or(0, |h| h.proto);
        if proto < 2 {
            return;
        }
        let _ = tx.send(Frame::GroupCaps { max: MAX_GROUP_MEMBERS as u8 });
        for rec in inner.groups.values() {
            if rec.removed {
                if rec.pending_leave && rec.state.creator == key {
                    let _ = tx.send(Frame::GroupLeave { gid: rec.state.gid.clone() });
                }
                continue;
            }
            if !rec.state.contains(&node_id) {
                continue;
            }
            if rec.state.creator == me && rec.state_cursor.get(&key).copied().unwrap_or(0) < rec.state.epoch {
                let _ = tx.send(Frame::GroupState { state: rec.state.clone() });
            }
            let _ = tx.send(self.sync_frame(&inner, rec, &node_id));
        }
    }

    fn handle_group_frame(&self, from: NodeId, frame: Frame, tx: &FrameTx) {
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let proto = inner
            .peers
            .get(&from)
            .and_then(|p| p.live.iter().find(|h| h.tx.same_channel(tx)))
            .map_or(0, |h| h.proto);
        if proto < 2 {
            // A group frame on a v1 session is a protocol violation: ignore.
            return;
        }
        match frame {
            Frame::GroupState { state } => {
                if let Err(e) = self.apply_state_locked(inner, state, from) {
                    self.group_warn(&from, format!("group state ignored: {e:#}"));
                }
            }
            Frame::GroupSync { gid, epoch, have, name } => {
                self.on_group_sync(inner, from, tx, &gid, epoch, have, &name)
            }
            Frame::GroupMsg { gid, from: claimed, seq, id, ts, text, reply_to, reply_text } => self.on_group_msg(
                inner,
                from,
                tx,
                GroupIn { gid, claimed, seq, id, ts, text, reply_to, reply_text },
            ),
            Frame::GroupAck { gid, have } => self.on_group_ack(inner, from, &gid, have),
            Frame::GroupCaps { max } => {
                inner.grt.caps.insert(from, max);
            }
            Frame::GroupLeave { gid } => self.on_group_leave(inner, from, &gid),
            Frame::Typing { gid: Some(gid), on } => {
                let member = inner.groups.get(&gid).map_or(false, |r| !r.removed && r.state.contains(&from));
                if member && self.typing_gate(inner, &gid, from, on) {
                    let name = inner.peers.get(&from).map(|p| p.name.clone()).filter(|n| !n.is_empty());
                    self.sink.emit(json!({
                        "kind": "group-typing", "gid": gid, "from": from.to_string(),
                        "name": name.unwrap_or_else(|| fallback_name(&from)), "on": on,
                    }));
                }
            }
            Frame::GroupGone { gid } => {
                // Believed only about the sender itself.
                if inner.groups.get(&gid).map_or(false, |r| !r.removed && r.state.contains(&from)) {
                    inner.grt.links.remove(&(gid.clone(), from));
                    inner.grt.gone.insert((gid, from));
                }
            }
            _ => {}
        }
    }

    fn on_group_sync(
        &self,
        inner: &mut Inner,
        from: NodeId,
        tx: &FrameTx,
        gid: &str,
        epoch: u64,
        have: u64,
        name: &str,
    ) {
        let me = self.node_id().to_string();
        let key = from.to_string();
        let Some(rec) = inner.groups.get(gid) else {
            let _ = tx.send(Frame::GroupGone { gid: gid.to_string() });
            return;
        };
        if rec.removed {
            // Disbanded / left. A peer still on an older roster is told (a
            // member that was offline during a disband learns it here);
            // anyone else just hears that I am out.
            let reply = if epoch < rec.state.epoch {
                Frame::GroupState { state: rec.state.clone() }
            } else {
                Frame::GroupGone { gid: gid.to_string() }
            };
            let _ = tx.send(reply);
            return;
        }
        if !rec.state.contains(&from) {
            // Not (or no longer) in my roster: no messages, but a member who
            // was removed learns it here. Knowing the gid is the capability.
            if epoch < rec.state.epoch {
                let _ = tx.send(Frame::GroupState { state: rec.state.clone() });
            }
            return;
        }
        let my_epoch = rec.state.epoch;
        let is_creator = rec.state.creator == me;
        // An introduced member's self-claimed name (display only).
        if !name.is_empty() && name.chars().count() <= 64 {
            if let Some(p) = inner.peers.get_mut(&from) {
                if p.kind == PeerKind::Introduced {
                    p.name = name.to_string();
                }
            }
        }
        inner.grt.gone.remove(&(gid.to_string(), from));
        let rec = inner.groups.get_mut(gid).expect("checked above");
        let mut dirty = false;
        if is_creator {
            let held = epoch.min(my_epoch);
            if rec.state_cursor.get(&key).copied().unwrap_or(0) < held {
                rec.state_cursor.insert(key.clone(), held);
                dirty = true;
            }
        }
        // `have` is a cumulative ack of my own messages.
        let acked = have.min(rec.next_seq.saturating_sub(1));
        let mut ack_event = None;
        if acked > rec.sent_cursor.get(&key).copied().unwrap_or(0) {
            rec.sent_cursor.insert(key.clone(), acked);
            dirty = true;
            ack_event = Some(acked);
        }
        let pushed = rec.sent_cursor.get(&key).copied().unwrap_or(0);
        if dirty {
            if let Err(e) = self.persist_groups(inner) {
                self.group_warn(&from, format!("could not save group state: {e:#}"));
            }
        }
        if let Some(h) = ack_event {
            self.sink.emit(json!({ "kind": "group-ack", "gid": gid, "by": key, "have": h }));
        }
        inner.grt.links.insert((gid.to_string(), from), GroupLink { epoch, pushed });
        let rec = &inner.groups[gid];
        if epoch < my_epoch {
            // Peer is behind: relay the roster; it re-syncs after applying.
            let _ = tx.send(Frame::GroupState { state: rec.state.clone() });
        } else if epoch > my_epoch {
            // Peer is ahead: restate my epoch so it relays its roster to me.
            let _ = tx.send(self.sync_frame(inner, rec, &from));
        } else {
            self.pump(inner, gid, &from, None);
        }
    }

    fn on_group_msg(&self, inner: &mut Inner, from: NodeId, tx: &FrameTx, m: GroupIn) {
        let key = from.to_string();
        if m.claimed != key {
            self.group_warn(&from, "group message with a forged sender dropped".into());
            return;
        }
        let Some(rec) = inner.groups.get(&m.gid) else {
            let _ = tx.send(Frame::GroupGone { gid: m.gid });
            return;
        };
        if rec.removed {
            let _ = tx.send(Frame::GroupGone { gid: m.gid });
            return;
        }
        if !rec.state.contains(&from) {
            return; // not a member (any more): dropped silently
        }
        if m.seq == 0 || m.text.is_empty() || m.text.len() > MAX_GROUP_TEXT || !is_safe_transfer_id(&m.id) {
            return;
        }
        let have = rec.have.get(&key).copied().unwrap_or(0);
        if m.seq <= have {
            // Duplicate (a replay after a lost ack): re-ack so the author's
            // cursor catches up.
            let _ = tx.send(Frame::GroupAck { gid: m.gid, have });
            return;
        }
        if m.seq > have + 1 {
            // Gap: drop it and ask the author to replay from have+1 (once
            // per `have`, so a burst of out-of-order frames is one request).
            let marker = (m.gid.clone(), from);
            if inner.grt.gap_sent.get(&marker) != Some(&have) {
                inner.grt.gap_sent.insert(marker, have);
                let _ = tx.send(self.sync_frame(inner, rec, &from));
            }
            return;
        }
        // Exactly the next one: log line first, then the counter.
        let now = now_ms();
        let prev = self.group_last_ts(inner, &m.gid);
        let ts_eff = eff_ts(prev, m.ts, now);
        let line = GroupLogRec {
            seq: m.seq,
            from: key.clone(),
            id: m.id.clone(),
            ts: m.ts,
            ts_eff,
            dir: "in".into(),
            text: m.text.clone(),
            reply_to: m.reply_to.clone(),
            reply_text: m.reply_text.clone(),
            file: None,
        };
        if let Err(e) = append_log(&self.dir, &m.gid, &line) {
            self.group_warn(&from, format!("could not store a group message: {e:#}"));
            return;
        }
        inner.grt.ts_eff.insert(m.gid.clone(), ts_eff);
        inner.grt.gap_sent.remove(&(m.gid.clone(), from));
        let rec = inner.groups.get_mut(&m.gid).expect("checked above");
        rec.have.insert(key.clone(), m.seq);
        if let Err(e) = self.persist_groups(inner) {
            // Not fatal: the counter is rebuilt from the log on restart.
            self.group_warn(&from, format!("could not save group state: {e:#}"));
        }
        let name = inner.peers.get(&from).map(|p| p.name.clone()).filter(|n| !n.is_empty());
        let name = name.unwrap_or_else(|| fallback_name(&from));
        self.sink.emit(json!({
            "kind": "group-message", "gid": m.gid, "from": key, "name": name,
            "id": m.id, "seq": m.seq, "ts": m.ts, "tsEff": ts_eff, "text": m.text,
            "replyTo": m.reply_to, "replyText": m.reply_text,
        }));
        let _ = tx.send(Frame::GroupAck { gid: m.gid, have: m.seq });
    }

    fn on_group_ack(&self, inner: &mut Inner, from: NodeId, gid: &str, have: u64) {
        let key = from.to_string();
        let Some(rec) = inner.groups.get_mut(gid) else { return };
        if rec.removed || !rec.state.contains(&from) {
            return;
        }
        let have = have.min(rec.next_seq.saturating_sub(1));
        if have <= rec.sent_cursor.get(&key).copied().unwrap_or(0) {
            return;
        }
        rec.sent_cursor.insert(key.clone(), have);
        if let Err(e) = self.persist_groups(inner) {
            self.group_warn(&from, format!("could not save group state: {e:#}"));
        }
        self.sink.emit(json!({ "kind": "group-ack", "gid": gid, "by": key, "have": have }));
        // The window moved: send what was held back.
        self.pump(inner, gid, &from, None);
    }

    fn on_group_leave(&self, inner: &mut Inner, from: NodeId, gid: &str) {
        let me = self.node_id().to_string();
        let ok = inner
            .groups
            .get(gid)
            .map_or(false, |r| r.state.creator == me && !r.removed && r.state.contains(&from) && from.to_string() != me);
        if !ok {
            return; // only the creator edits the roster
        }
        let id = from.to_string();
        let res = self.edit_group_locked(inner, gid, true, |_, st| {
            st.members.retain(|m| m.node_id != id);
            Ok(())
        });
        if let Err(e) = res {
            self.group_warn(&from, format!("could not process a leave request: {e:#}"));
        }
    }

    /// Whether a typing hint is worth forwarding (state change, or the same
    /// state after [`TYPING_MIN_GAP`]).
    fn typing_gate(&self, inner: &mut Inner, key: &str, from: NodeId, on: bool) -> bool {
        let now = std::time::Instant::now();
        let slot = inner.grt.typing_seen.entry((key.to_string(), from)).or_insert((!on, now));
        let fresh = slot.0 != on || now.duration_since(slot.1) >= TYPING_MIN_GAP;
        if fresh {
            *slot = (on, now);
        }
        fresh
    }

    /// A 1:1 typing hint from a paired peer on a protocol-2 session.
    fn on_typing(&self, from: NodeId, on: bool, tx: &FrameTx) {
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let ok = inner.peers.get(&from).map_or(false, |p| {
            p.kind == PeerKind::Paired && p.live.iter().any(|h| h.proto >= 2 && h.tx.same_channel(tx))
        });
        if ok && self.typing_gate(inner, "", from, on) {
            self.sink.emit(json!({ "kind": "typing", "peerId": from.to_string(), "on": on }));
        }
    }

    /// Tells a paired peer we start/stop typing. Live only: nothing is queued,
    /// an offline peer or a protocol-1 session gets nothing. Returns whether
    /// the hint went out.
    pub fn typing_peer(&self, peer_str: &str, on: bool) -> Result<bool> {
        let id = NodeId::from_str(peer_str)?;
        let inner = self.inner.lock().unwrap();
        if inner.peers.get(&id).map(|p| p.kind) != Some(PeerKind::Paired) {
            bail!("unknown peer");
        }
        Ok(v2_tx(&inner.peers, &id).map_or(false, |tx| tx.send(Frame::Typing { gid: None, on }).is_ok()))
    }

    /// Same for a group: every other member with a live protocol-2 session.
    /// Returns how many members it reached.
    pub fn typing_group(&self, gid: &str, on: bool) -> Result<usize> {
        let me = self.node_id();
        let inner = self.inner.lock().unwrap();
        let rec = inner.groups.get(gid).ok_or_else(|| anyhow!("unknown group"))?;
        if rec.removed {
            return Ok(0);
        }
        let mut reached = 0;
        for m in &rec.state.members {
            let Ok(id) = NodeId::from_str(&m.node_id) else { continue };
            if id == me {
                continue;
            }
            if let Some(tx) = v2_tx(&inner.peers, &id) {
                if tx.send(Frame::Typing { gid: Some(gid.to_string()), on }).is_ok() {
                    reached += 1;
                }
            }
        }
        Ok(reached)
    }

    /// Display timestamp of the last record of `gid` (cached after the first
    /// read of the log).
    fn group_last_ts(&self, inner: &mut Inner, gid: &str) -> u64 {
        if let Some(v) = inner.grt.ts_eff.get(gid) {
            return *v;
        }
        let v = scan_log(&self.dir, gid, &self.node_id().to_string()).last_ts_eff;
        inner.grt.ts_eff.insert(gid.to_string(), v);
        v
    }

    /// Puts what `node` is missing of my own messages on its session: only
    /// while it is a roster member, we agree on the epoch (so a removed
    /// member gets nothing) and it did not say it is gone. At most
    /// [`GROUP_WINDOW`] unacked messages are in flight; acks pull the rest.
    /// Returns whether the member is ready (live and in step).
    fn pump(&self, inner: &mut Inner, gid: &str, node: &NodeId, hint: Option<&GroupLogRec>) -> bool {
        let me = self.node_id().to_string();
        let key = node.to_string();
        let Some(rec) = inner.groups.get(gid) else { return false };
        if rec.removed || !rec.state.contains(node) {
            return false;
        }
        let marker = (gid.to_string(), *node);
        if inner.grt.gone.contains(&marker) {
            return false;
        }
        let Some(tx) = v2_tx(&inner.peers, node) else { return false };
        let epoch = rec.state.epoch;
        let cursor = rec.sent_cursor.get(&key).copied().unwrap_or(0);
        let last = rec.next_seq.saturating_sub(1);
        let Some(link) = inner.grt.links.get_mut(&marker) else { return false };
        if link.epoch != epoch {
            return false;
        }
        let first = link.pushed.max(cursor) + 1;
        let upto = last.min(cursor + GROUP_WINDOW);
        if first > upto {
            return true;
        }
        let recs: Vec<GroupLogRec> = match hint {
            Some(h) if h.seq == first && first == upto => vec![h.clone()],
            _ => read_log(&self.dir, gid)
                .into_iter()
                .filter(|r| r.dir == "out" && r.from == me && r.seq >= first && r.seq <= upto)
                .collect(),
        };
        for r in recs {
            let seq = r.seq;
            let frame = Frame::GroupMsg {
                gid: gid.to_string(),
                from: me.clone(),
                seq,
                id: r.id,
                ts: r.ts,
                text: r.text,
                reply_to: r.reply_to,
                reply_text: r.reply_text,
            };
            if tx.send(frame).is_err() {
                break;
            }
            link.pushed = link.pushed.max(seq);
        }
        true
    }

    /// Sends a message to a group: appended to my log first (that is the
    /// queue), then streamed to every member that is connected and in step;
    /// the others get it by replay when they sync.
    pub fn group_send(
        self: &Arc<Self>,
        gid: &str,
        text: &str,
        reply_to: Option<&str>,
        reply_text: Option<&str>,
    ) -> Result<Value> {
        if text.trim().is_empty() || text.len() > MAX_GROUP_TEXT {
            bail!("message must be 1-64k characters");
        }
        let me = self.node_id();
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let rec = inner.groups.get(gid).ok_or_else(|| anyhow!("unknown group"))?;
        if rec.removed {
            bail!("this group is read-only");
        }
        let seq = rec.next_seq;
        let members: Vec<NodeId> = rec
            .state
            .members
            .iter()
            .filter_map(|m| NodeId::from_str(&m.node_id).ok())
            .filter(|id| *id != me)
            .collect();
        let now = now_ms();
        let prev = self.group_last_ts(inner, gid);
        let ts_eff = eff_ts(prev, now, now);
        let line = GroupLogRec {
            seq,
            from: me.to_string(),
            id: random_id(),
            ts: now,
            ts_eff,
            dir: "out".into(),
            text: text.to_string(),
            reply_to: reply_to.map(|s| s.to_string()),
            reply_text: reply_text.map(|s| s.to_string()),
            file: None,
        };
        append_log(&self.dir, gid, &line)?;
        inner.grt.ts_eff.insert(gid.to_string(), ts_eff);
        inner.groups.get_mut(gid).expect("checked above").next_seq = seq + 1;
        if let Err(e) = self.persist_groups(inner) {
            // The log has the message; next_seq is rebuilt from it on restart.
            self.sink.emit(json!({ "kind": "error", "message": format!("could not save group state: {e:#}") }));
        }
        let mut reached = 0;
        for m in &members {
            if self.pump(inner, gid, m, Some(&line)) {
                reached += 1;
            }
        }
        drop(guard);
        // Members that are offline get a dial now; replay follows the sync.
        for m in members {
            self.trigger_connect(m);
        }
        Ok(json!({
            "id": line.id, "seq": seq, "ts": line.ts, "tsEff": ts_eff,
            "queued": reached == 0,
        }))
    }

    /// Last `limit` records of a group's log, oldest first, with who has
    /// acknowledged each of my own messages.
    pub fn group_messages(&self, gid: &str, limit: usize) -> Result<Vec<Value>> {
        let me = self.node_id().to_string();
        // Per-member state of my own media sends (taken before the engine
        // lock: the two are never held together).
        let xfers: HashMap<String, Vec<Value>> = self
            .group_xfers
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, t)| t.gid == gid)
            .map(|(id, t)| (id.clone(), Self::xfer_members_json(t)))
            .collect();
        let inner = self.inner.lock().unwrap();
        let rec = inner.groups.get(gid).ok_or_else(|| anyhow!("unknown group"))?;
        let others: Vec<&str> = rec.state.members.iter().map(|m| m.node_id.as_str()).filter(|id| *id != me).collect();
        Ok(load_group_log(&self.dir, gid, limit)
            .into_iter()
            .map(|r| {
                let delivered: Vec<&str> = if r.dir == "out" {
                    others
                        .iter()
                        .copied()
                        .filter(|id| rec.sent_cursor.get(*id).copied().unwrap_or(0) >= r.seq)
                        .collect()
                } else {
                    Vec::new()
                };
                json!({
                    "seq": r.seq, "from": r.from, "id": r.id, "ts": r.ts, "tsEff": r.ts_eff,
                    "dir": r.dir, "text": r.text, "replyTo": r.reply_to, "replyText": r.reply_text,
                    "delivered": delivered,
                    "sysKind": if r.dir == SYS_DIR { sys_kind(&r.id) } else { None },
                    "file": r.file.as_ref().map(|f| json!({ "name": f.name, "size": f.size, "mime": f.mime, "path": f.path })),
                    "fileMembers": if r.file.is_some() { xfers.get(&r.id).cloned() } else { None },
                })
            })
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Group media (protocol 2): streamed per member, online members only
// ---------------------------------------------------------------------------

impl P2p {
    /// Online (protocol-2, in-step) members of `gid` other than me, and the
    /// rest of the roster. Caller holds the engine lock.
    fn group_file_targets(&self, inner: &Inner, gid: &str) -> Result<(Vec<(NodeId, FileLink)>, Vec<NodeId>)> {
        let me = self.node_id();
        let rec = inner.groups.get(gid).ok_or_else(|| anyhow!("unknown group"))?;
        if rec.removed {
            bail!("this group is read-only");
        }
        let mut online = Vec::new();
        let mut offline = Vec::new();
        for m in &rec.state.members {
            let Ok(id) = NodeId::from_str(&m.node_id) else { continue };
            if id == me {
                continue;
            }
            match v2_link(&inner.peers, &id) {
                Some(link) if !inner.grt.gone.contains(&(gid.to_string(), id)) => online.push((id, link)),
                _ => offline.push(id),
            }
        }
        Ok((online, offline))
    }

    /// Sends a media file to a group: a copy goes under the group's blob dir,
    /// then every member that is online right now gets its own stream of
    /// GroupFileBegin/Chunk/End (96 KB chunks read from the copy, paced by the
    /// session writer). Members that are offline are skipped — files are not
    /// queued — and can be sent the file later with [`P2p::group_file_retry`].
    /// Returns `{id, ts, tsEff, file, members: [{id, state}]}`.
    pub fn group_send_file(self: &Arc<Self>, gid: &str, src: &str, name: &str, caption: &str) -> Result<Value> {
        if caption.len() > MAX_GROUP_TEXT {
            bail!("caption is too long");
        }
        {
            let inner = self.inner.lock().unwrap();
            let (online, _) = self.group_file_targets(&inner, gid)?;
            if online.is_empty() {
                bail!("nobody in this group is online — files are only sent to members who are online");
            }
        }
        let meta = std::fs::metadata(src).context("source file missing")?;
        if !meta.is_file() {
            bail!("not a file");
        }
        if meta.len() > MAX_GROUP_FILE_BYTES {
            bail!("file too large for a local group (cap 32 MB)");
        }
        let safe = sanitize_name(name);
        let mime = mime_for(&safe);
        let id = random_id();
        let dest_dir = self.blobs_dir.join(format!("g-{gid}"));
        std::fs::create_dir_all(&dest_dir)?;
        let dest = dest_dir.join(format!("out-{id}_{safe}"));
        std::fs::copy(src, &dest).context("copy into blobs dir")?;
        let size = std::fs::metadata(&dest)?.len();
        if size > MAX_GROUP_FILE_BYTES {
            let _ = std::fs::remove_file(&dest);
            bail!("file too large for a local group (cap 32 MB)");
        }

        let (links, offline, line) = {
            let mut guard = self.inner.lock().unwrap();
            let inner = &mut *guard;
            let (links, offline) = match self.group_file_targets(inner, gid) {
                Ok((l, _)) if l.is_empty() => {
                    let _ = std::fs::remove_file(&dest);
                    bail!("nobody in this group is online — files are only sent to members who are online");
                }
                Ok(t) => t,
                Err(e) => {
                    let _ = std::fs::remove_file(&dest);
                    return Err(e);
                }
            };
            let now = now_ms();
            let prev = self.group_last_ts(inner, gid);
            let ts_eff = eff_ts(prev, now, now);
            let line = GroupLogRec {
                seq: 0,
                from: self.node_id().to_string(),
                id: id.clone(),
                ts: now,
                ts_eff,
                dir: "out".into(),
                text: caption.to_string(),
                reply_to: None,
                reply_text: None,
                file: Some(GroupFileRec {
                    name: safe.clone(),
                    size,
                    mime: mime.clone(),
                    path: dest.to_string_lossy().to_string(),
                }),
            };
            if let Err(e) = append_log(&self.dir, gid, &line) {
                let _ = std::fs::remove_file(&dest);
                return Err(e);
            }
            inner.grt.ts_eff.insert(gid.to_string(), ts_eff);
            (links, offline, line)
        };

        let mut members = BTreeMap::new();
        for (node, link) in &links {
            members.insert(node.to_string(), MemberXfer { state: "sending", sent: 0, handle: link.handle });
        }
        for node in &offline {
            members.insert(node.to_string(), MemberXfer { state: "offline", sent: 0, handle: 0 });
        }
        let xfer = GroupXfer {
            gid: gid.to_string(),
            path: dest.clone(),
            name: safe.clone(),
            size,
            mime: mime.clone(),
            caption: caption.to_string(),
            ts: line.ts,
            members,
        };
        let members_json = Self::xfer_members_json(&xfer);
        {
            let mut x = self.group_xfers.lock().unwrap();
            if x.len() >= MAX_GROUP_XFERS {
                // Forget the oldest transfer that is not running.
                let oldest = x
                    .iter()
                    .filter(|(_, t)| t.members.values().all(|m| m.state != "sending"))
                    .min_by_key(|(_, t)| t.ts)
                    .map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    x.remove(&k);
                }
            }
            x.insert(id.clone(), xfer);
        }
        for (node, link) in links {
            self.spawn_group_file_stream(gid.to_string(), id.clone(), node, link);
        }
        Ok(json!({
            "id": id, "ts": line.ts, "tsEff": line.ts_eff,
            "file": { "name": safe, "size": size, "mime": mime, "path": dest.to_string_lossy() },
            "members": members_json,
        }))
    }

    /// Sends the file of a group transfer again to one member that missed it
    /// (offline at send time) or whose stream failed. From byte zero.
    pub fn group_file_retry(self: &Arc<Self>, gid: &str, id: &str, member: &str) -> Result<()> {
        let node = NodeId::from_str(member)?;
        let key = node.to_string();
        let link = {
            let inner = self.inner.lock().unwrap();
            let rec = inner.groups.get(gid).ok_or_else(|| anyhow!("unknown group"))?;
            if rec.removed {
                bail!("this group is read-only");
            }
            if !rec.state.contains(&node) {
                bail!("not a member of this group");
            }
            v2_link(&inner.peers, &node).ok_or_else(|| anyhow!("that member is offline"))?
        };
        {
            let mut x = self.group_xfers.lock().unwrap();
            if !x.contains_key(id) {
                // After a restart the transfer is only in the log.
                let row = read_log(&self.dir, gid).into_iter().find(|r| r.dir == "out" && r.id == id && r.file.is_some());
                let Some(r) = row else { bail!("unknown transfer") };
                let f = r.file.expect("filtered above");
                x.insert(
                    id.to_string(),
                    GroupXfer {
                        gid: gid.to_string(),
                        path: PathBuf::from(&f.path),
                        name: f.name,
                        size: f.size,
                        mime: f.mime,
                        caption: r.text,
                        ts: r.ts,
                        members: BTreeMap::new(),
                    },
                );
            }
            let t = x.get_mut(id).expect("inserted above");
            if t.gid != gid {
                bail!("unknown transfer");
            }
            if !t.path.is_file() {
                bail!("the original file is gone");
            }
            if t.members.get(&key).map_or(false, |m| m.state == "sending" || m.state == "done") {
                bail!("already sending or delivered");
            }
            t.members.insert(key, MemberXfer { state: "sending", sent: 0, handle: link.handle });
        }
        self.emit_group_file(gid, id, &node.to_string(), "sending", 0, None);
        self.spawn_group_file_stream(gid.to_string(), id.to_string(), node, link);
        Ok(())
    }

    fn xfer_members_json(x: &GroupXfer) -> Vec<Value> {
        x.members
            .iter()
            .map(|(id, m)| json!({ "id": id, "state": m.state, "got": m.sent }))
            .collect()
    }

    fn emit_group_file(&self, gid: &str, id: &str, member: &str, state: &str, got: u64, size: Option<u64>) {
        let mut v = json!({
            "kind": "group-file-progress", "gid": gid, "id": id, "member": member,
            "dir": "send", "state": state, "got": got,
        });
        if let Some(s) = size {
            v["size"] = json!(s);
        }
        self.sink.emit(v);
    }

    fn spawn_group_file_stream(self: &Arc<Self>, gid: String, id: String, member: NodeId, link: FileLink) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move { this.stream_group_file(gid, id, member, link).await });
    }

    /// One recipient's stream: read a chunk from disk, wait for a session
    /// credit, queue it. At most [`GROUP_FILE_CREDITS`] chunks sit in the
    /// session queue, so memory stays O(chunk) however big the file or slow
    /// the receiver is.
    async fn stream_group_file(self: Arc<Self>, gid: String, id: String, member: NodeId, link: FileLink) {
        use std::io::Read;
        let key = member.to_string();
        let (path, name, size, mime, caption, ts) = {
            let x = self.group_xfers.lock().unwrap();
            let Some(t) = x.get(&id) else { return };
            (t.path.clone(), t.name.clone(), t.size, t.mime.clone(), t.caption.clone(), t.ts)
        };
        let res: Result<()> = async {
            let closed = || anyhow!("session closed");
            let mut f = std::fs::File::open(&path).context("open the stored copy")?;
            link.tx
                .send(Frame::GroupFileBegin { gid: gid.clone(), id: id.clone(), ts, name, size, mime, caption })
                .map_err(|_| closed())?;
            let mut buf = vec![0u8; GROUP_FILE_CHUNK];
            let mut total = 0u64;
            loop {
                let mut n = 0;
                while n < buf.len() {
                    let r = f.read(&mut buf[n..])?;
                    if r == 0 {
                        break;
                    }
                    n += r;
                }
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > size {
                    bail!("the file changed while sending");
                }
                let permit = link.credits.acquire().await.map_err(|_| closed())?;
                permit.forget();
                link.tx
                    .send(Frame::GroupFileChunk { gid: gid.clone(), id: id.clone(), data: BASE64.encode(&buf[..n]) })
                    .map_err(|_| closed())?;
            }
            if total != size {
                bail!("the file changed while sending");
            }
            link.tx.send(Frame::GroupFileEnd { gid: gid.clone(), id: id.clone() }).map_err(|_| closed())?;
            Ok(())
        }
        .await;
        if res.is_err() {
            // Only if this attempt is still the member's current one: a late
            // failure of an old attempt (its session died) must not overwrite
            // a retry that already started on a fresh session.
            let current = self
                .group_xfers
                .lock()
                .unwrap()
                .get(&id)
                .and_then(|t| t.members.get(&key))
                .map_or(false, |m| m.handle == link.handle);
            if current {
                self.group_file_set(&id, &key, "failed", None);
            }
            // Tell the receiver to drop what it has (its size check fails).
            let _ = link.tx.send(Frame::GroupFileEnd { gid, id });
        }
    }

    /// Sets a member's state (only out of "sending"/"offline"/"failed" into
    /// the given one, never overwriting "done") and tells the UI.
    fn group_file_set(&self, id: &str, member: &str, state: &'static str, sent: Option<u64>) {
        let ev = {
            let mut x = self.group_xfers.lock().unwrap();
            let Some(t) = x.get_mut(id) else { return };
            let size = t.size;
            let gid = t.gid.clone();
            let Some(m) = t.members.get_mut(member) else { return };
            if m.state == "done" {
                return;
            }
            m.state = state;
            if let Some(s) = sent {
                m.sent = s.min(size);
            }
            (gid, m.sent, size)
        };
        self.emit_group_file(&ev.0, id, member, state, ev.1, Some(ev.2));
    }

    /// The session writer put `n` bytes of a chunk on the wire.
    fn group_file_wrote(&self, node: NodeId, id: &str, n: u64) {
        let key = node.to_string();
        let ev = {
            let mut x = self.group_xfers.lock().unwrap();
            let Some(t) = x.get_mut(id) else { return };
            let size = t.size;
            let gid = t.gid.clone();
            let Some(m) = t.members.get_mut(&key).filter(|m| m.state == "sending") else { return };
            m.sent = (m.sent + n).min(size);
            (gid, m.sent, size)
        };
        self.emit_group_file(&ev.0, id, &key, "sending", ev.1, Some(ev.2));
    }

    /// GroupFileEnd is on the wire: the member has the whole file.
    fn group_file_done(&self, node: NodeId, id: &str) {
        let key = node.to_string();
        let size = {
            let x = self.group_xfers.lock().unwrap();
            match x.get(id).and_then(|t| t.members.get(&key).map(|m| (m.state, t.size))) {
                Some(("sending", size)) => size,
                _ => return, // failed (the End was only the receiver's cancel) or unknown
            }
        };
        self.group_file_set(id, &key, "done", Some(size));
    }

    /// A session died: every send over it that was not finished failed.
    fn group_files_failed(&self, node: NodeId, handle: u64) {
        let key = node.to_string();
        let hit: Vec<String> = {
            let x = self.group_xfers.lock().unwrap();
            x.iter()
                .filter(|(_, t)| t.members.get(&key).map_or(false, |m| m.state == "sending" && m.handle == handle))
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in hit {
            self.group_file_set(&id, &key, "failed", None);
        }
    }

    /// Drops inbound group transfers matching `pred(sender, id)` and their
    /// partial files.
    fn drop_group_inbound(&self, pred: impl Fn(&NodeId, &str) -> bool) {
        let dropped: Vec<FileRx> = {
            let mut rx = self.rx_files.lock().unwrap();
            let keys: Vec<(NodeId, String)> = rx
                .iter()
                .filter(|((n, id), t)| t.gid.is_some() && pred(n, id))
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter().filter_map(|k| rx.remove(&k)).collect()
        };
        for t in dropped {
            let _ = std::fs::remove_file(&t.partial);
        }
    }

    /// Receive path of a group media frame. Same hygiene as 1:1 (safe ids,
    /// per-peer and global limits, sanitized names, size check on completion)
    /// with the smaller cap, and only from a live protocol-2 session of a
    /// current member of a group we are still in.
    fn on_group_file(&self, from: NodeId, frame: Frame, tx: &FrameTx) {
        let gid = match &frame {
            Frame::GroupFileBegin { gid, .. } | Frame::GroupFileChunk { gid, .. } | Frame::GroupFileEnd { gid, .. } => {
                gid.clone()
            }
            _ => return,
        };
        let allowed = {
            let inner = self.inner.lock().unwrap();
            let proto = inner
                .peers
                .get(&from)
                .and_then(|p| p.live.iter().find(|h| h.tx.same_channel(tx)))
                .map_or(0, |h| h.proto);
            proto >= 2 && inner.groups.get(&gid).map_or(false, |r| !r.removed && r.state.contains(&from))
        };
        let fid = match &frame {
            Frame::GroupFileBegin { id, .. } | Frame::GroupFileChunk { id, .. } | Frame::GroupFileEnd { id, .. } => id.clone(),
            _ => return,
        };
        if !allowed {
            self.drop_group_inbound(|n, id| *n == from && id == fid);
            return;
        }
        let key = (from, fid.clone());
        let node = from.to_string();
        let err = |msg: &str| {
            self.sink.emit(json!({ "kind": "error", "message": msg, "gid": gid, "from": node }));
        };
        match frame {
            Frame::GroupFileBegin { id, ts, name, size, mime, caption, .. } => {
                if !is_safe_transfer_id(&id) {
                    return err("rejected file: malformed transfer id");
                }
                if size > MAX_GROUP_FILE_BYTES {
                    return err(&format!("rejected file: {size} bytes over the group cap"));
                }
                {
                    let rx = self.rx_files.lock().unwrap();
                    // A restarted (retried) transfer replaces its own old try.
                    if rx.get(&key).map_or(false, |t| t.gid.is_none()) {
                        return;
                    }
                    let replacing = rx.contains_key(&key);
                    let for_peer = rx.keys().filter(|(n, _)| *n == from).count() - usize::from(replacing);
                    let total = rx.len() - usize::from(replacing);
                    if for_peer >= MAX_INBOUND_FILES_PER_PEER || total >= MAX_INBOUND_FILES_TOTAL {
                        drop(rx);
                        return err("rejected file: too many concurrent transfers");
                    }
                }
                // Already have it (a retry after the End got through).
                if read_log(&self.dir, &gid).iter().any(|r| r.from == node && r.id == id && r.file.is_some()) {
                    return;
                }
                let dir = self.blobs_dir.join(format!("g-{gid}"));
                let _ = std::fs::create_dir_all(&dir);
                let partial = dir.join(format!("partial-{node}-{id}"));
                match std::fs::File::create(&partial) {
                    Ok(_) => {
                        self.rx_files.lock().unwrap().insert(
                            (from, id),
                            FileRx { partial, dir, name: sanitize_name(&name), size, mime, caption, ts, got: 0, gid: Some(gid.clone()) },
                        );
                    }
                    Err(e) => err(&format!("cannot receive file: {e}")),
                }
            }
            Frame::GroupFileChunk { id, data, .. } => {
                let mut rx = self.rx_files.lock().unwrap();
                let Some(t) = rx.get_mut(&key).filter(|t| t.gid.as_deref() == Some(gid.as_str())) else { return };
                let bytes = match BASE64.decode(data.as_bytes()) {
                    Ok(b) => b,
                    Err(_) => {
                        let t = rx.remove(&key).expect("present");
                        let _ = std::fs::remove_file(&t.partial);
                        return;
                    }
                };
                if t.got + bytes.len() as u64 > t.size {
                    let t = rx.remove(&key).expect("present");
                    let _ = std::fs::remove_file(&t.partial);
                    return;
                }
                use std::io::Write;
                let wrote = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&t.partial)
                    .and_then(|mut f| f.write_all(&bytes))
                    .is_ok();
                if !wrote {
                    let t = rx.remove(&key).expect("present");
                    let _ = std::fs::remove_file(&t.partial);
                    return;
                }
                t.got += bytes.len() as u64;
                self.sink.emit(json!({
                    "kind": "group-file-progress", "gid": gid, "from": node, "id": id,
                    "dir": "recv", "got": t.got, "size": t.size,
                }));
            }
            Frame::GroupFileEnd { id, .. } => {
                let t = {
                    let mut rx = self.rx_files.lock().unwrap();
                    if !rx.get(&key).map_or(false, |t| t.gid.as_deref() == Some(gid.as_str())) {
                        return;
                    }
                    rx.remove(&key).expect("checked above")
                };
                let _ = std::fs::File::open(&t.partial).and_then(|f| f.sync_all());
                if t.got != t.size {
                    let _ = std::fs::remove_file(&t.partial);
                    self.sink.emit(json!({
                        "kind": "group-file-progress", "gid": gid, "from": node, "id": id,
                        "dir": "recv", "failed": true,
                    }));
                    return;
                }
                let final_path = unique_path(&t.dir, &t.name);
                if std::fs::rename(&t.partial, &final_path).is_err() {
                    let _ = std::fs::remove_file(&t.partial);
                    return;
                }
                let display = final_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| t.name.clone());
                let (ts_eff, name) = {
                    let mut guard = self.inner.lock().unwrap();
                    let inner = &mut *guard;
                    // Left or removed while the last chunk was in flight.
                    if !inner.groups.get(&gid).map_or(false, |r| !r.removed && r.state.contains(&from)) {
                        let _ = std::fs::remove_file(&final_path);
                        return;
                    }
                    let now = now_ms();
                    let prev = self.group_last_ts(inner, &gid);
                    let ts_eff = eff_ts(prev, t.ts, now);
                    let line = GroupLogRec {
                        seq: 0,
                        from: node.clone(),
                        id: id.clone(),
                        ts: t.ts,
                        ts_eff,
                        dir: "in".into(),
                        text: t.caption.clone(),
                        reply_to: None,
                        reply_text: None,
                        file: Some(GroupFileRec {
                            name: display.clone(),
                            size: t.got,
                            mime: t.mime.clone(),
                            path: final_path.to_string_lossy().to_string(),
                        }),
                    };
                    if let Err(e) = append_log(&self.dir, &gid, &line) {
                        let _ = std::fs::remove_file(&final_path);
                        self.group_warn(&from, format!("could not store a group file: {e:#}"));
                        return;
                    }
                    inner.grt.ts_eff.insert(gid.clone(), ts_eff);
                    let name = inner.peers.get(&from).map(|p| p.name.clone()).filter(|n| !n.is_empty());
                    (ts_eff, name.unwrap_or_else(|| fallback_name(&from)))
                };
                self.sink.emit(json!({
                    "kind": "group-message", "gid": gid, "from": node, "name": name,
                    "id": id, "seq": 0, "ts": t.ts, "tsEff": ts_eff, "text": t.caption,
                    "replyTo": Value::Null, "replyText": Value::Null,
                    "file": { "name": display, "size": t.got, "mime": t.mime,
                              "path": final_path.to_string_lossy() },
                }));
            }
            _ => {}
        }
    }

    /// Forgets everything file-related about a group that is being deleted:
    /// running transfers, partials and the stored copies.
    fn delete_group_blobs(&self, gid: &str) {
        self.drop_group_inbound({
            let rx = self.rx_files.lock().unwrap();
            let ids: Vec<(NodeId, String)> =
                rx.iter().filter(|(_, t)| t.gid.as_deref() == Some(gid)).map(|(k, _)| k.clone()).collect();
            move |n, id| ids.iter().any(|(a, b)| a == n && b == id)
        });
        self.group_xfers.lock().unwrap().retain(|_, t| t.gid != gid);
        let _ = std::fs::remove_dir_all(self.blobs_dir.join(format!("g-{gid}")));
    }
}

/// A `GroupMsg` after the session-level checks.
struct GroupIn {
    gid: String,
    claimed: String,
    seq: u64,
    id: String,
    ts: u64,
    text: String,
    reply_to: Option<String>,
    reply_text: Option<String>,
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
    collapse_history(
        data.lines()
            .filter_map(|line| serde_json::from_str::<StoredMsg>(line).ok())
            .collect(),
    )
}

/// Older builds appended a second "sent" copy when a queued text was flushed,
/// so a log can hold two outbound rows with one id (a stale "queued" one and
/// the real one). Keep one row per outbound id, at its first position, with
/// the state of the LAST row (states only move forward).
fn collapse_history(raw: Vec<StoredMsg>) -> Vec<StoredMsg> {
    let mut out: Vec<StoredMsg> = Vec::with_capacity(raw.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for m in raw {
        if m.dir == "out" {
            if let Some(&i) = index.get(&m.id) {
                out[i].state = m.state;
                continue;
            }
            index.insert(m.id.clone(), out.len());
        }
        out.push(m);
    }
    out
}

/// The send queue is not stored separately: it is exactly the outbound texts
/// still marked "queued" in the log (media is never queued). Rebuilding it on
/// load is what lets a text written while the peer was offline survive a
/// restart instead of staying "queued" forever.
fn queued_from(msgs: &[StoredMsg]) -> Vec<StoredMsg> {
    msgs.iter()
        .filter(|m| m.dir == "out" && m.state == "queued" && m.file.is_none())
        .cloned()
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
    /// Data directory for a restart after `p2p_set_enabled(true)`.
    dir: std::sync::Mutex<Option<PathBuf>>,
    /// Media blob root for a restart (set together with `dir`).
    blobs: std::sync::Mutex<Option<PathBuf>>,
    /// Whether the engine should run. The startup task checks this after
    /// `P2p::start` so a disable request racing the boot spawn still wins.
    enabled: std::sync::Arc<std::sync::Mutex<bool>>,
}

impl P2pState {
    pub fn empty() -> Self {
        Self {
            engine: std::sync::Arc::new(Mutex::new(None)),
            dir: std::sync::Mutex::new(None),
            blobs: std::sync::Mutex::new(None),
            enabled: std::sync::Arc::new(std::sync::Mutex::new(false)),
        }
    }

    /// A clone of the engine slot to hand to [`spawn_startup`].
    pub fn slot(&self) -> EngineSlot {
        self.engine.clone()
    }

    /// A clone of the enabled flag to hand to [`spawn_startup`].
    pub fn enabled_flag(&self) -> std::sync::Arc<std::sync::Mutex<bool>> {
        self.enabled.clone()
    }

    pub fn set_dir(&self, dir: PathBuf) {
        *self.dir.lock().unwrap() = Some(dir);
    }

    pub fn set_blobs(&self, blobs: PathBuf) {
        *self.blobs.lock().unwrap() = Some(blobs);
    }

    pub fn blobs(&self) -> Option<PathBuf> {
        self.blobs.lock().unwrap().clone()
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

/// Starts the engine on Tauri's async runtime and publishes it into `slot`,
/// unless the engine was disabled (the flag is re-checked after `P2p::start`
/// so a disable request racing the spawn still wins).
pub fn spawn_startup(
    app: tauri::AppHandle,
    slot: EngineSlot,
    enabled: std::sync::Arc<std::sync::Mutex<bool>>,
    dir: PathBuf,
    blobs_dir: PathBuf,
) {
    if !*enabled.lock().unwrap() {
        crate::log("p2p chat engine disabled — not starting");
        return;
    }
    tauri::async_runtime::spawn(async move {
        match P2p::start(dir, blobs_dir, Sink::Tauri(app.clone())).await {
            Ok(engine) => {
                if !*enabled.lock().unwrap() {
                    engine.close().await;
                    crate::log("p2p chat engine disabled — not starting");
                    return;
                }
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

/// Enables or disables the Local chat engine. Disabling stops all engine
/// tasks (the endpoint socket is released); enabling restarts it. The
/// preference itself lives in the WebView's localStorage and is applied on
/// every boot, so a disable here just needs to outlive this session.
#[tauri::command]
pub async fn p2p_set_enabled(
    state: tauri::State<'_, P2pState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    *state.enabled.lock().unwrap() = enabled;
    if enabled {
        let dir = state
            .dir
            .lock()
            .unwrap()
            .clone()
            .ok_or("p2p data dir unavailable")?;
        let Some(blobs) = state.blobs() else {
            return Err("p2p blobs dir unavailable".into());
        };
        spawn_startup(app, state.slot(), state.enabled_flag(), dir, blobs);
    } else {
        let running = state.engine.lock().unwrap().take();
        if let Some(engine) = running {
            engine.close().await;
            crate::log("p2p chat engine stopped");
        }
    }
    Ok(())
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
    reply_to: Option<String>,
    reply_text: Option<String>,
) -> Result<serde_json::Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .send(&peer_id, &text, reply_to.as_deref(), reply_text.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn p2p_send_file(
    state: tauri::State<'_, P2pState>,
    peer_id: String,
    path: String,
    name: String,
    caption: String,
) -> Result<serde_json::Value, String> {
    // Copies the file and reads it whole before framing. Off the UI thread.
    let engine = engine(&state).map_err(|e| e.to_string())?;
    let (id, stored_path) = tauri::async_runtime::spawn_blocking(move || {
        engine
            .send_file(&peer_id, &path, &name, &caption)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "id": id, "path": stored_path.to_string_lossy() }))
}

#[tauri::command]
pub fn p2p_remove_peer(state: tauri::State<'_, P2pState>, peer_id: String) -> Result<(), String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .remove_peer(&peer_id)
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

// -- Local group chats (Phase 2). Same shape as the 1:1 commands above. -----

#[tauri::command]
pub fn p2p_groups(state: tauri::State<'_, P2pState>) -> Result<Vec<Value>, String> {
    engine(&state).map_err(|e| e.to_string()).map(|e| e.groups())
}

/// Creates a group of this device plus 1..=3 paired devices.
#[tauri::command]
pub fn p2p_group_create(
    state: tauri::State<'_, P2pState>,
    name: String,
    member_ids: Vec<String>,
) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_create(&name, &member_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_group_add(
    state: tauri::State<'_, P2pState>,
    gid: String,
    node_id: String,
) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_add(&gid, &node_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_group_remove(
    state: tauri::State<'_, P2pState>,
    gid: String,
    node_id: String,
) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_remove(&gid, &node_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_group_rename(
    state: tauri::State<'_, P2pState>,
    gid: String,
    name: String,
) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_rename(&gid, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_group_disband(state: tauri::State<'_, P2pState>, gid: String) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_disband(&gid)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_group_leave(state: tauri::State<'_, P2pState>, gid: String) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_leave(&gid)
        .map_err(|e| e.to_string())
}

/// Typing hint for a 1:1 chat (`peer_id`) or a group (`gid`). Best effort:
/// returns how many peers it reached (0 for offline / protocol-1 peers).
#[tauri::command]
pub fn p2p_typing(
    state: tauri::State<'_, P2pState>,
    peer_id: Option<String>,
    gid: Option<String>,
    on: bool,
) -> Result<usize, String> {
    let e = engine(&state).map_err(|e| e.to_string())?;
    match (peer_id, gid) {
        (Some(p), None) => e.typing_peer(&p, on).map(|r| r as usize).map_err(|e| e.to_string()),
        (None, Some(g)) => e.typing_group(&g, on).map_err(|e| e.to_string()),
        _ => Err("give either peerId or gid".to_string()),
    }
}

/// Deletes the local data of a group that is over (left / removed / disbanded).
#[tauri::command]
pub fn p2p_group_delete(state: tauri::State<'_, P2pState>, gid: String) -> Result<(), String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_delete(&gid)
        .map_err(|e| e.to_string())
}

/// `{created: [...], member: [...]}`: what unpairing this device does to groups.
#[tauri::command]
pub fn p2p_peer_groups(state: tauri::State<'_, P2pState>, peer_id: String) -> Result<Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .peer_group_impact(&peer_id)
        .map_err(|e| e.to_string())
}

/// Returns `{id, seq, ts, tsEff, queued}`.
#[tauri::command]
pub fn p2p_group_send(
    state: tauri::State<'_, P2pState>,
    gid: String,
    text: String,
    reply_to: Option<String>,
    reply_text: Option<String>,
) -> Result<serde_json::Value, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_send(&gid, &text, reply_to.as_deref(), reply_text.as_deref())
        .map_err(|e| e.to_string())
}

/// Sends a media file to the group's online members (32 MiB cap). Returns
/// `{id, ts, tsEff, file, members: [{id, state}]}`; progress follows as
/// `group-file-progress` events.
#[tauri::command]
pub async fn p2p_group_send_file(
    state: tauri::State<'_, P2pState>,
    gid: String,
    path: String,
    name: String,
    caption: Option<String>,
) -> Result<serde_json::Value, String> {
    // Copies the file: off the UI thread.
    let engine = engine(&state).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .group_send_file(&gid, &path, &name, caption.as_deref().unwrap_or(""))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sends a group file again to one member that missed it or whose stream failed.
#[tauri::command]
pub fn p2p_group_file_retry(
    state: tauri::State<'_, P2pState>,
    gid: String,
    id: String,
    member: String,
) -> Result<(), String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_file_retry(&gid, &id, &member)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn p2p_group_messages(
    state: tauri::State<'_, P2pState>,
    gid: String,
    limit: Option<usize>,
) -> Result<Vec<Value>, String> {
    engine(&state)
        .map_err(|e| e.to_string())?
        .group_messages(&gid, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;

    /// Where `temp_dir(tag)` put (or will put) its directory, without wiping it.
    fn temp_dir_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("velta-p2p-test-{tag}-{}", std::process::id()))
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("velta-p2p-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn start(tag: &str) -> (Arc<P2p>, std_mpsc::Receiver<Value>) {
        let (tx, rx) = std_mpsc::channel();
        let p2p = P2p::start(temp_dir(tag), temp_dir(&format!("{tag}-blobs")), Sink::Test(tx))
            .await
            .unwrap();
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
        let id1 = bob.send(&alice_id, "hi alice", None, None).unwrap();
        let got = wait_for(&alice_rx, 15, |e| e["kind"] == "message");
        assert_eq!(got["text"], "hi alice");
        wait_for(&bob_rx, 15, |e| e["kind"] == "ack" && e["id"] == id1["id"]);

        // Alice -> Bob, with ack.
        let id2 = alice.send(&bob_id, "hi bob", None, None).unwrap();
        let got2 = wait_for(&bob_rx, 15, |e| {
            e["kind"] == "message" && e["text"] == "hi bob"
        });
        assert_eq!(got2["text"], "hi bob");
        wait_for(&alice_rx, 15, |e| e["kind"] == "ack" && e["id"] == id2["id"]);

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
        assert!(mallory.send(&bob_id, "let me in", None, None).is_err());

        // Status snapshots are sane.
        let status = alice.status();
        assert_eq!(status["name"], "alice");
        assert_eq!(status["peers"].as_array().unwrap().len(), 1);
        assert_eq!(status["peers"][0]["id"], bob_id.as_str());
    }

    fn fake_node_id() -> NodeId {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        SecretKey::from_bytes(&bytes).public()
    }

    /// The transfer id is chosen by the sender, so two peers may use the same
    /// one. Inbound transfers are keyed by (node, id): neither may overwrite,
    /// feed or finish the other's, and the per-peer limit counts per node.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inbound_transfers_are_keyed_by_node_and_id() {
        let (engine, _rx) = start("rxkey").await;
        let (tx, _frames) = mpsc::unbounded_channel();
        let (a, b) = (fake_node_id(), fake_node_id());
        let begin = |size: u64| Frame::FileBegin {
            id: "same".into(), ts: 1, name: "f.txt".into(), size,
            mime: "text/plain".into(), caption: String::new(),
        };
        let chunk = |bytes: &[u8]| Frame::FileChunk { id: "same".into(), data: BASE64.encode(bytes) };
        let end = || Frame::FileEnd { id: "same".into() };

        engine.handle_frame(a, begin(5), &tx);
        engine.handle_frame(b, begin(3), &tx);
        assert_eq!(engine.rx_files.lock().unwrap().len(), 2, "same id from two nodes = two transfers");

        engine.handle_frame(a, chunk(b"AAAAA"), &tx);
        engine.handle_frame(b, chunk(b"BBB"), &tx);
        // Finishing A's transfer must leave B's untouched.
        engine.handle_frame(a, end(), &tx);
        assert_eq!(engine.rx_files.lock().unwrap().len(), 1);
        assert!(engine.rx_files.lock().unwrap().contains_key(&(b, "same".to_string())));
        engine.handle_frame(b, end(), &tx);
        assert!(engine.rx_files.lock().unwrap().is_empty());

        let read = |n: NodeId| std::fs::read(engine.blobs_dir.join(n.to_string()).join("f.txt")).unwrap();
        assert_eq!(read(a), b"AAAAA");
        assert_eq!(read(b), b"BBB");

        // A node cannot finish a transfer that only another node started.
        engine.handle_frame(a, begin(1), &tx);
        engine.handle_frame(b, end(), &tx);
        assert!(engine.rx_files.lock().unwrap().contains_key(&(a, "same".to_string())));

        // Per-peer cap counts per node, not engine-wide (the total cap still applies).
        let c = fake_node_id();
        for i in 0..(MAX_INBOUND_FILES_PER_PEER + 2) {
            engine.handle_frame(c, Frame::FileBegin {
                id: format!("t{i}"), ts: 1, name: "g.bin".into(), size: 1,
                mime: String::new(), caption: String::new(),
            }, &tx);
        }
        let for_c = engine.rx_files.lock().unwrap().keys().filter(|(n, _)| *n == c).count();
        assert_eq!(for_c, MAX_INBOUND_FILES_PER_PEER);
    }

    /// serde must route an unrecognised `type` to `Unknown` (internally tagged
    /// enum + `#[serde(other)]`), keep known frames intact and still reject
    /// malformed known frames and frames without a type.
    #[test]
    fn unknown_frame_and_hello_types_parse_as_unknown() {
        let f: Frame = serde_json::from_str(r#"{"type":"grpmsg","gid":"g","seq":7,"extra":[1,{"a":2}]}"#).unwrap();
        assert!(matches!(f, Frame::Unknown));
        let f: Frame = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert!(matches!(f, Frame::Ping));
        let f: Frame = serde_json::from_str(r#"{"type":"ping","future_field":true}"#).unwrap();
        assert!(matches!(f, Frame::Ping));
        let f: Frame = serde_json::from_str(r#"{"type":"ack","id":"x"}"#).unwrap();
        assert!(matches!(f, Frame::Ack { id } if id == "x"));
        // Old peers' msg frames (no reply fields) still parse.
        let f: Frame = serde_json::from_str(r#"{"type":"msg","id":"1","ts":2,"text":"t"}"#).unwrap();
        assert!(matches!(f, Frame::Msg { reply_to: None, .. }));
        // A known type with a broken body is still an error (unchanged).
        assert!(serde_json::from_str::<Frame>(r#"{"type":"msg","id":"1"}"#).is_err());
        assert!(serde_json::from_str::<Frame>(r#"{"no_type":1}"#).is_err());

        let h: Hello = serde_json::from_str(r#"{"type":"groupinvite","x":1}"#).unwrap();
        assert!(matches!(h, Hello::Unknown));
        let h: Hello = serde_json::from_str(r#"{"type":"welcome","name":"n"}"#).unwrap();
        assert!(matches!(h, Hello::Welcome { name } if name == "n"));
        let h: Hello = serde_json::from_str(r#"{"type":"hello","token":"t","name":"n","addrs":[]}"#).unwrap();
        assert!(matches!(h, Hello::Hello { .. }));
        // A Frame sent where a Hello is expected is Unknown, never a Hello.
        let h: Hello = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert!(matches!(h, Hello::Unknown));
    }

    /// An unrecognised frame in the middle of a live session is skipped: the
    /// session (same handle) survives and later messages flow on it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unknown_frame_does_not_kill_a_session() {
        let (alice, alice_rx) = start("alice-unk").await;
        let (bob, bob_rx) = start("bob-unk").await;
        let alice_id = alice.node_id();
        let bob_id = bob.node_id();
        let ticket = alice.create_invite().await.unwrap();
        bob.accept_invite(&ticket).await.unwrap();
        wait_for(&alice_rx, 15, |e| e["kind"] == "pairing");

        let handle = |p: &Arc<P2p>, other: &NodeId| {
            let inner = p.inner.lock().unwrap();
            inner.peers[other].live.first().map(|h| (h.id, h.tx.clone()))
        };
        let (alice_handle, _) = handle(&alice, &bob_id).expect("alice has a live session");
        let (_, bob_tx) = handle(&bob, &alice_id).expect("bob has a live session");

        // `Unknown` is serialised as {"type":"unknown"}: a type alice's parser
        // has no variant for, so it takes the same path as a future frame.
        bob_tx.send(Frame::Unknown).unwrap();
        let id = bob.send(&alice_id.to_string(), "after the unknown frame", None, None).unwrap();
        let got = wait_for(&alice_rx, 8, |e| e["kind"] == "message");
        assert_eq!(got["text"], "after the unknown frame");
        wait_for(&bob_rx, 8, |e| e["kind"] == "ack" && e["id"] == id["id"]);

        // Still the very same session on alice's side (no drop + redial).
        let (alice_handle_after, _) = handle(&alice, &bob_id).expect("session still live");
        assert_eq!(alice_handle, alice_handle_after);
        assert!(alice.status()["peers"][0]["online"].as_bool().unwrap());
    }

    /// Starts an engine that only speaks ALPN v1: stands in for a released
    /// 1.4.x build (it neither accepts nor offers v2).
    async fn start_v1_only(tag: &str) -> (Arc<P2p>, std_mpsc::Receiver<Value>) {
        let (tx, rx) = std_mpsc::channel();
        let p2p = P2p::start_with_alpns(
            temp_dir(tag),
            temp_dir(&format!("{tag}-blobs")),
            Sink::Test(tx),
            vec![ALPN_V1.to_vec()],
        )
        .await
        .unwrap();
        p2p.set_name(tag.to_string()).unwrap();
        (p2p, rx)
    }

    /// `proto` reported for the peer `other` by `engine.status()`, and the
    /// value persisted in its peers.json.
    fn proto_seen(engine: &Arc<P2p>, other: &NodeId) -> (u64, u8) {
        let status = engine.status();
        let live = status["peers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == other.to_string().as_str())
            .expect("peer in status")["proto"]
            .as_u64()
            .unwrap();
        let stored = load_peers(&engine.dir)
            .into_iter()
            .find(|p| p.node_id == other.to_string())
            .expect("peer persisted")
            .proto;
        (live, stored)
    }

    /// Chat both ways + a file, to prove the session is fully functional.
    async fn chat_roundtrip(
        a: &Arc<P2p>, a_rx: &std_mpsc::Receiver<Value>,
        b: &Arc<P2p>, b_rx: &std_mpsc::Receiver<Value>,
    ) {
        let (a_id, b_id) = (a.node_id().to_string(), b.node_id().to_string());
        let m1 = a.send(&b_id, "ping from a", None, None).unwrap();
        wait_for(b_rx, 20, |e| e["kind"] == "message" && e["text"] == "ping from a");
        wait_for(a_rx, 20, |e| e["kind"] == "ack" && e["id"] == m1["id"]);
        let m2 = b.send(&a_id, "pong from b", None, None).unwrap();
        wait_for(a_rx, 20, |e| e["kind"] == "message" && e["text"] == "pong from b");
        wait_for(b_rx, 20, |e| e["kind"] == "ack" && e["id"] == m2["id"]);
    }

    /// Two current builds negotiate ALPN v2, remember it per session and per
    /// persisted peer, and 1:1 chat works exactly as before.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn existing_pair_and_chat_still_passes_on_alpn_v2() {
        let (alice, alice_rx) = start("alice-v2").await;
        let (bob, bob_rx) = start("bob-v2").await;
        let (alice_id, bob_id) = (alice.node_id(), bob.node_id());

        let ticket = alice.create_invite().await.unwrap();
        bob.accept_invite(&ticket).await.unwrap();
        wait_for(&alice_rx, 15, |e| e["kind"] == "pairing");
        chat_roundtrip(&alice, &alice_rx, &bob, &bob_rx).await;

        assert_eq!(proto_seen(&bob, &alice_id), (2, 2), "dialer side");
        assert_eq!(proto_seen(&alice, &bob_id), (2, 2), "accepting side");
        let live_protos = |p: &Arc<P2p>, o: &NodeId| -> Vec<u8> {
            p.inner.lock().unwrap().peers[o].live.iter().map(|h| h.proto).collect()
        };
        assert!(live_protos(&alice, &bob_id).iter().all(|p| *p == 2));
        assert!(live_protos(&bob, &alice_id).iter().all(|p| *p == 2));
    }

    /// A released 1.4.x build only knows ALPN v1. Pairing and chat must keep
    /// working in BOTH dial directions, and both sides must record proto 1
    /// (so later group code never sends it a v2-only frame).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn v1_only_peer_negotiates_alpn_v1_and_chat_still_works() {
        // New build dials an old build (old shows the invite, new accepts).
        let (old, old_rx) = start_v1_only("old-v1").await;
        let (new, new_rx) = start("new-dials").await;
        let ticket = old.create_invite().await.unwrap();
        new.accept_invite(&ticket).await.unwrap();
        wait_for(&old_rx, 15, |e| e["kind"] == "pairing");
        chat_roundtrip(&new, &new_rx, &old, &old_rx).await;
        assert_eq!(proto_seen(&new, &old.node_id()), (1, 1));
        assert_eq!(proto_seen(&old, &new.node_id()).0, 1);

        // Old build dials a new build (new shows the invite, old accepts).
        let (new2, new2_rx) = start("new-accepts").await;
        let (old2, old2_rx) = start_v1_only("old-dials").await;
        let ticket = new2.create_invite().await.unwrap();
        old2.accept_invite(&ticket).await.unwrap();
        wait_for(&new2_rx, 15, |e| e["kind"] == "pairing");
        chat_roundtrip(&old2, &old2_rx, &new2, &new2_rx).await;
        assert_eq!(proto_seen(&new2, &old2.node_id()), (1, 1));
        assert_eq!(proto_seen(&old2, &new2.node_id()).0, 1);
    }

    /// peers.json written by an older build has no `proto`; a newer file must
    /// stay readable by a build that does not know the field.
    #[test]
    fn persisted_peer_proto_is_optional_and_ignored_by_old_readers() {
        let old_row = r#"{"peers":[{"node_id":"aa","name":"n","addrs":["1.2.3.4:5"]}]}"#;
        let parsed: PeersFile = serde_json::from_str(old_row).unwrap();
        assert_eq!(parsed.peers[0].proto, 0);

        let new_row = serde_json::to_string(&PeersFile {
            peers: vec![PersistedPeer { node_id: "aa".into(), name: "n".into(), addrs: vec![], proto: 2 }],
        })
        .unwrap();
        assert!(new_row.contains(r#""proto":2"#));
        #[derive(Deserialize)]
        struct OldPeer { node_id: String, name: String, addrs: Vec<String> }
        #[derive(Deserialize)]
        struct OldFile { peers: Vec<OldPeer> }
        let old_reader: OldFile = serde_json::from_str(&new_row).unwrap();
        assert_eq!(old_reader.peers[0].node_id, "aa");
        assert_eq!(old_reader.peers[0].name, "n");
        assert!(old_reader.peers[0].addrs.is_empty());
    }

    fn stored_out(id: &str, text: &str, state: &str) -> StoredMsg {
        StoredMsg {
            id: id.into(), ts: 1, dir: "out".into(), state: state.into(), text: text.into(),
            reply_to: None, reply_text: None, file: None,
        }
    }

    /// Logs written by older builds hold a stale "queued" twin next to the
    /// flushed row; loading keeps one row per id with the latest state and
    /// rebuilds the send queue only from texts that are really still queued.
    #[test]
    fn load_collapses_duplicate_rows_and_rebuilds_the_queue() {
        let raw = vec![
            stored_out("a", "first", "queued"),
            stored_out("b", "second", "queued"),
            stored_out("a", "first", "sent"), // old flush appended a copy
            StoredMsg { dir: "in".into(), state: "acked".into(), ..stored_out("c", "theirs", "") },
        ];
        let msgs = collapse_history(raw);
        assert_eq!(msgs.iter().map(|m| (m.id.as_str(), m.state.as_str())).collect::<Vec<_>>(),
            vec![("a", "sent"), ("b", "queued"), ("c", "acked")]);
        let q = queued_from(&msgs);
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].id, "b");
    }

    /// A text queued while the peer was away survives a restart of the sender
    /// (it used to stay "queued" forever): the queue is rebuilt from the log,
    /// the peer is dialled, and the text arrives exactly once. The log keeps
    /// one row for it, acked, and the next restart has nothing left to send.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn queued_text_survives_restart_and_is_delivered_once() {
        let (alice, alice_rx) = start("alice-q").await;
        let (bob, _bob_rx) = start("bob-q").await;
        let alice_id = alice.node_id();
        let ticket = alice.create_invite().await.unwrap();
        bob.accept_invite(&ticket).await.unwrap();
        wait_for(&alice_rx, 15, |e| e["kind"] == "pairing");
        let dir_b = temp_dir_path("bob-q");
        let blobs_b = temp_dir_path("bob-q-blobs");
        bob.close().await;
        drop(bob);

        // Bob's log as an interrupted run leaves it: one text still queued.
        let path = dir_b.join(format!("messages-{}.jsonl", HEXLOWER.encode(alice_id.as_ref())));
        let line = serde_json::to_string(&stored_out("q1", "written while you were away", "queued")).unwrap();
        std::fs::write(&path, format!("{line}\n")).unwrap();

        let restart = |dir: PathBuf, blobs: PathBuf| async move {
            let (tx, rx) = std_mpsc::channel();
            (P2p::start(dir, blobs, Sink::Test(tx)).await.unwrap(), rx)
        };
        let (bob2, bob2_rx) = restart(dir_b.clone(), blobs_b.clone()).await;
        assert_eq!(bob2.inner.lock().unwrap().peers[&alice_id].queued.len(), 1, "queue rebuilt from the log");

        let got = wait_for(&alice_rx, 60, |e| e["kind"] == "message");
        assert_eq!(got["text"], "written while you were away");
        assert_eq!(got["id"], "q1");
        wait_for(&bob2_rx, 60, |e| e["kind"] == "ack" && e["id"] == "q1");

        let view = bob2.messages(&alice_id.to_string(), 10).unwrap();
        assert_eq!(view.len(), 1, "flush updates the stored row, no duplicate");
        assert_eq!(view[0]["state"], "acked");
        assert_eq!(alice.messages(&bob2.node_id().to_string(), 10).unwrap().len(), 1, "delivered once");
        assert!(bob2.inner.lock().unwrap().peers[&alice_id].queued.is_empty());

        // Next restart: nothing is re-sent.
        bob2.close().await;
        drop(bob2);
        let (bob3, _rx3) = restart(dir_b, blobs_b).await;
        assert!(bob3.inner.lock().unwrap().peers[&alice_id].queued.is_empty());
        assert_eq!(bob3.messages(&alice_id.to_string(), 10).unwrap()[0]["state"], "acked");
    }

    // -- local groups (Phase 1: state model, gates; no wire messaging) -------

    /// A paired device that needs no network: inserted straight into the map.
    fn add_fake_peer(engine: &Arc<P2p>, kind: PeerKind, proto: u8) -> NodeId {
        let id = fake_node_id();
        let mut inner = engine.inner.lock().unwrap();
        let n = inner.peers.len() + 1;
        inner.peers.insert(id, Peer {
            kind,
            name: format!("Fake {n}"),
            addrs: vec![format!("10.0.0.{n}:4000").parse().unwrap()],
            proto,
            live: Vec::new(),
            connecting: false,
            queued: Vec::new(),
            msgs: Vec::new(),
        });
        id
    }

    fn ids(v: &[NodeId]) -> Vec<String> {
        v.iter().map(|i| i.to_string()).collect()
    }

    fn peers_json_ids(engine: &Arc<P2p>) -> Vec<String> {
        load_peers(&engine.dir).into_iter().map(|p| p.node_id).collect()
    }

    fn kind_of(engine: &Arc<P2p>, id: &NodeId) -> Option<PeerKind> {
        engine.inner.lock().unwrap().peers.get(id).map(|p| p.kind)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn group_create_enforces_member_cap_capability_and_ownership() {
        let (a, _rx) = start("grp-create").await;
        let (b, c, d) = (
            add_fake_peer(&a, PeerKind::Paired, 2),
            add_fake_peer(&a, PeerKind::Paired, 2),
            add_fake_peer(&a, PeerKind::Paired, 2),
        );
        let old = add_fake_peer(&a, PeerKind::Paired, 1);
        let unknown_proto = add_fake_peer(&a, PeerKind::Paired, 0);
        let stranger = fake_node_id();
        let e = add_fake_peer(&a, PeerKind::Paired, 2);
        let f = add_fake_peer(&a, PeerKind::Paired, 2);
        let set_cap = |n: &NodeId, max: u8| { a.inner.lock().unwrap().grt.caps.insert(*n, max); };

        // Sixth member: the creator API refuses (creator + 5 invitees).
        let six = ids(&[b, c, d, e, f]);
        assert!(a.group_create("Too big", &six).unwrap_err().to_string().contains("at most 5"));
        // Needs a name, at least one member, unique paired v2 members.
        assert!(a.group_create("", &ids(&[b])).is_err());
        assert!(a.group_create(&"n".repeat(65), &ids(&[b])).is_err());
        assert!(a.group_create("Solo", &[]).is_err());
        assert!(a.group_create("Dupes", &ids(&[b, b])).is_err());
        assert!(a.group_create("Self", &ids(&[a.node_id()])).is_err());
        assert!(a.group_create("Stranger", &ids(&[stranger])).is_err());
        let err = a.group_create("Old", &ids(&[b, old])).unwrap_err().to_string();
        assert!(err.contains("can't join local groups"), "{err}");
        assert!(a.group_create("Unknown proto", &ids(&[unknown_proto])).is_err());
        assert!(a.groups().is_empty(), "failed creates leave nothing behind");

        // A valid group: creator first, epoch 1, signed, stored.
        let g = a.group_create("  Weekend  ", &ids(&[b, c])).unwrap();
        assert_eq!(g["name"], "Weekend");
        assert_eq!(g["epoch"], 1);
        assert_eq!(g["canManage"], true);
        assert_eq!(g["members"].as_array().unwrap().len(), 3);
        assert_eq!(g["members"][0]["self"], true);
        let gid = g["gid"].as_str().unwrap().to_string();
        assert!(is_safe_transfer_id(&gid));
        a.group_state(&gid).unwrap().check().unwrap();

        // Add the 4th; the 5th needs every member to have announced support for
        // groups of 5 (1.4.56/57 would drop that roster silently); a 6th never.
        let g = a.group_add(&gid, &d.to_string()).unwrap();
        assert_eq!(g["epoch"], 2);
        let err = a.group_add(&gid, &e.to_string()).unwrap_err().to_string();
        assert!(err.contains("more than 4"), "unannounced members count as old builds: {err}");
        assert_eq!(a.group_state(&gid).unwrap().members.len(), 4);
        for n in [&b, &c, &d] { set_cap(n, 4); }
        set_cap(&e, 5);
        assert!(a.group_add(&gid, &e.to_string()).is_err(), "members announcing 4 are old builds");
        for n in [&b, &c, &d, &e] { set_cap(n, MAX_GROUP_MEMBERS as u8); }
        let g = a.group_add(&gid, &e.to_string()).unwrap();
        assert_eq!((g["epoch"].as_u64(), g["members"].as_array().unwrap().len()), (Some(3), 5));
        a.group_state(&gid).unwrap().check().unwrap();
        assert!(a.group_add(&gid, &f.to_string()).is_err(), "a sixth member is refused");
        assert!(a.group_add(&gid, &d.to_string()).is_err(), "already a member");
        let g = a.group_remove(&gid, &c.to_string()).unwrap();
        assert_eq!(g["epoch"], 4);
        assert!(a.group_remove(&gid, &c.to_string()).is_err(), "no longer a member");
        assert!(a.group_remove(&gid, &a.node_id().to_string()).is_err(), "creator can't be removed");
        assert!(a.group_add(&gid, &old.to_string()).is_err(), "v1 device can't be added later either");
        let g = a.group_add(&gid, &c.to_string()).unwrap();
        assert_eq!(g["epoch"], 5);
        let g = a.group_rename(&gid, "Renamed").unwrap();
        assert_eq!((g["name"].as_str().unwrap(), g["epoch"].as_u64().unwrap()), ("Renamed", 6));
        assert!(a.group_rename(&gid, "").is_err());
        a.group_state(&gid).unwrap().check().unwrap();
        assert_eq!(a.group_state(&gid).unwrap().members.len(), 5);

        // The creator can't "leave", only disband; afterwards the group is read-only.
        assert!(a.group_leave(&gid).is_err());
        let g = a.group_disband(&gid).unwrap();
        assert_eq!((g["closed"].as_bool(), g["removed"].as_bool(), g["canManage"].as_bool()),
            (Some(true), Some(true), Some(false)));
        assert_eq!(a.group_state(&gid).unwrap().members.len(), 1);
        assert!(a.group_rename(&gid, "again").is_err());
        assert!(a.group_add(&gid, &b.to_string()).is_err());
        assert!(a.group_state("0123456789abcdef0123456789abcdef").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn group_count_is_capped() {
        let (a, _rx) = start("grp-cap").await;
        let b = add_fake_peer(&a, PeerKind::Paired, 2);
        for i in 0..MAX_GROUPS {
            a.group_create(&format!("g{i}"), &ids(&[b])).unwrap();
        }
        assert_eq!(a.groups().len(), MAX_GROUPS);
        assert!(a.group_create("one too many", &ids(&[b])).is_err());
    }

    /// Introduced members exist so sessions/dials work, but they are not
    /// contacts: not in status().peers, not in peers.json (a 1.4.x downgrade
    /// would read them as paired), not messageable, and they disappear when
    /// no group lists them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn introduced_peer_never_written_to_peers_json() {
        let (a, a_rx) = start("grp-intro").await;
        let b = add_fake_peer(&a, PeerKind::Paired, 2);
        // Persist the paired one the normal way.
        a.persist_peers(&a.inner.lock().unwrap()).unwrap();

        // Learn about C through a roster signed by a creator we trust.
        let (creator, _crx) = start("grp-intro-creator").await;
        let c = fake_node_id();
        creator.inner.lock().unwrap().peers.insert(a.node_id(), Peer {
            kind: PeerKind::Paired, name: "A".into(), addrs: vec![], proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        });
        for id in [c] {
            creator.inner.lock().unwrap().peers.insert(id, Peer {
                kind: PeerKind::Paired, name: "C".into(), addrs: vec!["10.9.9.9:1".parse().unwrap()], proto: 2,
                live: vec![], connecting: false, queued: vec![], msgs: vec![],
            });
        }
        a.inner.lock().unwrap().peers.insert(creator.node_id(), Peer {
            kind: PeerKind::Paired, name: "Creator".into(), addrs: vec![], proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        });
        let g = creator.group_create("Trio", &ids(&[a.node_id(), c])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        let applied = a.apply_group_state(creator.group_state(&gid).unwrap(), creator.node_id()).unwrap();
        assert_eq!(applied["result"], "created");

        assert_eq!(kind_of(&a, &c), Some(PeerKind::Introduced));
        assert_eq!(a.inner.lock().unwrap().peers[&c].name, "C");
        a.persist_peers(&a.inner.lock().unwrap()).unwrap();
        assert!(!peers_json_ids(&a).contains(&c.to_string()), "introduced member leaked into peers.json");
        let raw = std::fs::read_to_string(a.dir.join("peers.json")).unwrap();
        assert!(!raw.contains(&c.to_string()));
        assert!(peers_json_ids(&a).contains(&b.to_string()));

        // Gates: not listed, not messageable, not removable as a contact.
        let listed: Vec<String> = a.status()["peers"].as_array().unwrap().iter()
            .map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert!(!listed.contains(&c.to_string()));
        assert!(listed.contains(&b.to_string()));
        assert!(a.send(&c.to_string(), "hi", None, None).is_err());
        assert!(a.send_file(&c.to_string(), "/nonexistent", "f", "").is_err());
        assert!(a.messages(&c.to_string(), 10).is_err());
        assert!(a.remove_peer(&c.to_string()).is_err());
        // The group shows it, flagged.
        let group = &a.groups()[0];
        let cm = group["members"].as_array().unwrap().iter().find(|m| m["id"] == c.to_string().as_str()).unwrap();
        assert_eq!(cm["introduced"], true);

        // A 1:1 message / file frame from it is dropped: no record, no event.
        let (tx, _frames) = mpsc::unbounded_channel();
        while a_rx.try_recv().is_ok() {}
        a.handle_frame(c, Frame::Msg { id: "x1".into(), ts: 1, text: "sneaky".into(), reply_to: None, reply_text: None }, &tx);
        a.handle_frame(c, Frame::FileBegin { id: "f1".into(), ts: 1, name: "a".into(), size: 1, mime: String::new(), caption: String::new() }, &tx);
        a.handle_frame(c, Frame::Ack { id: "x1".into() }, &tx);
        assert!(a.inner.lock().unwrap().peers[&c].msgs.is_empty());
        assert!(a.rx_files.lock().unwrap().is_empty());
        assert!(a_rx.try_recv().is_err(), "nothing reaches the UI");
        // …while a paired contact's identical frame is processed as before.
        a.handle_frame(b, Frame::Msg { id: "x2".into(), ts: 1, text: "legit".into(), reply_to: None, reply_text: None }, &tx);
        assert_eq!(a.inner.lock().unwrap().peers[&b].msgs.len(), 1);
        assert_eq!(a_rx.try_recv().unwrap()["kind"], "message");

        // Presence of an introduced member is never published (the adapter
        // would create a p2p: chat for it); a paired one is.
        a.emit_presence(c, true);
        let kinds: Vec<String> = std::iter::from_fn(|| a_rx.try_recv().ok()).map(|e| e["kind"].as_str().unwrap_or("").to_string()).collect();
        assert!(!kinds.contains(&"presence".to_string()), "introduced member produced a presence event: {kinds:?}");
        a.emit_presence(b, true);
        assert_eq!(a_rx.try_recv().unwrap()["kind"], "presence");

        // Restart: groups.json brings the introduced entry back, peers.json
        // still never lists it.
        let dir = a.dir.clone();
        let blobs = a.blobs_dir.clone();
        a.close().await;
        drop(a);
        let (tx2, _rx2) = std_mpsc::channel();
        let a2 = P2p::start(dir, blobs, Sink::Test(tx2)).await.unwrap();
        assert_eq!(kind_of(&a2, &c), Some(PeerKind::Introduced));
        assert_eq!(kind_of(&a2, &b), Some(PeerKind::Paired));
        assert!(!peers_json_ids(&a2).contains(&c.to_string()));
        assert_eq!(a2.groups().len(), 1);

        // Nobody lists C anymore (creator removes C → relayed state): entry is
        // garbage-collected; the paired contacts stay.
        creator.group_remove(&gid, &c.to_string()).unwrap();
        a2.apply_group_state(creator.group_state(&gid).unwrap(), creator.node_id()).unwrap();
        assert_eq!(kind_of(&a2, &c), None);
        assert_eq!(kind_of(&a2, &creator.node_id()), Some(PeerKind::Paired));
        assert_eq!(kind_of(&a2, &b), Some(PeerKind::Paired));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn introduced_member_pairing_directly_becomes_paired_and_unpairing_downgrades() {
        let (a, _rx) = start("grp-flip").await;
        let (creator, _crx) = start("grp-flip-creator").await;
        let c = fake_node_id();
        for (e, id, n) in [(&creator, a.node_id(), "A"), (&creator, c, "C")] {
            e.inner.lock().unwrap().peers.insert(id, Peer {
                kind: PeerKind::Paired, name: n.into(), addrs: vec![], proto: 2,
                live: vec![], connecting: false, queued: vec![], msgs: vec![],
            });
        }
        a.inner.lock().unwrap().peers.insert(creator.node_id(), Peer {
            kind: PeerKind::Paired, name: "Creator".into(), addrs: vec![], proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        });
        let gid = creator.group_create("Trio", &ids(&[a.node_id(), c])).unwrap()["gid"].as_str().unwrap().to_string();
        a.apply_group_state(creator.group_state(&gid).unwrap(), creator.node_id()).unwrap();
        assert_eq!(kind_of(&a, &c), Some(PeerKind::Introduced));

        // Paired directly with C afterwards: a real contact now, persisted.
        a.add_peer(c, "C direct".into(), vec![]).await.unwrap();
        assert_eq!(kind_of(&a, &c), Some(PeerKind::Paired));
        assert!(peers_json_ids(&a).contains(&c.to_string()));
        assert_eq!(a.inner.lock().unwrap().peers[&c].name, "C direct");
        // …and the group still shows the local pairing name.
        let m = a.groups()[0]["members"].as_array().unwrap().iter().find(|m| m["id"] == c.to_string().as_str()).unwrap().clone();
        assert_eq!((m["name"].as_str().unwrap(), m["introduced"].as_bool().unwrap()), ("C direct", false));

        // Unpairing a contact who is still in a group keeps them reachable as
        // an introduced member instead of dropping the entry.
        a.remove_peer(&c.to_string()).unwrap();
        assert_eq!(kind_of(&a, &c), Some(PeerKind::Introduced));
        assert!(!peers_json_ids(&a).contains(&c.to_string()));
        // A contact in no group is simply gone.
        let lone = add_fake_peer(&a, PeerKind::Paired, 2);
        a.remove_peer(&lone.to_string()).unwrap();
        assert_eq!(kind_of(&a, &lone), None);
    }

    /// First contact, relays, replays, rollbacks and the caps on the receiving
    /// side, with a real signing creator and a real receiving engine.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_state_acceptance_rules() {
        let (alice, _alice_rx) = start("grp-acc-alice").await;
        let (bob, _bob_rx) = start("grp-acc-bob").await;
        let (a_id, b_id) = (alice.node_id(), bob.node_id());
        // Paired (v2) on paper only, with no session: this test feeds states by
        // hand, so nothing may travel over the wire behind its back.
        let paper = |name: &str| Peer {
            kind: PeerKind::Paired, name: name.into(), addrs: vec![], proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        };
        alice.inner.lock().unwrap().peers.insert(b_id, paper("Bob"));
        bob.inner.lock().unwrap().peers.insert(a_id, paper("Alice"));
        let c = add_fake_peer(&alice, PeerKind::Paired, 2);

        // Bob is invitable (v2). Alice creates {A,B,C}.
        let g = alice.group_create("Trio", &ids(&[b_id, c])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        let st1 = alice.group_state(&gid).unwrap();
        let wire = |st: &GroupState| -> GroupState { serde_json::from_str(&serde_json::to_string(st).unwrap()).unwrap() };

        // Bob rejects first contact from anyone but the (paired) creator.
        let stranger = fake_node_id();
        assert!(bob.apply_group_state(wire(&st1), stranger).is_err());
        assert!(bob.apply_group_state(wire(&st1), c).is_err(), "a member is not the creator");
        assert!(bob.groups().is_empty());
        // A creator Bob has not paired with is refused too.
        let (eve, _erx) = start("grp-acc-eve").await;
        eve.inner.lock().unwrap().peers.insert(b_id, Peer {
            kind: PeerKind::Paired, name: "B".into(), addrs: vec![], proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        });
        let eg = eve.group_create("Eve's", &ids(&[b_id])).unwrap();
        let est = eve.group_state(eg["gid"].as_str().unwrap()).unwrap();
        assert!(bob.apply_group_state(wire(&est), eve.node_id()).is_err(), "unpaired creator");
        assert!(bob.groups().is_empty());

        // From Alice: accepted, C appears as an introduced member only.
        assert_eq!(bob.apply_group_state(wire(&st1), a_id).unwrap()["result"], "created");
        assert_eq!(bob.groups().len(), 1);
        assert_eq!(kind_of(&bob, &c), Some(PeerKind::Introduced));
        assert!(!peers_json_ids(&bob).contains(&c.to_string()));
        assert!(bob.status()["peers"].as_array().unwrap().iter().all(|p| p["id"] != c.to_string().as_str()));

        // Replay and rollback are ignored.
        assert_eq!(bob.apply_group_state(wire(&st1), a_id).unwrap()["result"], "stale");
        alice.group_rename(&gid, "Trio v2").unwrap();
        let st2 = alice.group_state(&gid).unwrap();
        // A non-creator member may relay the newer state.
        assert_eq!(bob.apply_group_state(wire(&st2), c).unwrap()["result"], "updated");
        assert_eq!(bob.groups()[0]["name"], "Trio v2");
        assert_eq!(bob.apply_group_state(wire(&st1), c).unwrap()["result"], "stale");
        assert_eq!(bob.groups()[0]["epoch"], 2);
        // A stranger can't relay.
        alice.group_rename(&gid, "Trio v3").unwrap();
        assert!(bob.apply_group_state(alice.group_state(&gid).unwrap(), stranger).is_err());
        // A member editing the roster breaks the signature.
        let mut forged = alice.group_state(&gid).unwrap();
        forged.name = "Mine now".into();
        assert!(bob.apply_group_state(forged, c).is_err());
        // A hand-signed 6-member state is refused by the receiver even though
        // the real creator signed it (the cap is enforced on receipt).
        let mut five = alice.group_state(&gid).unwrap();
        five.epoch = 50;
        five.members.push(GroupMember { node_id: fake_node_id().to_string(), name: "D".into(), addrs: vec![] });
        five.members.push(GroupMember { node_id: fake_node_id().to_string(), name: "E".into(), addrs: vec![] });
        five.members.push(GroupMember { node_id: fake_node_id().to_string(), name: "F".into(), addrs: vec![] });
        five.sign(&alice.secret).unwrap();
        assert!(bob.apply_group_state(five, a_id).is_err());
        assert_eq!(bob.groups()[0]["epoch"], 2);

        // Removal: the creator drops Bob; Bob keeps the history, goes read-only
        // and forgets the introduced entry nobody lists any more.
        alice.group_remove(&gid, &b_id.to_string()).unwrap();
        assert_eq!(bob.apply_group_state(alice.group_state(&gid).unwrap(), a_id).unwrap()["result"], "updated");
        let g = &bob.groups()[0];
        assert_eq!((g["removed"].as_bool(), g["canManage"].as_bool()), (Some(true), Some(false)));
        assert_eq!(kind_of(&bob, &c), None);
        // Bob's leave on the other side stays sticky across later states.
        assert!(bob.group_leave(&gid).is_ok());

        // A disband for a group the receiver is in marks it read-only.
        let d = add_fake_peer(&alice, PeerKind::Paired, 2);
        let g2 = alice.group_create("Duo", &ids(&[b_id, d])).unwrap();
        let gid2 = g2["gid"].as_str().unwrap().to_string();
        bob.apply_group_state(alice.group_state(&gid2).unwrap(), a_id).unwrap();
        alice.group_disband(&gid2).unwrap();
        bob.apply_group_state(alice.group_state(&gid2).unwrap(), a_id).unwrap();
        let g = bob.groups().into_iter().find(|g| g["gid"] == gid2.as_str()).unwrap();
        assert_eq!((g["closed"].as_bool(), g["removed"].as_bool()), (Some(true), Some(true)));
        assert_eq!(kind_of(&bob, &d), None);

        // Receiving cap: at MAX_GROUPS the next first contact is refused.
        let (carol, carol_rx) = start("grp-acc-carol").await;
        let (dan, _drx) = start("grp-acc-dan").await;
        let ticket = carol.create_invite().await.unwrap();
        dan.accept_invite(&ticket).await.unwrap();
        wait_for(&carol_rx, 15, |e| e["kind"] == "pairing");
        let ticket = carol.create_invite().await.unwrap();
        alice.accept_invite(&ticket).await.unwrap();
        wait_for(&carol_rx, 15, |e| e["kind"] == "pairing");
        for i in 0..MAX_GROUPS {
            let g = dan.group_create(&format!("n{i}"), &ids(&[carol.node_id()])).unwrap();
            carol.apply_group_state(dan.group_state(g["gid"].as_str().unwrap()).unwrap(), dan.node_id()).unwrap();
        }
        assert_eq!(carol.groups().len(), MAX_GROUPS);
        let og = alice.group_create("overflow", &ids(&[carol.node_id()])).unwrap();
        let overflow = alice.group_state(og["gid"].as_str().unwrap()).unwrap();
        assert!(carol.apply_group_state(overflow, a_id).is_err());
        assert_eq!(carol.groups().len(), MAX_GROUPS);
    }

    /// The inbound path for an introduced member: it gets a session (group
    /// frames only: 1:1 traffic and presence stay invisible), and it can still
    /// pair for real with a QR token, which turns it into a normal contact.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn introduced_member_session_is_group_only_and_can_still_pair() {
        let (alice, alice_rx) = start("grp-in-alice").await;
        let (carol, carol_rx) = start("grp-in-carol").await;
        let (creator, _crx) = start("grp-in-creator").await;
        let alice_addrs: Vec<SocketAddr> = alice.endpoint.node_addr().await.unwrap().direct_addresses.into_iter().collect();
        let carol_addrs: Vec<SocketAddr> = carol.endpoint.node_addr().await.unwrap().direct_addresses.into_iter().collect();
        let fake = |name: &str, addrs: Vec<SocketAddr>| Peer {
            kind: PeerKind::Paired, name: name.into(), addrs, proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        };
        creator.inner.lock().unwrap().peers.insert(alice.node_id(), fake("Alice", alice_addrs.clone()));
        creator.inner.lock().unwrap().peers.insert(carol.node_id(), fake("Carol", carol_addrs));
        alice.inner.lock().unwrap().peers.insert(creator.node_id(), fake("Creator", vec![]));
        // Carol knows Alice (so she dials her) but Alice only knows Carol from the roster.
        carol.inner.lock().unwrap().peers.insert(alice.node_id(), fake("Alice", alice_addrs));
        let g = creator.group_create("Trio", &ids(&[alice.node_id(), carol.node_id()])).unwrap();
        let st = creator.group_state(g["gid"].as_str().unwrap()).unwrap();
        alice.apply_group_state(st, creator.node_id()).unwrap();
        assert_eq!(kind_of(&alice, &carol.node_id()), Some(PeerKind::Introduced));

        carol.retry(&alice.node_id().to_string()).unwrap();
        wait_for(&carol_rx, 30, |e| e["kind"] == "presence" && e["online"] == true);
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while alice.inner.lock().unwrap().peers[&carol.node_id()].live.is_empty() {
            assert!(std::time::Instant::now() < deadline, "alice never accepted the introduced member's session");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // Group-only: a 1:1 text from the introduced member goes nowhere.
        carol.send(&alice.node_id().to_string(), "hello?", None, None).unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(alice.inner.lock().unwrap().peers[&carol.node_id()].msgs.is_empty());
        while let Ok(e) = alice_rx.try_recv() {
            assert!(e["kind"] != "message" && e["kind"] != "presence", "leaked to the UI: {e}");
        }
        assert_eq!(alice.status()["peers"].as_array().unwrap().iter().filter(|p| p["id"] == carol.node_id().to_string().as_str()).count(), 0);

        // The same device now pairs with a real invite: becomes a contact.
        let ticket = alice.create_invite().await.unwrap();
        carol.accept_invite(&ticket).await.unwrap();
        wait_for(&alice_rx, 20, |e| e["kind"] == "pairing");
        assert_eq!(kind_of(&alice, &carol.node_id()), Some(PeerKind::Paired));
        assert!(peers_json_ids(&alice).contains(&carol.node_id().to_string()));
        let id = carol.send(&alice.node_id().to_string(), "now we are paired", None, None).unwrap();
        wait_for(&alice_rx, 30, |e| e["kind"] == "message" && e["text"] == "now we are paired");
        wait_for(&carol_rx, 30, |e| e["kind"] == "ack" && e["id"] == id["id"]);
    }

    /// Group frames may only be put on sessions that negotiated protocol 2.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn group_frames_only_go_to_proto2_sessions() {
        let (a, _rx) = start("grp-proto").await;
        let v1 = add_fake_peer(&a, PeerKind::Paired, 1);
        let v2 = add_fake_peer(&a, PeerKind::Paired, 2);
        for (id, proto) in [(v1, 1u8), (v2, 2u8)] {
            let (tx, _rx) = mpsc::unbounded_channel();
            std::mem::forget(_rx); // keep the channel open for the duration of the test
            a.register_live(id, tx, proto);
        }
        assert!(a.group_session(&v1).is_none(), "a v1 session never carries group frames");
        assert!(a.group_session(&v2).is_some());
        assert!(a.group_session(&fake_node_id()).is_none());
    }

    /// Groups survive a restart exactly (and are signed state, so a changed
    /// file is not trusted).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn groups_survive_restart() {
        let (a, _rx) = start("grp-restart").await;
        let b = add_fake_peer(&a, PeerKind::Paired, 2);
        a.persist_peers(&a.inner.lock().unwrap()).unwrap();
        let g = a.group_create("Keep", &ids(&[b])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        a.group_rename(&gid, "Kept").unwrap();
        let before = a.group_state(&gid).unwrap();
        let (dir, blobs) = (a.dir.clone(), a.blobs_dir.clone());
        a.close().await;
        drop(a);
        let (tx, _rx2) = std_mpsc::channel();
        let a2 = P2p::start(dir, blobs, Sink::Test(tx)).await.unwrap();
        assert_eq!(a2.group_state(&gid).unwrap(), before);
        assert_eq!(a2.status()["groups"].as_array().unwrap().len(), 1);
        a2.group_state(&gid).unwrap().check().unwrap();
        assert!(a2.group_add(&gid, &b.to_string()).is_err()); // still the creator, b already in
        assert_eq!(a2.group_rename(&gid, "Kept 2").unwrap()["epoch"], 3);
    }

    // -- local groups (Phase 2: messages over the mesh) -------------------------

    /// Polls `f` (async-friendly: engines keep running meanwhile).
    async fn until(secs: u64, what: &str, f: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        while !f() {
            assert!(std::time::Instant::now() < deadline, "timed out: {what}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// A fake live session of `node` on `engine`: frames the engine writes to
    /// it land in the returned receiver, frames "from the peer" are fed with
    /// `engine.handle_frame(node, frame, &tx)`.
    fn attach_live(engine: &Arc<P2p>, node: NodeId, proto: u8) -> (FrameTx, mpsc::UnboundedReceiver<Frame>) {
        let (tx, rx) = mpsc::unbounded_channel();
        engine.register_live(node, tx.clone(), proto);
        (tx, rx)
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<Frame>) -> Vec<Frame> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    fn events(rx: &std_mpsc::Receiver<Value>) -> Vec<Value> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    fn acks_in(frames: &[Frame]) -> Vec<u64> {
        frames.iter().filter_map(|f| if let Frame::GroupAck { have, .. } = f { Some(*have) } else { None }).collect()
    }

    fn syncs_in(frames: &[Frame]) -> Vec<(u64, u64)> {
        frames.iter().filter_map(|f| if let Frame::GroupSync { epoch, have, .. } = f { Some((*epoch, *have)) } else { None }).collect()
    }

    fn msg_seqs_in(frames: &[Frame]) -> Vec<u64> {
        frames.iter().filter_map(|f| if let Frame::GroupMsg { seq, .. } = f { Some(*seq) } else { None }).collect()
    }

    fn gmsg(gid: &str, from: &NodeId, seq: u64, text: &str) -> Frame {
        Frame::GroupMsg {
            gid: gid.to_string(),
            from: from.to_string(),
            seq,
            id: format!("id{seq}-{}", &from.to_string()[..6]),
            ts: now_ms(),
            text: text.to_string(),
            reply_to: None,
            reply_text: None,
        }
    }

    fn paper(name: &str) -> Peer {
        Peer {
            kind: PeerKind::Paired, name: name.into(), addrs: vec![], proto: 2,
            live: vec![], connecting: false, queued: vec![], msgs: vec![],
        }
    }

    /// `me` is a non-creator member of {creator, me, d}; the creator and d are
    /// on paper only. Frames are fed to `me` by hand.
    async fn unit_member(tag: &str) -> (Arc<P2p>, std_mpsc::Receiver<Value>, Arc<P2p>, NodeId, String) {
        let (cr, _crx) = start(&format!("{tag}-cr")).await;
        let (me, me_rx) = start(tag).await;
        cr.inner.lock().unwrap().peers.insert(me.node_id(), paper("Me"));
        me.inner.lock().unwrap().peers.insert(cr.node_id(), paper("Creator"));
        let d = add_fake_peer(&cr, PeerKind::Paired, 2);
        let g = cr.group_create("Unit", &ids(&[me.node_id(), d])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        me.apply_group_state(cr.group_state(&gid).unwrap(), cr.node_id()).unwrap();
        events(&me_rx);
        (me, me_rx, cr, d, gid)
    }

    /// `cr` created {cr, b, d} (paper peers); `b` and `d` have live fake sessions.
    async fn unit_author(tag: &str) -> (Arc<P2p>, std_mpsc::Receiver<Value>, String, [(NodeId, FrameTx, mpsc::UnboundedReceiver<Frame>); 2]) {
        let (cr, rx) = start(tag).await;
        let b = add_fake_peer(&cr, PeerKind::Paired, 2);
        let d = add_fake_peer(&cr, PeerKind::Paired, 2);
        let g = cr.group_create("Author", &ids(&[b, d])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        let (tb, rb) = attach_live(&cr, b, 2);
        let (td, rd) = attach_live(&cr, d, 2);
        (cr, rx, gid, [(b, tb, rb), (d, td, rd)])
    }

    fn sync_from(gid: &str, epoch: u64, have: u64) -> Frame {
        Frame::GroupSync { gid: gid.to_string(), epoch, have, name: "peer".into() }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_msg_seq_dedup_and_gap_detection() {
        let (me, rx, cr, _d, gid) = unit_member("grp-fifo").await;
        let author = cr.node_id();
        let (tx, mut out) = attach_live(&me, author, 2);

        me.handle_frame(author, gmsg(&gid, &author, 1, "one"), &tx);
        let evs = events(&rx);
        let got = evs.iter().find(|e| e["kind"] == "group-message").expect("event for seq 1");
        assert_eq!((got["text"].as_str(), got["seq"].as_u64(), got["gid"].as_str()), (Some("one"), Some(1), Some(gid.as_str())));
        assert_eq!(got["from"], author.to_string().as_str());
        assert_eq!(acks_in(&drain(&mut out)), vec![1]);

        // Duplicate (a replay after a lost ack): no event, no second copy, re-ack.
        me.handle_frame(author, gmsg(&gid, &author, 1, "one"), &tx);
        assert!(events(&rx).iter().all(|e| e["kind"] != "group-message"));
        assert_eq!(acks_in(&drain(&mut out)), vec![1]);

        // Gap: 3 before 2 is dropped and answered with ONE GroupSync{have:1}.
        me.handle_frame(author, gmsg(&gid, &author, 3, "three"), &tx);
        me.handle_frame(author, gmsg(&gid, &author, 4, "four"), &tx);
        assert!(events(&rx).iter().all(|e| e["kind"] != "group-message"));
        let frames = drain(&mut out);
        assert_eq!(syncs_in(&frames), vec![(1, 1)], "one replay request for the burst");
        assert!(acks_in(&frames).is_empty());

        // The replay arrives in order and everything lands once.
        for (seq, text) in [(2, "two"), (3, "three"), (4, "four")] {
            me.handle_frame(author, gmsg(&gid, &author, seq, text), &tx);
        }
        assert_eq!(acks_in(&drain(&mut out)), vec![2, 3, 4]);
        let log = chat_rows(&me, &gid, 50);
        let texts: Vec<&str> = log.iter().map(|r| r["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["one", "two", "three", "four"]);
        assert_eq!(me.inner.lock().unwrap().groups[&gid].have[&author.to_string()], 4);
        // A later gap with the same `have` is asked for again (new situation).
        me.handle_frame(author, gmsg(&gid, &author, 9, "nine"), &tx);
        assert_eq!(syncs_in(&drain(&mut out)), vec![(1, 4)]);
        // ts_eff never goes backwards, never into the future.
        let effs: Vec<u64> = log.iter().map(|r| r["tsEff"].as_u64().unwrap()).collect();
        assert!(effs.windows(2).all(|w| w[0] <= w[1]));
        assert!(effs.iter().all(|e| *e <= now_ms()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_receive_rejects_forged_sender_non_member_bad_text_and_v1_sessions() {
        let (me, rx, cr, d, gid) = unit_member("grp-rej").await;
        let author = cr.node_id();
        let (tx, mut out) = attach_live(&me, author, 2);
        let stored = |me: &Arc<P2p>| chat_rows(&me, &gid, 50).len();

        // `from` must be the authenticated session node.
        me.handle_frame(author, gmsg(&gid, &d, 1, "pretending to be d"), &tx);
        assert_eq!(stored(&me), 0);
        let evs = events(&rx);
        assert!(evs.iter().any(|e| e["kind"] == "error" && e["message"].as_str().unwrap().contains("forged")));
        assert!(evs.iter().all(|e| e["kind"] != "group-message"));
        assert!(drain(&mut out).is_empty());

        // A paired contact that is not in the roster is ignored without a word.
        let outsider = add_fake_peer(&me, PeerKind::Paired, 2);
        let (otx, mut oout) = attach_live(&me, outsider, 2);
        me.handle_frame(outsider, gmsg(&gid, &outsider, 1, "let me in"), &otx);
        me.handle_frame(outsider, sync_from(&gid, 1, 0), &otx);
        assert_eq!(stored(&me), 0);
        assert!(drain(&mut oout).is_empty(), "nothing leaks to a non-member at the current epoch");
        assert!(events(&rx).iter().all(|e| e["kind"] != "group-message"));

        // Empty / oversized text, seq 0, unsafe id.
        me.handle_frame(author, gmsg(&gid, &author, 1, ""), &tx);
        me.handle_frame(author, gmsg(&gid, &author, 1, &"x".repeat(MAX_GROUP_TEXT + 1)), &tx);
        me.handle_frame(author, gmsg(&gid, &author, 0, "zero"), &tx);
        let mut bad_id = gmsg(&gid, &author, 1, "bad id");
        if let Frame::GroupMsg { id, .. } = &mut bad_id { *id = "../x".into(); }
        me.handle_frame(author, bad_id, &tx);
        assert_eq!(stored(&me), 0);
        assert!(acks_in(&drain(&mut out)).is_empty());

        // A group frame on a protocol-1 session is ignored.
        let v1 = add_fake_peer(&me, PeerKind::Paired, 1);
        let (vtx, mut vout) = attach_live(&me, v1, 1);
        me.handle_frame(v1, gmsg(&gid, &v1, 1, "v1"), &vtx);
        me.handle_frame(v1, sync_from("0".repeat(32).as_str(), 1, 0), &vtx);
        assert!(drain(&mut vout).is_empty());
        assert_eq!(stored(&me), 0);

        // And the happy path still works after all that.
        me.handle_frame(author, gmsg(&gid, &author, 1, "fine"), &tx);
        assert_eq!(stored(&me), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_unknown_gid_gets_group_gone_and_gone_marks_only_the_sender() {
        let (me, _rx, cr, d, gid) = unit_member("grp-gone").await;
        let author = cr.node_id();
        let (tx, mut out) = attach_live(&me, author, 2);
        let unknown = "f".repeat(32);

        me.handle_frame(author, sync_from(&unknown, 1, 0), &tx);
        me.handle_frame(author, gmsg(&unknown, &author, 1, "x"), &tx);
        let frames = drain(&mut out);
        assert_eq!(frames.iter().filter(|f| matches!(f, Frame::GroupGone { gid } if *gid == unknown)).count(), 2);
        // GroupGone itself is never answered (no ping-pong).
        me.handle_frame(author, Frame::GroupGone { gid: unknown.clone() }, &tx);
        assert!(drain(&mut out).is_empty());

        // A group I left answers with GroupGone too.
        me.group_leave(&gid).unwrap();
        // (the creator is told about the leave right away)
        assert!(matches!(drain(&mut out).as_slice(), [Frame::GroupLeave { .. }]));
        me.handle_frame(author, sync_from(&gid, 1, 0), &tx);
        assert!(matches!(drain(&mut out).as_slice(), [Frame::GroupGone { .. }]));

        // Author side: X says it is gone -> X is skipped until a newer state;
        // the mark is only ever about X itself.
        let (cr2, _r2, gid2, [(b, tb, mut rb), (d2, td, mut rd)]) = unit_author("grp-gone-author").await;
        cr2.handle_frame(b, sync_from(&gid2, 1, 0), &tb);
        cr2.handle_frame(d2, sync_from(&gid2, 1, 0), &td);
        drain(&mut rb);
        drain(&mut rd);
        cr2.handle_frame(b, Frame::GroupGone { gid: gid2.clone() }, &tb);
        cr2.group_send(&gid2, "after gone", None, None).unwrap();
        assert!(msg_seqs_in(&drain(&mut rb)).is_empty(), "b said it is gone");
        assert_eq!(msg_seqs_in(&drain(&mut rd)), vec![1], "d is unaffected");
        // b syncs again (it has the group after all): delivery resumes.
        cr2.handle_frame(b, sync_from(&gid2, 1, 0), &tb);
        assert_eq!(msg_seqs_in(&drain(&mut rb)), vec![1]);
        let _ = d;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_state_relayed_by_non_creator_is_accepted_and_epoch_rollback_ignored() {
        let (me, rx, cr, d, gid) = unit_member("grp-relay").await;
        let author = cr.node_id();
        let (_tx, _out) = attach_live(&me, author, 2);
        let (dtx, mut dout) = attach_live(&me, d, 2);
        let st1 = cr.group_state(&gid).unwrap();
        cr.group_rename(&gid, "Renamed").unwrap();
        let st2 = cr.group_state(&gid).unwrap();
        assert_eq!(st2.epoch, 2);

        // Member d (not the creator) relays the creator-signed epoch 2.
        me.handle_frame(d, Frame::GroupState { state: st2.clone() }, &dtx);
        assert_eq!(me.groups()[0]["name"], "Renamed");
        assert!(events(&rx).iter().any(|e| e["kind"] == "group-state" && e["group"]["epoch"] == 2));
        // Rolling back to epoch 1 (replayed by anyone) changes nothing.
        me.handle_frame(d, Frame::GroupState { state: st1 }, &dtx);
        assert_eq!(me.groups()[0]["epoch"], 2);
        assert_eq!(me.groups()[0]["name"], "Renamed");
        // A tampered state is refused and reported, not applied.
        let mut forged = st2.clone();
        forged.epoch = 3;
        forged.name = "Hijacked".into();
        me.handle_frame(d, Frame::GroupState { state: forged }, &dtx);
        assert_eq!(me.groups()[0]["name"], "Renamed");
        assert!(events(&rx).iter().any(|e| e["kind"] == "error"));
        drain(&mut dout);

        // Epoch exchange: a peer behind me is sent my state; a peer ahead of
        // me is sent my epoch (so it relays its state).
        me.handle_frame(d, sync_from(&gid, 1, 0), &dtx);
        let frames = drain(&mut dout);
        assert!(frames.iter().any(|f| matches!(f, Frame::GroupState { state } if state.epoch == 2)));
        me.handle_frame(d, sync_from(&gid, 9, 0), &dtx);
        assert_eq!(syncs_in(&drain(&mut dout)), vec![(2, 0)]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_author_replays_from_the_receivers_cursor_without_duplicates() {
        let (cr, rx, gid, [(b, tb, mut rb), (d, td, mut rd)]) = unit_author("grp-replay").await;
        // Nothing is pushed before the member's GroupSync (and its epoch) is known.
        for i in 1..=5 {
            let r = cr.group_send(&gid, &format!("m{i}"), None, None).unwrap();
            assert_eq!((r["seq"].as_u64(), r["queued"].as_bool()), (Some(i), Some(true)));
        }
        assert!(msg_seqs_in(&drain(&mut rb)).is_empty());

        // b already holds 1..=2: replay is 3..=5, once.
        cr.handle_frame(b, sync_from(&gid, 1, 2), &tb);
        assert_eq!(msg_seqs_in(&drain(&mut rb)), vec![3, 4, 5]);
        assert_eq!(cr.inner.lock().unwrap().groups[&gid].sent_cursor[&b.to_string()], 2);
        let acks: Vec<Value> = events(&rx).into_iter().filter(|e| e["kind"] == "group-ack").collect();
        assert_eq!((acks[0]["by"].as_str(), acks[0]["have"].as_u64()), (Some(b.to_string().as_str()), Some(2)));

        // Live messages stream straight to a member that is in step.
        let r = cr.group_send(&gid, "m6", None, None).unwrap();
        assert_eq!(r["queued"], false);
        assert_eq!(msg_seqs_in(&drain(&mut rb)), vec![6]);
        // d never synced: nothing for it yet.
        assert!(msg_seqs_in(&drain(&mut rd)).is_empty());

        // b reports a gap (it lost 4 and 5): replay from its `have`, not from 1.
        cr.handle_frame(b, sync_from(&gid, 1, 3), &tb);
        assert_eq!(msg_seqs_in(&drain(&mut rb)), vec![4, 5, 6]);
        cr.handle_frame(b, Frame::GroupAck { gid: gid.clone(), have: 6 }, &tb);
        assert!(msg_seqs_in(&drain(&mut rb)).is_empty());
        // Acks are clamped to what exists and never go backwards.
        cr.handle_frame(b, Frame::GroupAck { gid: gid.clone(), have: 999 }, &tb);
        cr.handle_frame(b, Frame::GroupAck { gid: gid.clone(), have: 1 }, &tb);
        assert_eq!(cr.inner.lock().unwrap().groups[&gid].sent_cursor[&b.to_string()], 6);

        // d joins the party late: the whole log, in order.
        cr.handle_frame(d, sync_from(&gid, 1, 0), &td);
        assert_eq!(msg_seqs_in(&drain(&mut rd)), vec![1, 2, 3, 4, 5, 6]);

        // Delivery state per message comes from the cursors.
        let log = chat_rows(&cr, &gid, 10);
        let delivered = |i: usize| log[i]["delivered"].as_array().unwrap().len();
        assert_eq!((delivered(0), delivered(5)), (1, 1), "only b has acked so far");
        cr.handle_frame(d, Frame::GroupAck { gid: gid.clone(), have: 6 }, &td);
        assert_eq!(chat_rows(&cr, &gid, 10)[0]["delivered"].as_array().unwrap().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_replay_is_paged_by_the_ack_window() {
        let (cr, _rx, gid, [(b, tb, mut rb), _]) = unit_author("grp-window").await;
        for i in 0..250 {
            cr.group_send(&gid, &format!("m{i}"), None, None).unwrap();
        }
        cr.handle_frame(b, sync_from(&gid, 1, 0), &tb);
        assert_eq!(msg_seqs_in(&drain(&mut rb)).len() as u64, GROUP_WINDOW);
        cr.handle_frame(b, Frame::GroupAck { gid: gid.clone(), have: 200 }, &tb);
        assert_eq!(msg_seqs_in(&drain(&mut rb)), (201..=250).collect::<Vec<u64>>());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_remove_member_stops_delivery_and_tells_it_why() {
        let (cr, _rx, gid, [(b, tb, mut rb), (d, td, mut rd)]) = unit_author("grp-rm").await;
        cr.handle_frame(b, sync_from(&gid, 1, 0), &tb);
        cr.handle_frame(d, sync_from(&gid, 1, 0), &td);
        cr.group_send(&gid, "before", None, None).unwrap();
        assert_eq!(msg_seqs_in(&drain(&mut rb)), vec![1]);
        drain(&mut rd);

        cr.group_remove(&gid, &d.to_string()).unwrap();
        // d is told (state) but does not get a sync back into the roster.
        let to_d = drain(&mut rd);
        assert!(to_d.iter().any(|f| matches!(f, Frame::GroupState { state } if state.epoch == 2 && !state.contains(&d))));
        assert!(syncs_in(&to_d).is_empty());
        // b is told too; once it re-syncs at epoch 2 delivery continues for b only.
        drain(&mut rb);
        cr.group_send(&gid, "after", None, None).unwrap();
        assert!(msg_seqs_in(&drain(&mut rb)).is_empty(), "b is still at the old epoch: hold until it re-syncs");
        cr.handle_frame(b, sync_from(&gid, 2, 1), &tb);
        assert_eq!(msg_seqs_in(&drain(&mut rb)), vec![2]);
        assert!(msg_seqs_in(&drain(&mut rd)).is_empty());
        // d keeps syncing at epoch 1: it only learns the new roster, never the messages.
        cr.handle_frame(d, sync_from(&gid, 1, 1), &td);
        let frames = drain(&mut rd);
        assert!(msg_seqs_in(&frames).is_empty());
        assert!(frames.iter().any(|f| matches!(f, Frame::GroupState { .. })));
        // …and a message it sends is dropped.
        cr.handle_frame(d, gmsg(&gid, &d, 1, "still here?"), &td);
        assert_eq!(chat_rows(&cr, &gid, 10).len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_disband_state_reaches_a_member_that_syncs_later() {
        let (cr, _rx, gid, [(b, tb, mut rb), _]) = unit_author("grp-disband-late").await;
        cr.group_disband(&gid).unwrap();
        drain(&mut rb);
        // b was offline for the disband and still thinks it is epoch 1.
        cr.handle_frame(b, sync_from(&gid, 1, 0), &tb);
        let frames = drain(&mut rb);
        assert!(frames.iter().any(|f| matches!(f, Frame::GroupState { state } if state.closed && state.epoch == 2)));
        // Once it is current, the disbanded group only says "gone".
        cr.handle_frame(b, sync_from(&gid, 2, 0), &tb);
        assert!(matches!(drain(&mut rb).as_slice(), [Frame::GroupGone { .. }]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn v1_only_peer_never_receives_group_frames() {
        let (cr, _rx, gid, [(b, tb, mut rb), (d, _td, _rd)]) = unit_author("grp-v1").await;
        // b is downgraded: its (live) session negotiated protocol 1.
        cr.inner.lock().unwrap().peers.get_mut(&b).unwrap().live.clear();
        let (v1tx, mut v1rx) = attach_live(&cr, b, 1);
        assert!(cr.group_session(&b).is_none());
        cr.group_session_open(b, &v1tx);
        cr.group_send(&gid, "hello", None, None).unwrap();
        cr.group_rename(&gid, "renamed").unwrap();
        cr.handle_frame(b, sync_from(&gid, 1, 0), &v1tx);
        cr.handle_frame(b, Frame::GroupGone { gid: gid.clone() }, &v1tx);
        assert!(drain(&mut v1rx).is_empty(), "a 1.4.x peer would choke on any of these");
        let _ = (&tb, &mut rb, d);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn typing_hints_are_live_v2_only_scoped_and_never_stored() {
        let (cr, rx, gid, [(b, tb, mut rb), (d, td, mut rd)]) = unit_author("typing-unit").await;
        // Wire shape; an old sender's frame without `gid` still parses.
        let w = serde_json::to_value(Frame::Typing { gid: None, on: true }).unwrap();
        assert_eq!((w["type"].as_str(), w["on"].as_bool()), (Some("typing"), Some(true)));
        assert!(matches!(serde_json::from_str::<Frame>(r#"{"type":"typing","on":false}"#).unwrap(), Frame::Typing { gid: None, on: false }));

        // Sending: 1:1 reaches a live v2 peer; group reaches every live v2 member.
        assert!(cr.typing_peer(&b.to_string(), true).unwrap());
        assert!(matches!(drain(&mut rb).as_slice(), [Frame::Typing { gid: None, on: true }]));
        assert_eq!(cr.typing_group(&gid, true).unwrap(), 2);
        for rxm in [&mut rb, &mut rd] {
            assert!(matches!(drain(rxm).as_slice(), [Frame::Typing { gid: Some(g), on: true }] if *g == gid));
        }
        // Offline peers and protocol-1 sessions get nothing (and nothing is queued).
        let off = add_fake_peer(&cr, PeerKind::Paired, 2);
        assert!(!cr.typing_peer(&off.to_string(), true).unwrap());
        assert!(cr.inner.lock().unwrap().peers[&off].queued.is_empty());
        let v1 = add_fake_peer(&cr, PeerKind::Paired, 1);
        let (_v1tx, mut v1rx) = attach_live(&cr, v1, 1);
        assert!(!cr.typing_peer(&v1.to_string(), true).unwrap());
        assert!(drain(&mut v1rx).is_empty(), "a 1.4.x peer would drop the session on this frame");
        assert!(cr.typing_peer(&fake_node_id().to_string(), true).is_err(), "unknown peer");
        assert!(cr.typing_group("00000000000000000000000000000000", true).is_err());

        // Receiving: a 1:1 hint becomes one event, an immediate repeat is
        // swallowed, a state change is not.
        events(&rx);
        cr.handle_frame(b, Frame::Typing { gid: None, on: true }, &tb);
        cr.handle_frame(b, Frame::Typing { gid: None, on: true }, &tb);
        cr.handle_frame(b, Frame::Typing { gid: None, on: false }, &tb);
        let ev: Vec<Value> = events(&rx).into_iter().filter(|e| e["kind"] == "typing").collect();
        assert_eq!(ev.len(), 2, "{ev:?}");
        assert_eq!((ev[0]["peerId"].as_str(), ev[0]["on"].as_bool()), (Some(b.to_string().as_str()), Some(true)));
        assert_eq!(ev[1]["on"], false);
        // A group hint names the sender; a non-member or unknown gid is ignored.
        cr.handle_frame(d, Frame::Typing { gid: Some(gid.clone()), on: true }, &td);
        let ev: Vec<Value> = events(&rx).into_iter().filter(|e| e["kind"] == "group-typing").collect();
        assert_eq!(ev.len(), 1);
        assert_eq!((ev[0]["gid"].as_str(), ev[0]["from"].as_str(), ev[0]["on"].as_bool()), (Some(gid.as_str()), Some(d.to_string().as_str()), Some(true)));
        assert!(ev[0]["name"].as_str().map_or(false, |n| !n.is_empty()));
        cr.handle_frame(d, Frame::Typing { gid: Some("00000000000000000000000000000000".into()), on: true }, &td);
        let outsider = add_fake_peer(&cr, PeerKind::Paired, 2);
        let (otx, _orx) = attach_live(&cr, outsider, 2);
        cr.handle_frame(outsider, Frame::Typing { gid: Some(gid.clone()), on: true }, &otx);
        // An introduced member may not send 1:1 typing; a v1 session's hint is dropped.
        let intro = add_fake_peer(&cr, PeerKind::Introduced, 2);
        let (itx, _irx) = attach_live(&cr, intro, 2);
        cr.handle_frame(intro, Frame::Typing { gid: None, on: true }, &itx);
        cr.handle_frame(v1, Frame::Typing { gid: None, on: true }, &_v1tx);
        assert!(events(&rx).iter().all(|e| e["kind"] != "typing" && e["kind"] != "group-typing"));
        // Nothing was stored anywhere.
        assert!(cr.inner.lock().unwrap().peers[&b].msgs.is_empty());
        assert!(chat_rows(&cr, &gid, 50).is_empty());
        // A removed group no longer carries hints.
        cr.group_disband(&gid).unwrap();
        assert_eq!(cr.typing_group(&gid, true).unwrap(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn typing_hints_travel_between_real_engines() {
        let t = trio("typing-wire").await;
        let (aid, bid) = (t.a.node_id().to_string(), t.b.node_id().to_string());
        assert!(t.a.typing_peer(&bid, true).unwrap());
        let ev = wait_for(&t.b_rx, 20, |e| e["kind"] == "typing");
        assert_eq!((ev["peerId"].as_str(), ev["on"].as_bool()), (Some(aid.as_str()), Some(true)));
        assert_eq!(t.a.typing_group(&t.gid, true).unwrap(), 2);
        for rx in [&t.b_rx, &t.c_rx] {
            let ev = wait_for(rx, 20, |e| e["kind"] == "group-typing");
            assert_eq!((ev["gid"].as_str(), ev["from"].as_str()), (Some(t.gid.as_str()), Some(aid.as_str())));
        }
        // B -> C over the introduced session (they never paired).
        assert_eq!(t.b.typing_group(&t.gid, true).unwrap(), 2);
        let ev = wait_for(&t.c_rx, 20, |e| e["kind"] == "group-typing" && e["from"] == bid.as_str());
        assert_eq!(ev["on"], true);
        assert!(t.b.typing_peer(&t.c.node_id().to_string(), true).is_err(), "an introduced member is no 1:1 contact");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_counters_are_rebuilt_from_the_log_after_a_crash() {
        let (cr, _rx, gid, [(b, _tb, _rb), _]) = unit_author("grp-crash").await;
        cr.group_send(&gid, "one", None, None).unwrap();
        cr.group_send(&gid, "two", None, None).unwrap();
        // A crash between "log line appended" and "groups.json saved":
        let me = cr.node_id().to_string();
        let line = |from: &str, seq: u64, dir: &str| GroupLogRec {
            seq, from: from.into(), id: format!("c{seq}{dir}"), ts: now_ms(), ts_eff: now_ms(), dir: dir.into(),
            text: "late".into(), reply_to: None, reply_text: None, file: None,
        };
        append_log(&cr.dir, &gid, &line(&me, 3, "out")).unwrap();
        append_log(&cr.dir, &gid, &line(&b.to_string(), 7, "in")).unwrap();
        let (dir, blobs) = (cr.dir.clone(), cr.blobs_dir.clone());
        cr.close().await;
        drop(cr);
        let (tx, _rx2) = std_mpsc::channel();
        let cr2 = P2p::start(dir, blobs, Sink::Test(tx)).await.unwrap();
        {
            let inner = cr2.inner.lock().unwrap();
            assert_eq!(inner.groups[&gid].next_seq, 4, "the next message must not reuse seq 3");
            assert_eq!(inner.groups[&gid].have[&b.to_string()], 7);
        }
        assert_eq!(cr2.group_send(&gid, "four", None, None).unwrap()["seq"], 4);
    }

    // -- groups of up to 5 -------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn five_member_group_is_offered_only_to_members_that_announced_support() {
        let (a, _rx) = start("grp-five").await;
        let peers: Vec<NodeId> = (0..4).map(|_| add_fake_peer(&a, PeerKind::Paired, 2)).collect();
        let five = ids(&peers);
        let err = a.group_create("Five", &five).unwrap_err().to_string();
        assert!(err.contains("more than 4") && err.contains("Fake"), "names the member that may be old: {err}");
        assert!(a.groups().is_empty());
        // Four of four announced, except one that announced the old cap.
        for (i, p) in peers.iter().enumerate() {
            let (tx, _rx) = attach_live(&a, *p, 2);
            a.handle_frame(*p, Frame::GroupCaps { max: if i == 3 { 4 } else { 5 } }, &tx);
        }
        assert!(a.group_create("Five", &five).is_err());
        let (tx, _rx) = attach_live(&a, peers[3], 2);
        a.handle_frame(peers[3], Frame::GroupCaps { max: 5 }, &tx);
        let g = a.group_create("Five", &five).unwrap();
        assert_eq!(g["members"].as_array().unwrap().len(), 5);
        // Up to 4 members never needs the announcement.
        assert!(a.group_create("Four", &ids(&peers[..3])).is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_open_announces_the_group_cap_on_v2_only() {
        let (a, _rx) = start("grp-caps-open").await;
        let (b, v1) = (add_fake_peer(&a, PeerKind::Paired, 2), add_fake_peer(&a, PeerKind::Paired, 1));
        let (tb, mut rb) = attach_live(&a, b, 2);
        let (tv, mut rv) = attach_live(&a, v1, 1);
        a.group_session_open(b, &tb);
        a.group_session_open(v1, &tv);
        assert!(drain(&mut rb).iter().any(|f| matches!(f, Frame::GroupCaps { max } if *max as usize == MAX_GROUP_MEMBERS)));
        assert!(drain(&mut rv).is_empty(), "a v1 session never sees a group frame");
        // Old builds skip it instead of failing the parse.
        let wire = serde_json::to_string(&Frame::GroupCaps { max: 5 }).unwrap();
        assert_eq!(wire, r#"{"type":"groupcaps","max":5}"#);
    }

    /// 5 real engines: the creator's 5-member roster reaches everyone and a
    /// message fans out to all four others.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn five_real_engines_form_a_group_and_chat() {
        let (a, a_rx) = start("five-a").await;
        let mut others = Vec::new();
        for n in ["b", "c", "d", "e"] {
            let (x, rx) = start(&format!("five-{n}")).await;
            pair(&a, &a_rx, &x).await;
            others.push((x, rx));
        }
        // Sessions announce their cap right after pairing.
        until(30, "every member announced its cap", || {
            let inner = a.inner.lock().unwrap();
            others.iter().all(|(x, _)| inner.grt.caps.get(&x.node_id()).copied() == Some(MAX_GROUP_MEMBERS as u8))
        })
        .await;
        let members: Vec<NodeId> = others.iter().map(|(x, _)| x.node_id()).collect();
        let gid = a.group_create("Five", &ids(&members)).unwrap()["gid"].as_str().unwrap().to_string();
        for (x, _) in &others {
            until(30, "roster delivered", || x.groups().len() == 1 && x.groups()[0]["members"].as_array().unwrap().len() == 5).await;
        }
        until(60, "full mesh", || {
            others.iter().all(|(x, _)| {
                let inner = x.inner.lock().unwrap();
                members.iter().filter(|m| **m != x.node_id()).all(|m| inner.peers.get(m).map_or(false, |p| p.online()))
            })
        })
        .await;
        a.group_send(&gid, "hello five", None, None).unwrap();
        for (_, rx) in &others {
            let ev = wait_for(rx, 30, |e| e["kind"] == "group-message");
            assert_eq!(ev["text"], "hello five");
        }
        // A member's message reaches the other four too (4 connections each).
        let (e, _) = &others[3];
        e.group_send(&gid, "from e", None, None).unwrap();
        wait_for(&a_rx, 30, |ev| ev["kind"] == "group-message" && ev["text"] == "from e");
        for (_, rx) in &others[..3] {
            wait_for(rx, 30, |ev| ev["kind"] == "group-message" && ev["text"] == "from e");
        }
    }

    // -- real engines over QUIC -------------------------------------------------

    struct Trio {
        a: Arc<P2p>,
        b: Arc<P2p>,
        c: Arc<P2p>,
        a_rx: std_mpsc::Receiver<Value>,
        b_rx: std_mpsc::Receiver<Value>,
        c_rx: std_mpsc::Receiver<Value>,
        gid: String,
    }

    async fn pair(host: &Arc<P2p>, host_rx: &std_mpsc::Receiver<Value>, guest: &Arc<P2p>) {
        let ticket = host.create_invite().await.unwrap();
        guest.accept_invite(&ticket).await.unwrap();
        wait_for(host_rx, 20, |e| e["kind"] == "pairing");
    }

    /// A creates {A, B, C}; A is paired with B and C, B and C only know each
    /// other from the roster. Returns once B and C hold the group and have a
    /// session to each other.
    async fn trio(tag: &str) -> Trio {
        let (a, a_rx) = start(&format!("{tag}-a")).await;
        let (b, b_rx) = start(&format!("{tag}-b")).await;
        let (c, c_rx) = start(&format!("{tag}-c")).await;
        pair(&a, &a_rx, &b).await;
        pair(&a, &a_rx, &c).await;
        let g = a.group_create("Trio", &ids(&[b.node_id(), c.node_id()])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        until(20, "B and C receive the roster", || !b.groups().is_empty() && !c.groups().is_empty()).await;
        let (bid, cid) = (b.node_id(), c.node_id());
        until(40, "B and C connect through the introduction", || {
            let live = |e: &Arc<P2p>, o: &NodeId| e.inner.lock().unwrap().peers.get(o).map_or(false, |p| p.online());
            live(&b, &cid) && live(&c, &bid)
        })
        .await;
        Trio { a, b, c, a_rx, b_rx, c_rx, gid }
    }

    /// The chat rows of a group (system lines are asserted separately).
    fn chat_rows(engine: &Arc<P2p>, gid: &str, limit: usize) -> Vec<Value> {
        engine.group_messages(gid, limit).unwrap().into_iter().filter(|r| r["dir"] != "sys").collect()
    }

    /// The system lines of a group as (kind, text), oldest first.
    fn sys_lines(engine: &Arc<P2p>, gid: &str) -> Vec<(String, String)> {
        engine
            .group_messages(gid, 500)
            .unwrap()
            .into_iter()
            .filter(|r| r["dir"] == "sys")
            .map(|r| (r["sysKind"].as_str().unwrap().to_string(), r["text"].as_str().unwrap().to_string()))
            .collect()
    }

    fn texts(engine: &Arc<P2p>, gid: &str) -> Vec<(String, u64, String)> {
        chat_rows(engine, gid, 500)
            .into_iter()
            .map(|r| (r["from"].as_str().unwrap().to_string(), r["seq"].as_u64().unwrap(), r["text"].as_str().unwrap().to_string()))
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_fans_out_with_acks_from_all_members_and_members_connect_via_introduction() {
        let t = trio("grp-fan").await;
        let (aid, bid, cid) = (t.a.node_id(), t.b.node_id(), t.c.node_id());
        // State reached both invitees; B and C never paired.
        assert_eq!(kind_of(&t.b, &cid), Some(PeerKind::Introduced));
        assert_eq!(kind_of(&t.c, &bid), Some(PeerKind::Introduced));
        assert!(!peers_json_ids(&t.b).contains(&cid.to_string()));
        assert_eq!(t.b.groups()[0]["members"].as_array().unwrap().len(), 3);

        let r = t.a.group_send(&t.gid, "hello all", None, None).unwrap();
        assert_eq!(r["seq"], 1);
        for (rx, who) in [(&t.b_rx, "b"), (&t.c_rx, "c")] {
            let ev = wait_for(rx, 20, |e| e["kind"] == "group-message");
            assert_eq!((ev["text"].as_str(), ev["seq"].as_u64(), ev["from"].as_str()), (Some("hello all"), Some(1), Some(aid.to_string().as_str())), "{who}");
        }
        // Acks from both members come back to the author.
        let mut pending = vec![bid.to_string(), cid.to_string()];
        while !pending.is_empty() {
            let ev = wait_for(&t.a_rx, 20, |e| e["kind"] == "group-ack" && e["have"] == 1);
            pending.retain(|m| ev["by"] != m.as_str());
        }
        let log = chat_rows(&t.a, &t.gid, 10);
        assert_eq!(log[0]["delivered"].as_array().unwrap().len(), 2);

        // B talks to everyone, including C over the introduced session.
        t.b.group_send(&t.gid, "from b", None, None).unwrap();
        wait_for(&t.a_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "from b");
        wait_for(&t.c_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "from b");
        until(20, "both members acked B's message", || {
            let g = &t.b.inner.lock().unwrap().groups[&t.gid];
            g.sent_cursor.get(&aid.to_string()) == Some(&1) && g.sent_cursor.get(&cid.to_string()) == Some(&1)
        })
        .await;
        let mut at_c = texts(&t.c, &t.gid);
        at_c.sort();
        let mut expect = vec![
            (aid.to_string(), 1, "hello all".to_string()),
            (bid.to_string(), 1, "from b".to_string()),
        ];
        expect.sort();
        assert_eq!(at_c, expect);

        // An introduced member cannot be used for 1:1 chat or become a contact.
        assert!(t.c.send(&bid.to_string(), "psst", None, None).is_err());
        assert!(t.c.messages(&bid.to_string(), 10).is_err());
        assert_eq!(kind_of(&t.c, &bid), Some(PeerKind::Introduced));
        // A raw 1:1 frame over the introduced session is dropped at the other end.
        events(&t.b_rx);
        let tx = t.c.inner.lock().unwrap().peers[&bid].live[0].tx.clone();
        tx.send(Frame::Msg { id: "sneak".into(), ts: 1, text: "sneaky".into(), reply_to: None, reply_text: None }).unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(t.b.inner.lock().unwrap().peers[&cid].msgs.is_empty());
        assert!(events(&t.b_rx).iter().all(|e| e["kind"] != "message"));
        // Group presence is published for it, plain presence is not.
        assert!(t.b.groups()[0]["members"].as_array().unwrap().iter().any(|m| m["id"] == cid.to_string().as_str() && m["online"] == true));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_non_member_cannot_speak_or_connect() {
        let t = trio("grp-nm").await;
        let (aid, bid) = (t.a.node_id(), t.b.node_id());
        let (e, _e_rx) = start("grp-nm-e").await;
        // E is a paired contact of A only.
        pair(&t.a, &t.a_rx, &e).await;
        let eid = e.node_id();
        until(15, "E has a session to A", || e.inner.lock().unwrap().peers.get(&aid).map_or(false, |p| p.online())).await;
        events(&t.a_rx);
        let etx = e.inner.lock().unwrap().peers[&aid].live[0].tx.clone();
        // Even knowing the gid, E can neither post nor impersonate a member.
        etx.send(gmsg(&t.gid, &eid, 1, "sneak in")).unwrap();
        etx.send(gmsg(&t.gid, &bid, 1, "i am b")).unwrap();
        etx.send(sync_from(&t.gid, 1, 0)).unwrap();
        wait_for(&t.a_rx, 10, |ev| ev["kind"] == "error" && ev["message"].as_str().unwrap().contains("forged"));
        assert!(chat_rows(&t.a, &t.gid, 10).is_empty());
        assert!(events(&t.a_rx).iter().all(|ev| ev["kind"] != "group-message"));

        // E can't open a session to B either: B knows E neither as a contact
        // nor as a member, so it takes the pairing path and refuses.
        let b_addrs: Vec<SocketAddr> = t.b.endpoint.node_addr().await.unwrap().direct_addresses.into_iter().collect();
        let mut p = paper("B");
        p.addrs = b_addrs;
        e.inner.lock().unwrap().peers.insert(bid, p);
        events(&t.b_rx);
        e.retry(&bid.to_string()).unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(t.b.inner.lock().unwrap().peers.get(&eid).is_none());
        assert!(events(&t.b_rx).iter().all(|ev| ev["kind"] != "group-message" && ev["kind"] != "pairing"));
        // …and E's group frames never reached B's log.
        assert!(chat_rows(&t.b, &t.gid, 10).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_offline_member_catches_up_in_order_from_each_author() {
        let Trio { a, b, c, a_rx, b_rx, c_rx: _, gid } = trio("grp-off").await;
        let (aid, bid) = (a.node_id(), b.node_id());
        let (cdir, cblobs) = (c.dir.clone(), c.blobs_dir.clone());
        c.close().await;
        drop(c);
        until(20, "A notices C is gone", || a.groups()[0]["members"].as_array().unwrap().iter().any(|m| m["online"] == false)).await;
        for t in ["a1", "a2", "a3"] {
            a.group_send(&gid, t, None, None).unwrap();
        }
        b.group_send(&gid, "b1", None, None).unwrap();
        b.group_send(&gid, "b2", None, None).unwrap();
        wait_for(&b_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "a3");
        wait_for(&a_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "b2");

        let (tx, c_rx2) = std_mpsc::channel();
        let c2 = P2p::start(cdir, cblobs, Sink::Test(tx)).await.unwrap();
        // B's roster address for C is stale after the restart; C dials out. Give
        // it B's real address the way a beacon would.
        let b_addrs: Vec<SocketAddr> = b.endpoint.node_addr().await.unwrap().direct_addresses.into_iter().collect();
        c2.inner.lock().unwrap().peers.get_mut(&bid).unwrap().addrs = b_addrs;
        c2.trigger_group_dials();
        until(60, "C catches up", || texts(&c2, &gid).len() == 5).await;
        let at_c = texts(&c2, &gid);
        let by = |who: &NodeId| at_c.iter().filter(|(f, _, _)| *f == who.to_string()).map(|(_, s, t)| (*s, t.clone())).collect::<Vec<_>>();
        assert_eq!(by(&aid), vec![(1, "a1".into()), (2, "a2".into()), (3, "a3".into())], "each author's messages in order, once");
        assert_eq!(by(&bid), vec![(1, "b1".into()), (2, "b2".into())]);
        // The authors' cursors for C advance once C has stored everything.
        until(20, "acks reach the authors", || {
            let cid = c2.node_id().to_string();
            a.inner.lock().unwrap().groups[&gid].sent_cursor.get(&cid) == Some(&3)
                && b.inner.lock().unwrap().groups[&gid].sent_cursor.get(&cid) == Some(&2)
        })
        .await;
        drop(c_rx2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_lost_session_replays_from_the_cursor_without_duplicates() {
        let (a, a_rx) = start("grp-lost-a").await;
        let (b, b_rx) = start("grp-lost-b").await;
        pair(&a, &a_rx, &b).await;
        let bid = b.node_id();
        let g = a.group_create("Duo", &ids(&[bid])).unwrap();
        let gid = g["gid"].as_str().unwrap().to_string();
        until(20, "B has the group", || !b.groups().is_empty()).await;
        a.group_send(&gid, "one", None, None).unwrap();
        wait_for(&b_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "one");
        wait_for(&a_rx, 20, |e| e["kind"] == "group-ack" && e["have"] == 1);

        // The session dies (both ends drop their handles).
        a.inner.lock().unwrap().peers.get_mut(&bid).unwrap().live.clear();
        b.inner.lock().unwrap().peers.get_mut(&a.node_id()).unwrap().live.clear();
        until(20, "both ends offline", || {
            !a.inner.lock().unwrap().peers[&bid].online() && !b.inner.lock().unwrap().peers[&a.node_id()].online()
        })
        .await;
        for t in ["two", "three"] {
            assert_eq!(a.group_send(&gid, t, None, None).unwrap()["queued"], true);
        }
        // Reconnect: B asks from its own `have`, gets 2 and 3 exactly once.
        a.retry(&bid.to_string()).unwrap();
        wait_for(&b_rx, 30, |e| e["kind"] == "group-message" && e["text"] == "three");
        tokio::time::sleep(Duration::from_secs(1)).await;
        let seqs: Vec<u64> = texts(&b, &gid).into_iter().map(|(_, s, _)| s).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        until(10, "A's cursor catches up", || a.inner.lock().unwrap().groups[&gid].sent_cursor.get(&bid.to_string()) == Some(&3)).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_remove_member_over_the_wire_cuts_it_off() {
        let t = trio("grp-rmw").await;
        let (bid, cid) = (t.b.node_id(), t.c.node_id());
        t.a.group_remove(&t.gid, &cid.to_string()).unwrap();
        let ev = wait_for(&t.c_rx, 20, |e| e["kind"] == "group-removed");
        assert_eq!((ev["gid"].as_str(), ev["reason"].as_str()), (Some(t.gid.as_str()), Some("removed")));
        assert_eq!(t.c.groups()[0]["removed"], true);
        until(20, "B drops C from its roster", || t.b.groups()[0]["members"].as_array().unwrap().len() == 2).await;
        until(20, "the B-C link is cut", || kind_of(&t.b, &cid).is_none() && kind_of(&t.c, &bid).is_none()).await;

        t.a.group_send(&t.gid, "after removal", None, None).unwrap();
        wait_for(&t.b_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "after removal");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(texts(&t.c, &t.gid).is_empty(), "the removed member gets nothing");
        assert!(t.c.group_send(&t.gid, "can I?", None, None).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_member_leave_updates_the_roster_via_the_creator() {
        let t = trio("grp-leave").await;
        t.b.group_leave(&t.gid).unwrap();
        until(20, "creator re-signs without B", || t.a.groups()[0]["members"].as_array().unwrap().len() == 2).await;
        assert_eq!(t.a.groups()[0]["epoch"], 2);
        until(20, "C sees the new roster", || t.c.groups()[0]["members"].as_array().unwrap().len() == 2).await;
        until(20, "B's leave request is settled", || !t.b.inner.lock().unwrap().groups[&t.gid].pending_leave).await;
        assert_eq!(t.b.groups()[0]["removed"], true);
        assert!(t.b.group_send(&t.gid, "gone", None, None).is_err());
        // The rest of the group still talks.
        t.a.group_send(&t.gid, "still here", None, None).unwrap();
        wait_for(&t.c_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "still here");
        assert!(texts(&t.b, &t.gid).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_creator_disband_makes_the_group_read_only_everywhere() {
        let t = trio("grp-disband").await;
        t.a.group_send(&t.gid, "last words", None, None).unwrap();
        wait_for(&t.c_rx, 20, |e| e["kind"] == "group-message");
        t.a.group_disband(&t.gid).unwrap();
        for rx in [&t.b_rx, &t.c_rx] {
            let ev = wait_for(rx, 20, |e| e["kind"] == "group-removed");
            assert_eq!(ev["reason"], "closed");
        }
        for e in [&t.a, &t.b, &t.c] {
            assert!(e.group_send(&t.gid, "nope", None, None).is_err());
            assert_eq!(e.groups()[0]["removed"], true);
            // History stays readable.
            assert_eq!(chat_rows(&e, &t.gid, 10).len(), 1);
        }
    }

    fn kinds(lines: &[(String, String)]) -> Vec<&str> {
        lines.iter().map(|(k, _)| k.as_str()).collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_system_lines_follow_every_roster_change() {
        let t = trio("grp-sys").await;
        let cid = t.c.node_id().to_string();
        // Creation: the creator says so, invitees see who added them.
        assert_eq!(kinds(&sys_lines(&t.a, &t.gid)), ["created"]);
        assert_eq!(sys_lines(&t.a, &t.gid)[0].1, "You created the group");
        for e in [&t.b, &t.c] {
            until(20, "the invitee logged the invitation", || !sys_lines(e, &t.gid).is_empty()).await;
            let l = sys_lines(e, &t.gid);
            assert_eq!(kinds(&l), ["joined"]);
            assert!(l[0].1.ends_with(" added you"), "{}", l[0].1);
        }

        // Rename: "You renamed" for the creator, "<A> renamed" for the others.
        t.a.group_rename(&t.gid, "Renamed").unwrap();
        assert_eq!(sys_lines(&t.a, &t.gid).last().unwrap().1, "You renamed the group to \u{201c}Renamed\u{201d}");
        for e in [&t.b, &t.c] {
            until(20, "rename noted", || kinds(&sys_lines(e, &t.gid)).contains(&"renamed")).await;
            let l = sys_lines(e, &t.gid);
            let line = &l.iter().find(|(k, _)| k == "renamed").unwrap().1;
            assert!(line.ends_with(" renamed the group to \u{201c}Renamed\u{201d}"), "{line}");
        }

        // Removal: three different views of the same epoch.
        t.a.group_remove(&t.gid, &cid).unwrap();
        assert!(sys_lines(&t.a, &t.gid).last().unwrap().1.starts_with("You removed "));
        until(20, "C learns it was removed", || kinds(&sys_lines(&t.c, &t.gid)).contains(&"removed-me")).await;
        assert_eq!(sys_lines(&t.c, &t.gid).last().unwrap().1, "You were removed from the group");
        until(20, "B notes C is gone", || kinds(&sys_lines(&t.b, &t.gid)).contains(&"gone")).await;
        assert!(sys_lines(&t.b, &t.gid).last().unwrap().1.ends_with(" is no longer in the group"));

        // Re-adding is a roster change like any other.
        // (C is removed on its side, so only the creator's and B's view are checked.)
        t.b.group_leave(&t.gid).unwrap();
        until(20, "creator notes the leave", || kinds(&sys_lines(&t.a, &t.gid)).contains(&"left")).await;
        assert!(sys_lines(&t.a, &t.gid).last().unwrap().1.ends_with(" left the group"));
        until(20, "B's leave request is settled", || !t.b.inner.lock().unwrap().groups[&t.gid].pending_leave).await;
        // B said "You left" and the creator's confirming state added nothing.
        let b_lines = sys_lines(&t.b, &t.gid);
        assert_eq!(b_lines.last().unwrap(), &("left-me".to_string(), "You left the group".to_string()));
        assert!(!kinds(&b_lines).contains(&"removed-me"), "{b_lines:?}");

        // Lines never reach the counters: next_seq/have are untouched.
        let a_rec_seq = t.a.inner.lock().unwrap().groups[&t.gid].next_seq;
        assert_eq!(a_rec_seq, 1);
        assert!(chat_rows(&t.a, &t.gid, 50).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_system_lines_survive_a_restart_and_say_disbanded() {
        let t = trio("grp-sysre").await;
        t.a.group_disband(&t.gid).unwrap();
        for e in [&t.b, &t.c] {
            until(20, "disband noted", || kinds(&sys_lines(e, &t.gid)).contains(&"disbanded")).await;
            assert!(sys_lines(e, &t.gid).last().unwrap().1.ends_with(" disbanded the group"));
        }
        assert_eq!(sys_lines(&t.a, &t.gid).last().unwrap().1, "You disbanded the group");
        let before = sys_lines(&t.b, &t.gid);
        let (dir, blobs) = (t.b.dir.clone(), t.b.blobs_dir.clone());
        let Trio { b, .. } = t;
        b.close().await;
        drop(b);
        let (tx, _rx) = std_mpsc::channel();
        let b2 = P2p::start(dir, blobs, Sink::Test(tx)).await.unwrap();
        let gid = b2.groups()[0]["gid"].as_str().unwrap().to_string();
        assert_eq!(sys_lines(&b2, &gid), before, "the notes are part of the persisted history");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_delete_forgets_a_finished_group_only() {
        let t = trio("grp-del").await;
        t.a.group_send(&t.gid, "hello", None, None).unwrap();
        wait_for(&t.b_rx, 20, |e| e["kind"] == "group-message");
        let log_file = |e: &Arc<P2p>| e.dir.join(format!("messages-g-{}.jsonl", t.gid));
        assert!(log_file(&t.b).exists());
        // An active group can't be deleted: leave/disband comes first.
        assert!(t.b.group_delete(&t.gid).is_err());
        assert!(t.a.group_delete(&t.gid).is_err());
        assert!(t.b.group_delete("00000000000000000000000000000000").is_err());

        t.a.group_disband(&t.gid).unwrap();
        wait_for(&t.b_rx, 20, |e| e["kind"] == "group-removed");
        t.b.group_delete(&t.gid).unwrap();
        wait_for(&t.b_rx, 20, |e| e["kind"] == "group-deleted" && e["gid"] == t.gid.as_str());
        assert!(t.b.groups().is_empty());
        assert!(!log_file(&t.b).exists());
        assert!(t.b.inner.lock().unwrap().groups.is_empty());
        assert!(load_groups(&t.b.dir).is_empty(), "gone from groups.json too");
        // The others keep theirs until they delete.
        assert_eq!(t.c.groups().len(), 1);
        assert!(log_file(&t.c).exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_delete_after_a_leave_waits_until_the_creator_knows() {
        let t = trio("grp-delwait").await;
        let bid = t.b.node_id().to_string();
        // B left but the creator hasn't heard yet (simulated): delete keeps
        // an invisible stub so the leave can still be delivered.
        {
            let mut inner = t.b.inner.lock().unwrap();
            let rec = inner.groups.get_mut(&t.gid).unwrap();
            rec.removed = true;
            rec.pending_leave = true;
        }
        t.b.group_delete(&t.gid).unwrap();
        assert!(t.b.groups().is_empty(), "invisible");
        {
            let inner = t.b.inner.lock().unwrap();
            let rec = &inner.groups[&t.gid];
            assert!(rec.hidden && rec.pending_leave);
        }
        assert!(!t.b.dir.join(format!("messages-g-{}.jsonl", t.gid)).exists());
        assert!(load_groups(&t.b.dir)[&t.gid].hidden, "the stub is persisted");
        // The creator's confirming state arrives: the stub disappears.
        t.a.group_remove(&t.gid, &bid).unwrap();
        until(20, "stub purged once the creator answered", || t.b.inner.lock().unwrap().groups.is_empty()).await;
        assert!(!t.b.dir.join(format!("messages-g-{}.jsonl", t.gid)).exists(), "no note resurrected the log");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn remove_peer_of_creator_deletes_their_groups() {
        let t = trio("grp-unpair").await;
        let (aid, bid) = (t.a.node_id().to_string(), t.b.node_id().to_string());
        t.a.group_send(&t.gid, "hi", None, None).unwrap();
        wait_for(&t.b_rx, 20, |e| e["kind"] == "group-message");
        // B's view: A created one group and B can't talk to A without pairing.
        let imp = t.b.peer_group_impact(&aid).unwrap();
        assert_eq!(imp["created"].as_array().unwrap().len(), 1);
        assert_eq!(imp["created"][0]["gid"], t.gid.as_str());
        assert!(imp["member"].as_array().unwrap().is_empty());
        t.b.remove_peer(&aid).unwrap();
        assert!(t.b.groups().is_empty(), "the creator's group is deleted with the contact");
        assert!(!t.b.dir.join(format!("messages-g-{}.jsonl", t.gid)).exists());
        assert!(t.b.inner.lock().unwrap().groups.is_empty());
        // C, still paired with A, is untouched.
        assert_eq!(t.c.groups().len(), 1);

        // A's view of B: merely a member of A's group -> stays, introduced.
        let imp = t.a.peer_group_impact(&bid).unwrap();
        assert!(imp["created"].as_array().unwrap().is_empty());
        assert_eq!(imp["member"][0]["gid"], t.gid.as_str());
        t.a.remove_peer(&bid).unwrap();
        assert_eq!(t.a.groups().len(), 1);
        assert_eq!(kind_of(&t.a, &t.b.node_id()), Some(PeerKind::Introduced));
        assert!(!peers_json_ids(&t.a).contains(&bid), "no longer a saved contact");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_roster_reaches_a_returning_member_from_a_non_creator() {
        let Trio { a, b, c, b_rx: _, c_rx: _, a_rx: _, gid } = trio("grp-relayw").await;
        let bid = b.node_id();
        let (cdir, cblobs) = (c.dir.clone(), c.blobs_dir.clone());
        c.close().await;
        drop(c);
        a.group_rename(&gid, "Renamed").unwrap();
        until(20, "B applies the rename", || b.groups()[0]["name"] == "Renamed").await;
        // The creator disappears: C can only learn the roster from B.
        a.close().await;
        drop(a);
        let (tx, _rx) = std_mpsc::channel();
        let c2 = P2p::start(cdir, cblobs, Sink::Test(tx)).await.unwrap();
        let b_addrs: Vec<SocketAddr> = b.endpoint.node_addr().await.unwrap().direct_addresses.into_iter().collect();
        c2.inner.lock().unwrap().peers.get_mut(&bid).unwrap().addrs = b_addrs;
        c2.trigger_group_dials();
        until(60, "C gets epoch 2 from B", || c2.groups()[0]["name"] == "Renamed").await;
        assert_eq!(c2.groups()[0]["epoch"], 2);
    }

    #[test]
    fn transfer_ids_with_path_parts_are_rejected() {
        assert!(is_safe_transfer_id(&random_id()));
        assert!(is_safe_transfer_id("abc-123_DEF"));
        assert!(!is_safe_transfer_id(""));
        assert!(!is_safe_transfer_id(".."));
        assert!(!is_safe_transfer_id("../x"));
        assert!(!is_safe_transfer_id("..\\x"));
        assert!(!is_safe_transfer_id("a/b"));
        assert!(!is_safe_transfer_id("C:x"));
        assert!(!is_safe_transfer_id(&"a".repeat(65)));
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
        let id = bob.send(&alice_id, "approved", None, None).unwrap();
        let got = wait_for(&alice_rx, 15, |e| {
            e["kind"] == "message" && e["text"] == "approved"
        });
        assert_eq!(got["text"], "approved");
        wait_for(&bob_rx, 15, |e| e["kind"] == "ack" && e["id"] == id["id"]);

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
            let dir_b_blobs = std::env::temp_dir()
                .join(format!("velta-p2p-test-bob2-blobs-{}", std::process::id()));
            let p2p = P2p::start(dir_b, dir_b_blobs, Sink::Test(tx)).await.unwrap();
            (p2p, rx)
        };
        assert_eq!(bob2.node_id().to_string(), bob_id);
        assert_eq!(bob2.status()["peers"].as_array().unwrap().len(), 1);

        let id = bob2.send(&alice_id, "while you were away", None, None).unwrap();

        // First dial attempt after a cold start can stall (iroh address
        // probing), the 10s maintenance retry then delivers — allow 60s.
        let got = wait_for(&alice_rx, 60, |e| e["kind"] == "message");
        assert_eq!(got["text"], "while you were away");
        wait_for(&bob2_rx, 60, |e| e["kind"] == "ack" && e["id"] == id["id"]);
    }

    // -- group media ------------------------------------------------------------

    fn write_blob(engine: &Arc<P2p>, name: &str, len: usize) -> (String, Vec<u8>) {
        let data: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        let path = engine.dir.join(name);
        std::fs::write(&path, &data).unwrap();
        (path.to_string_lossy().to_string(), data)
    }

    fn gfile_begin(gid: &str, id: &str, size: u64, name: &str) -> Frame {
        Frame::GroupFileBegin {
            gid: gid.into(), id: id.into(), ts: now_ms(), name: name.into(), size,
            mime: String::new(), caption: "cap".into(),
        }
    }
    fn gfile_chunk(gid: &str, id: &str, bytes: &[u8]) -> Frame {
        Frame::GroupFileChunk { gid: gid.into(), id: id.into(), data: BASE64.encode(bytes) }
    }
    fn gfile_end(gid: &str, id: &str) -> Frame {
        Frame::GroupFileEnd { gid: gid.into(), id: id.into() }
    }

    fn live_credits(engine: &Arc<P2p>, node: &NodeId) -> Arc<tokio::sync::Semaphore> {
        engine.inner.lock().unwrap().peers[node].live.iter().find(|h| !h.tx.is_closed()).unwrap().credits.clone()
    }

    fn group_file_frames(frames: &[Frame]) -> (usize, usize, usize) {
        let mut c = (0, 0, 0);
        for f in frames {
            match f {
                Frame::GroupFileBegin { .. } => c.0 += 1,
                Frame::GroupFileChunk { .. } => c.1 += 1,
                Frame::GroupFileEnd { .. } => c.2 += 1,
                _ => {}
            }
        }
        c
    }

    #[test]
    fn group_file_frames_wire_names_and_gating() {
        let f = gfile_begin("g", "i", 1, "a.txt");
        let j = serde_json::to_value(&f).unwrap();
        assert_eq!(j["type"], "groupfilebegin");
        assert!(f.is_group() && f.is_group_file());
        assert!(gfile_chunk("g", "i", b"x").is_group_file());
        assert!(gfile_end("g", "i").is_group_file());
        assert!(!Frame::Ping.is_group_file());
        assert!(!Frame::FileEnd { id: "x".into() }.is_group_file(), "1:1 media stays separate");
        // An old peer's parse of it is "unknown", never a hard failure.
        let back: Frame = serde_json::from_str(r#"{"type":"groupfilesomething","x":1}"#).unwrap();
        assert!(matches!(back, Frame::Unknown));
    }

    /// The sender is bounded: with a session that does not drain, only
    /// GROUP_FILE_CREDITS chunks are ever queued, however big the file is.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_stream_is_paced_by_session_credits() {
        let (a, _rx, gid, [(b, _tb, mut rb), (d, _td, mut rd)]) = unit_author("gfile-pace").await;
        let (path, data) = write_blob(&a, "big.bin", 1_000_000); // 11 chunks
        let r = a.group_send_file(&gid, &path, "big.bin", "hi").unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(r["members"].as_array().unwrap().len(), 2);
        assert!(r["members"].as_array().unwrap().iter().all(|m| m["state"] == "sending"));
        until(10, "the first credits are used", || rb.len() >= 1 + GROUP_FILE_CREDITS).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let first = drain(&mut rb);
        assert_eq!(
            group_file_frames(&first),
            (1, GROUP_FILE_CREDITS, 0),
            "Begin + exactly the credits worth of chunks, nothing more while the writer is idle"
        );
        // The writer drains: each chunk written hands its credit back.
        let credits = live_credits(&a, &b);
        let mut all = first;
        let mut wrote = GROUP_FILE_CREDITS;
        let mut guard = 0;
        while !all.iter().any(|f| matches!(f, Frame::GroupFileEnd { .. })) {
            guard += 1;
            assert!(guard < 400, "stream stalled");
            for _ in 0..wrote {
                a.group_file_wrote(b, &id, (GROUP_FILE_CHUNK) as u64);
                credits.add_permits(1);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            let more = drain(&mut rb);
            wrote = group_file_frames(&more).1;
            all.extend(more);
        }
        let (begins, chunks, ends) = group_file_frames(&all);
        assert_eq!((begins, chunks, ends), (1, 11, 1));
        let mut got = Vec::new();
        for f in &all {
            if let Frame::GroupFileChunk { data, .. } = f {
                assert!(data.len() <= 4 * GROUP_FILE_CHUNK / 3 + 4);
                got.extend(BASE64.decode(data.as_bytes()).unwrap());
            }
        }
        assert_eq!(got, data);
        a.group_file_done(b, &id);
        let st = a.group_xfers.lock().unwrap();
        assert_eq!(st[&id].members[&b.to_string()].state, "done");
        assert_eq!(st[&id].members[&d.to_string()].state, "sending", "the other member's stream is independent");
        drop(st);
        let _ = drain(&mut rd);
        // Own file rows never use the message sequence.
        assert_eq!(a.group_send(&gid, "text after", None, None).unwrap()["seq"], 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_skips_offline_and_v1_members_and_needs_somebody_online() {
        let (a, _rx) = start("gfile-offline").await;
        let b = add_fake_peer(&a, PeerKind::Paired, 2);
        let v = add_fake_peer(&a, PeerKind::Paired, 2); // downgraded to a v1 session below
        let o = add_fake_peer(&a, PeerKind::Paired, 2);
        let gid = a.group_create("Mix", &ids(&[b, v, o])).unwrap()["gid"].as_str().unwrap().to_string();
        let (path, _) = write_blob(&a, "x.txt", 1000);
        let err = a.group_send_file(&gid, &path, "x.txt", "").unwrap_err().to_string();
        assert!(err.contains("online"), "nobody online: {err}");
        assert!(read_log(&a.dir, &gid).iter().all(|r| r.file.is_none()), "nothing logged on failure");
        assert!(!a.blobs_dir.join(format!("g-{gid}")).read_dir().map_or(false, |mut d| d.next().is_some()), "copy cleaned up");

        let (_tb, mut rb) = attach_live(&a, b, 2);
        let (_tv, mut rv) = attach_live(&a, v, 1);
        let r = a.group_send_file(&gid, &path, "x.txt", "").unwrap();
        let state = |id: &NodeId| r["members"].as_array().unwrap().iter().find(|m| m["id"] == id.to_string().as_str()).unwrap()["state"].clone();
        assert_eq!(state(&b), "sending");
        assert_eq!(state(&v), "offline", "a v1 session is never sent a group frame");
        assert_eq!(state(&o), "offline");
        until(5, "frames for b", || rb.len() >= 3).await;
        assert_eq!(group_file_frames(&drain(&mut rb)), (1, 1, 1));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(drain(&mut rv).is_empty(), "nothing at all reached the v1 peer");
        // Too big: refused before anything is copied.
        let big = a.dir.join("huge.bin");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_GROUP_FILE_BYTES + 1).unwrap();
        let err = a.group_send_file(&gid, &big.to_string_lossy(), "huge.bin", "").unwrap_err().to_string();
        assert!(err.contains("32 MB"), "{err}");
        // Exactly the cap is fine.
        f.set_len(MAX_GROUP_FILE_BYTES).unwrap();
        assert!(a.group_send_file(&gid, &big.to_string_lossy(), "huge.bin", "").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_failure_is_per_member_and_retry_resends_to_that_member_only() {
        let (a, ev, gid, [(b, _tb, rb), (d, _td, rd)]) = unit_author("gfile-retry").await;
        let (path, data) = write_blob(&a, "r.bin", 500_000);
        let id = a.group_send_file(&gid, &path, "r.bin", "").unwrap()["id"].as_str().unwrap().to_string();
        until(10, "streams started", || rb.len() >= 3 && rd.len() >= 3).await;
        // B's session dies: its credits close and the sweep fails its send.
        let (handle, credits) = {
            let inner = a.inner.lock().unwrap();
            let h = inner.peers[&b].live.first().unwrap();
            (h.id, h.credits.clone())
        };
        credits.close();
        a.group_files_failed(b, handle);
        let st = |n: &NodeId| a.group_xfers.lock().unwrap()[&id].members[&n.to_string()].state;
        until(5, "b failed", || st(&b) == "failed").await;
        assert_eq!(st(&d), "sending", "D's stream is not affected");
        let failed = wait_for(&ev, 5, |e| e["kind"] == "group-file-progress" && e["member"] == b.to_string().as_str() && e["state"] == "failed");
        assert_eq!(failed["id"], id.as_str());
        // Retry needs a live session: the old one is dead, so first it fails...
        drop(rb);
        assert!(a.group_file_retry(&gid, &id, &b.to_string()).unwrap_err().to_string().contains("offline"));
        // ...a fresh session works, and only B gets frames.
        let (_tb2, mut rb2) = attach_live(&a, b, 2);
        let before_d = rd.len();
        a.group_file_retry(&gid, &id, &b.to_string()).unwrap();
        assert_eq!(st(&b), "sending");
        until(10, "retry frames", || rb2.len() >= 1 + GROUP_FILE_CREDITS).await;
        let frames = drain(&mut rb2);
        assert!(matches!(frames[0], Frame::GroupFileBegin { size, .. } if size == data.len() as u64), "restarts from byte zero");
        assert_eq!(rd.len(), before_d, "D was not sent anything new");
        // Retrying one that is already sending/done is refused; so is a stranger.
        assert!(a.group_file_retry(&gid, &id, &b.to_string()).is_err());
        assert!(a.group_file_retry(&gid, &id, &add_fake_peer(&a, PeerKind::Paired, 2).to_string()).is_err());
        assert!(a.group_file_retry(&gid, "nope", &d.to_string()).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_retry_after_restart_uses_the_log() {
        let (a, _ev, gid, [(b, _tb, mut rb), _]) = unit_author("gfile-restart").await;
        let (path, _) = write_blob(&a, "z.bin", 2000);
        let id = a.group_send_file(&gid, &path, "z.bin", "cap").unwrap()["id"].as_str().unwrap().to_string();
        until(5, "sent", || rb.len() >= 3).await;
        let _ = drain(&mut rb);
        a.group_xfers.lock().unwrap().clear(); // as after a restart
        // Not in memory, so the row has no member state, but it is in the log with its file.
        let rows = a.group_messages(&gid, 50).unwrap();
        let row = rows.iter().find(|r| r["id"] == id.as_str()).unwrap();
        assert_eq!((row["seq"].as_u64(), row["dir"].as_str()), (Some(0), Some("out")));
        assert_eq!(row["file"]["name"], "z.bin");
        assert_eq!(row["text"], "cap");
        assert!(row["fileMembers"].is_null());
        a.group_file_retry(&gid, &id, &b.to_string()).unwrap();
        until(5, "resent", || rb.len() >= 3).await;
        assert_eq!(group_file_frames(&drain(&mut rb)), (1, 1, 1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_receive_applies_the_1to1_hygiene_with_the_group_cap() {
        let (me, ev, cr, _d, gid) = unit_member("gfile-rx").await;
        let sender = cr.node_id();
        let (tx, mut rx) = attach_live(&me, sender, 2);
        let rx_len = || me.rx_files.lock().unwrap().len();
        let blobs = me.blobs_dir.join(format!("g-{gid}"));

        // Over the 32 MiB cap, unsafe ids, wrong group: nothing starts.
        me.handle_frame(sender, gfile_begin(&gid, "big", MAX_GROUP_FILE_BYTES + 1, "a.bin"), &tx);
        me.handle_frame(sender, gfile_begin(&gid, "../evil", 4, "a.bin"), &tx);
        me.handle_frame(sender, gfile_begin(&gid, "a/b", 4, "a.bin"), &tx);
        me.handle_frame(sender, gfile_begin(&"00".repeat(16), "ok1", 4, "a.bin"), &tx);
        assert_eq!(rx_len(), 0);
        assert!(events(&ev).iter().any(|e| e["kind"] == "error"));

        // A normal one, with a hostile name: lands under g-<gid>, sanitized.
        me.handle_frame(sender, gfile_begin(&gid, "f1", 10, "../../etc/pass wd.txt"), &tx);
        assert_eq!(rx_len(), 1);
        // A 1:1 chunk/end with the same id can neither feed nor finish it.
        me.handle_frame(sender, Frame::FileChunk { id: "f1".into(), data: BASE64.encode(b"0123456789") }, &tx);
        me.handle_frame(sender, Frame::FileEnd { id: "f1".into() }, &tx);
        assert_eq!(rx_len(), 1);
        assert_eq!(me.rx_files.lock().unwrap().values().next().unwrap().got, 0);
        me.handle_frame(sender, gfile_chunk(&gid, "f1", b"01234"), &tx);
        me.handle_frame(sender, gfile_chunk(&gid, "f1", b"56789"), &tx);
        me.handle_frame(sender, gfile_end(&gid, "f1"), &tx);
        assert_eq!(rx_len(), 0);
        let ev1 = wait_for(&ev, 5, |e| e["kind"] == "group-message" && e["id"] == "f1");
        assert_eq!((ev1["seq"].as_u64(), ev1["text"].as_str()), (Some(0), Some("cap")));
        let path = std::path::PathBuf::from(ev1["file"]["path"].as_str().unwrap());
        assert!(path.starts_with(&blobs), "under the group's blob dir: {path:?}");
        assert_eq!(std::fs::read(&path).unwrap(), b"0123456789");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains('/') && !name.contains(".."), "{name}");
        assert_eq!(ev1["from"], sender.to_string().as_str());
        // It is in the log (seq 0, dir in, with the file) and does not move the seq counters.
        let row = read_log(&me.dir, &gid).into_iter().find(|r| r.id == "f1").unwrap();
        assert_eq!((row.seq, row.dir.as_str(), row.from.as_str()), (0, "in", sender.to_string().as_str()));
        assert_eq!(row.file.unwrap().size, 10);
        assert_eq!(me.inner.lock().unwrap().groups[&gid].have.get(&sender.to_string()).copied().unwrap_or(0), 0);
        assert!(drain(&mut rx).is_empty(), "files are not acked or answered");
        // A retry of a finished transfer is ignored (no duplicate row).
        me.handle_frame(sender, gfile_begin(&gid, "f1", 10, "a.txt"), &tx);
        assert_eq!(rx_len(), 0);

        // Per-peer limit (3) and a short or oversized transfer.
        for i in 0..(MAX_INBOUND_FILES_PER_PEER + 2) {
            me.handle_frame(sender, gfile_begin(&gid, &format!("c{i}"), 4, "c.bin"), &tx);
        }
        assert_eq!(rx_len(), MAX_INBOUND_FILES_PER_PEER);
        me.handle_frame(sender, gfile_chunk(&gid, "c0", b"toolong"), &tx); // > declared size
        me.handle_frame(sender, gfile_chunk(&gid, "c1", b"ab"), &tx);
        me.handle_frame(sender, gfile_end(&gid, "c1"), &tx); // 2 of 4 bytes
        assert_eq!(rx_len(), 1, "c0 dropped for overflow, c1 discarded for a short end");
        assert!(std::fs::read_dir(&blobs).unwrap().all(|e| {
            let n = e.unwrap().file_name().to_string_lossy().to_string();
            !n.contains("-c0") && !n.contains("-c1")
        }), "partials of the dropped transfers are deleted");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_receive_refuses_strangers_v1_sessions_and_finished_groups() {
        let (me, _ev, cr, _d, gid) = unit_member("gfile-rx-gate").await;
        let sender = cr.node_id();
        let (tx1, _r1) = attach_live(&me, sender, 1);
        me.handle_frame(sender, gfile_begin(&gid, "v1", 4, "a"), &tx1);
        assert!(me.rx_files.lock().unwrap().is_empty(), "v1 session: ignored");
        let (tx, _r) = attach_live(&me, sender, 2);
        // A device that is no member of the group.
        let stranger = add_fake_peer(&me, PeerKind::Paired, 2);
        let (ts, _rs) = attach_live(&me, stranger, 2);
        me.handle_frame(stranger, gfile_begin(&gid, "s1", 4, "a"), &ts);
        assert!(me.rx_files.lock().unwrap().is_empty(), "not a member: ignored");
        // The global limit across senders.
        me.handle_frame(sender, gfile_begin(&gid, "m1", 4, "a"), &tx);
        assert_eq!(me.rx_files.lock().unwrap().len(), 1);
        // The group ends: a running transfer is dropped by the next frame.
        cr.group_disband(&gid).unwrap();
        me.apply_group_state(cr.group_state(&gid).unwrap(), sender).unwrap();
        me.handle_frame(sender, gfile_chunk(&gid, "m1", b"ab"), &tx);
        assert!(me.rx_files.lock().unwrap().is_empty(), "removed group: transfer dropped");
        me.handle_frame(sender, gfile_begin(&gid, "m2", 4, "a"), &tx);
        assert!(me.rx_files.lock().unwrap().is_empty(), "removed group: new transfer refused");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_inbound_is_dropped_when_the_sender_goes_offline_and_with_the_group() {
        let (me, _ev, cr, _d, gid) = unit_member("gfile-rx-drop").await;
        let sender = cr.node_id();
        let (tx, rx) = attach_live(&me, sender, 2);
        me.handle_frame(sender, gfile_begin(&gid, "p1", 100, "a.bin"), &tx);
        me.handle_frame(sender, gfile_chunk(&gid, "p1", b"abc"), &tx);
        let partial = me.rx_files.lock().unwrap().values().next().unwrap().partial.clone();
        assert!(partial.exists());
        let hid = me.inner.lock().unwrap().peers[&sender].live[0].id;
        drop(rx);
        me.remove_live(sender, hid);
        assert!(me.rx_files.lock().unwrap().is_empty());
        assert!(!partial.exists(), "partial removed with the session");
        // A 1:1 transfer is not touched by the sweep.
        me.rx_files.lock().unwrap().insert(
            (sender, "one".into()),
            FileRx { partial: me.dir.join("p"), dir: me.dir.clone(), name: "x".into(), size: 1, mime: String::new(), caption: String::new(), ts: 0, got: 0, gid: None },
        );
        me.drop_group_inbound(|n, _| *n == sender);
        assert_eq!(me.rx_files.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_delete_removes_the_group_blobs() {
        let (a, _ev, gid, [(_b, _tb, _rb), _]) = unit_author("gfile-del").await;
        let (path, _) = write_blob(&a, "d.bin", 1000);
        a.group_send_file(&gid, &path, "d.bin", "").unwrap();
        let dir = a.blobs_dir.join(format!("g-{gid}"));
        assert!(dir.read_dir().unwrap().next().is_some());
        a.group_disband(&gid).unwrap();
        a.group_delete(&gid).unwrap();
        assert!(!dir.exists(), "stored copies go with the chat");
        assert!(a.group_xfers.lock().unwrap().is_empty());
    }

    /// Two real engines + a third: a 300 KB file reaches both online members
    /// intact, each gets its own row, the sender sees both as delivered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn group_file_travels_between_real_engines() {
        let t = trio("gfile-wire").await;
        let aid = t.a.node_id().to_string();
        let (path, data) = write_blob(&t.a, "wire.bin", 300_000);
        let r = t.a.group_send_file(&t.gid, &path, "wire.bin", "look").unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        for rx in [&t.b_rx, &t.c_rx] {
            let ev = wait_for(rx, 30, |e| e["kind"] == "group-message" && e["id"] == id.as_str());
            assert_eq!((ev["from"].as_str(), ev["text"].as_str(), ev["seq"].as_u64()), (Some(aid.as_str()), Some("look"), Some(0)));
            assert_eq!(std::fs::read(ev["file"]["path"].as_str().unwrap()).unwrap(), data);
        }
        until(20, "both members delivered", || {
            let x = t.a.group_xfers.lock().unwrap();
            x[&id].members.values().all(|m| m.state == "done")
        })
        .await;
        let rows = t.a.group_messages(&t.gid, 50).unwrap();
        let row = rows.iter().find(|r| r["id"] == id.as_str()).unwrap();
        assert_eq!(row["fileMembers"].as_array().unwrap().len(), 2);
        assert!(row["fileMembers"].as_array().unwrap().iter().all(|m| m["state"] == "done" && m["got"] == 300_000));
        // The receivers keep it across their log.
        let brow = t.b.group_messages(&t.gid, 50).unwrap();
        assert!(brow.iter().any(|r| r["id"] == id.as_str() && r["file"]["size"] == 300_000 && r["dir"] == "in"));
        // Text still flows with its own sequence next to files.
        t.a.group_send(&t.gid, "after", None, None).unwrap();
        let ev = wait_for(&t.b_rx, 20, |e| e["kind"] == "group-message" && e["text"] == "after");
        assert_eq!(ev["seq"], 1);
    }
}
