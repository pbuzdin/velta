//! #472 spike: group audio rooms over iroh-live (Media over QUIC on iroh).
//!
//! `bench`: N peers in this process join one room. Each publishes a 48 kHz
//! mono Opus track (iroh-live's test tone, or the mic with `--features
//! devices`), subscribes to every other member's audio and counts decoded
//! frames. Prints frames/s per stream, first-audio latency, process CPU and
//! bytes on the wire. LAN only: relays disabled (no n0), addresses shared in
//! memory.
//!
//! `room [TICKET]`: one peer on this machine; creates a room (prints the
//! ticket) or joins one. The ticket is what Velta would post, end-to-end
//! encrypted, into the group chat (signaling over the group). Peers on the
//! same LAN find each other over mDNS; no relay.
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use iroh::{Endpoint, EndpointId, RelayMode, Watcher, address_lookup::memory::MemoryLookup, endpoint::Builder, protocol::Router};
use iroh_live::{
    EndpointConfig, Mdns, Node,
    layout::LiveLayout,
    media::{AudioMode, AudioSource, LocalBroadcast, PlayerConfig, SubscriptionExt, audio},
    rooms::{Room, RoomTicket, Rooms, RoomsLayout},
};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// N peers in one process, full mesh, measure.
    Bench {
        #[arg(long, default_value_t = 4)]
        peers: usize,
        #[arg(long, default_value_t = 15)]
        secs: u64,
        /// Opus bitrate, bits per second.
        #[arg(long, default_value_t = 32_000)]
        bitrate: u64,
    },
    /// One peer: create a room (no ticket) or join one.
    Room {
        ticket: Option<String>,
        #[arg(long, default_value = "velta")]
        name: String,
    },
}

struct Peer {
    endpoint: Endpoint,
    room: Room,
    _broadcast: LocalBroadcast,
    _router: Router,
    _rooms: Rooms,
}

async fn bind(lookup: Option<MemoryLookup>, mdns: Mdns) -> Result<Endpoint> {
    let mut b = EndpointConfig::default().with_mdns(mdns).apply(Builder::empty()).await;
    // Velta policy: no n0 relays. LAN / direct only for this spike.
    b = b.relay_mode(RelayMode::Disabled);
    if let Some(l) = lookup {
        b = b.address_lookup(l);
    }
    Ok(b.bind().await?)
}

fn source() -> Result<AudioSource> {
    #[cfg(feature = "devices")]
    if std::env::var_os("SPIKE_MIC").is_some() {
        return Ok(AudioSource::default_microphone()?);
    }
    Ok(AudioSource::test_pattern(audio::Layout::Mono)?)
}

async fn start_peer(endpoint: Endpoint, ticket: &RoomTicket, name: &str, bitrate: u64) -> Result<Peer> {
    let node = Node::new(endpoint.clone(), iroh_live::layout::config((LiveLayout::default(), RoomsLayout)));
    let rooms = Rooms::new(&node);
    let router = rooms.mount(node.mount(Router::builder(endpoint.clone()))).spawn();
    let room = rooms.join(ticket, Some(name.to_string())).await?;
    let broadcast: LocalBroadcast = room.publish("mic")?;
    let mut enc = audio::encode::Config::new(48_000, audio::Layout::Mono);
    enc.bitrate = Some(iroh_live::media::Rate::from_bps(bitrate));
    broadcast.set_audio(source()?, enc)?;
    Ok(Peer { endpoint, room, _broadcast: broadcast, _router: router, _rooms: rooms })
}

/// Subscribes to every other member's audio as it appears; counts frames.
fn listen(peer: &Peer, frames: Arc<AtomicU64>, first: Arc<std::sync::Mutex<Vec<Duration>>>, t0: Instant) {
    let room = peer.room.clone();
    tokio::spawn(async move {
        let mut seen: BTreeSet<EndpointId> = BTreeSet::new();
        let mut state = room.state();
        loop {
            let members: Vec<(EndpointId, String)> = state
                .get()
                .members
                .iter()
                .filter_map(|(id, m)| m.broadcasts.iter().next().map(|n| (*id, n.clone())))
                .collect();
            for (id, name) in members {
                if !seen.insert(id) {
                    continue;
                }
                let (room, frames, first) = (room.clone(), frames.clone(), first.clone());
                tokio::spawn(async move {
                    let Ok(sub) = room.subscribe(id, &name).await else { return };
                    let mut cfg = PlayerConfig::default();
                    // Decode only: the spike counts frames; `devices` builds play them.
                    cfg.audio = AudioMode::Decode;
                    let Ok(player) = sub.remote_broadcast().play(cfg) else { return };
                    let mut af = player.audio_frames();
                    let mut got_first = false;
                    while af.next().await.is_some() {
                        if !got_first {
                            got_first = true;
                            first.lock().unwrap().push(t0.elapsed());
                        }
                        frames.fetch_add(1, Ordering::Relaxed);
                    }
                    drop(player);
                });
            }
            if state.updated().await.is_err() {
                break;
            }
        }
    });
}

fn cpu_ticks() -> u64 {
    // utime + stime of this process, in clock ticks (Linux).
    std::fs::read_to_string("/proc/self/stat")
        .ok()
        .and_then(|s| {
            let rest = s.rsplit_once(')')?.1.split_whitespace().collect::<Vec<_>>();
            Some(rest.get(11)?.parse::<u64>().ok()? + rest.get(12)?.parse::<u64>().ok()?)
        })
        .unwrap_or(0)
}

fn wire_bytes(peers: &[Peer]) -> (u64, u64) {
    let (mut tx, mut rx) = (0, 0);
    for p in peers {
        let m = p.endpoint.metrics();
        tx += m.socket.send_ipv4.get() + m.socket.send_ipv6.get();
        rx += m.socket.recv_data_ipv4.get() + m.socket.recv_data_ipv6.get();
    }
    (tx, rx)
}

async fn bench(n: usize, secs: u64, bitrate: u64) -> Result<()> {
    let lookup = MemoryLookup::new();
    let mut eps = Vec::new();
    for _ in 0..n {
        eps.push(bind(Some(lookup.clone()), Mdns::Off).await?);
    }
    for ep in &eps {
        lookup.add_endpoint_info(ep.addr());
    }
    let t0 = Instant::now();
    let cpu0 = cpu_ticks();
    let frames = Arc::new(AtomicU64::new(0));
    let first = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut peers: Vec<Peer> = Vec::new();
    let mut ticket = RoomTicket::generate();
    for (i, ep) in eps.into_iter().enumerate() {
        let p = start_peer(ep, &ticket, &format!("peer{i}"), bitrate).await?;
        ticket = p.room.ticket(); // join through the newest member
        listen(&p, frames.clone(), first.clone(), t0);
        peers.push(p);
    }
    let expected_streams = n * (n - 1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while first.lock().unwrap().len() < expected_streams && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let connected = first.lock().unwrap().len();
    let f0 = frames.load(Ordering::Relaxed);
    let (tx0, rx0) = wire_bytes(&peers);
    let c0 = cpu_ticks();
    let m0 = Instant::now();
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let dt = m0.elapsed().as_secs_f64();
    let f1 = frames.load(Ordering::Relaxed);
    let (tx1, rx1) = wire_bytes(&peers);
    let c1 = cpu_ticks();
    let hz = 100.0; // USER_HZ
    let connected_end = first.lock().unwrap().len();
    let mut lat = first.lock().unwrap().clone();
    lat.sort();
    println!("peers={n} streams={connected}/{expected_streams} (end of window {connected_end}) bitrate={bitrate}bps window={dt:.1}s");
    println!(
        "first audio: min={:?} max={:?} (from start, incl. joining)",
        lat.first().unwrap_or(&Duration::ZERO),
        lat.last().unwrap_or(&Duration::ZERO)
    );
    // Streams that join mid-window burst their backlog, so only trust this
    // number when the count did not change.
    let fps = (f1 - f0) as f64 / dt / connected_end.max(1) as f64;
    let note = if connected == connected_end { "" } else { " (streams joined mid-window: approximate)" };
    println!("decoded frames/s per stream: {fps:.1} (20 ms Opus frames: 50/s expected){note}");
    println!(
        "wire per peer: up {:.1} kbit/s, down {:.1} kbit/s",
        (tx1 - tx0) as f64 * 8.0 / dt / 1000.0 / n as f64,
        (rx1 - rx0) as f64 * 8.0 / dt / 1000.0 / n as f64
    );
    println!(
        "CPU (whole process, all {n} peers encode+decode): {:.1}% of one core; per peer {:.1}%",
        (c1 - c0) as f64 / hz / dt * 100.0,
        (c1 - c0) as f64 / hz / dt * 100.0 / n as f64
    );
    println!("setup CPU: {:.2}s", (c0 - cpu0) as f64 / hz);
    for p in &peers {
        p.room.leave().await;
    }
    Ok(())
}

async fn room(ticket: Option<String>, name: String) -> Result<()> {
    let ep = bind(None, Mdns::Announce).await?;
    let ticket = match ticket {
        Some(t) => t.parse().context("bad room ticket")?,
        None => RoomTicket::generate(),
    };
    let p = start_peer(ep, &ticket, &name, 32_000).await?;
    println!("room ticket (post this in the group chat): {}", p.room.ticket());
    let frames = Arc::new(AtomicU64::new(0));
    let first = Arc::new(std::sync::Mutex::new(Vec::new()));
    listen(&p, frames.clone(), first.clone(), Instant::now());
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let members = p.room.state().get().members.len();
        println!("members={members} streams={} frames={}", first.lock().unwrap().len(), frames.load(Ordering::Relaxed));
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    match Cli::parse().cmd {
        Cmd::Bench { peers, secs, bitrate } => bench(peers, secs, bitrate).await,
        Cmd::Room { ticket, name } => room(ticket, name).await,
    }
}
