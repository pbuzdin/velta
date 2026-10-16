//! EXPERIMENTAL "Delta Chat compatible mode": a second, iroh 0.35 based gossip stack.
//!
//! iroh 0.35 and iroh 1.x are not wire compatible (different relay protocol, QUIC
//! implementation and gossip ALPN `/iroh-gossip/0` vs `/iroh-gossip/1`), so to talk to
//! unmodified Delta Chat clients we run the old stack side by side with the new one.
//!
//! * The same ed25519 secret key is used for both endpoints, so our id is identical
//!   on both stacks (Delta Chat stores peers by public key).
//! * Legacy peers come from the `Iroh-Node-Addr` header (iroh 0.35 `NodeAddr` JSON)
//!   and are stored in the existing `iroh_gossip_peers` table (as upstream does).
//! * Messages are broadcast on both swarms. A message received on one swarm is
//!   forwarded once to the other swarm (deduplicated by the `seq_num || public_key`
//!   suffix that core already appends), so Delta Chat peers and iroh-1-only peers
//!   can see each other through any dual-stack peer.

use std::collections::{HashSet, VecDeque};

use anyhow::{Context as _, Result, anyhow};
use futures_lite::StreamExt;
use iroh035::{Endpoint, NodeAddr, NodeId, RelayMode, RelayUrl, SecretKey};
use iroh_gossip035::net::{Event, GOSSIP_ALPN, Gossip, GossipEvent, GossipReceiver, GossipSender, JoinOptions};
use iroh_gossip035::proto::TopicId;
use parking_lot::Mutex;
use url::Url;

use crate::context::Context;
use crate::log::warn;
use crate::message::MsgId;

use super::PUBLIC_KEY_STUB;

/// iroh 0.35 endpoint + gossip.
#[derive(Debug)]
pub(crate) struct LegacyIroh {
    router: iroh035::protocol::Router,
    pub(crate) gossip: Gossip,
}

/// Per-topic deduplication of realtime messages across the two swarms.
#[derive(Debug, Default)]
pub(crate) struct Seen {
    set: HashSet<Vec<u8>>,
    order: VecDeque<Vec<u8>>,
}

impl Seen {
    const CAP: usize = 4096;
    const SUFFIX: usize = 4 + super::PUBLIC_KEY_LENGTH;

    /// Returns `true` if the message was not seen before.
    pub(crate) fn insert(&mut self, content: &[u8]) -> bool {
        let Some(start) = content.len().checked_sub(Self::SUFFIX) else {
            return false;
        };
        let key = content[start..].to_vec();
        if !self.set.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > Self::CAP
            && let Some(old) = self.order.pop_front()
        {
            self.set.remove(&old);
        }
        true
    }
}

pub(crate) type SharedSeen = std::sync::Arc<Mutex<Seen>>;

impl LegacyIroh {
    /// Spawns the iroh 0.35 endpoint using the same secret key as the iroh 1.x endpoint.
    pub(crate) async fn spawn(secret_key: [u8; 32], relay_url: Option<Url>) -> Result<Self> {
        let relay_mode = match relay_url {
            Some(url) => RelayMode::Custom(RelayUrl::from(url).into()),
            None => RelayMode::Default,
        };
        let endpoint = Box::pin(
            Endpoint::builder()
                .tls_x509() // For compatibility with iroh <0.34.0
                .secret_key(SecretKey::from_bytes(&secret_key))
                .alpns(vec![GOSSIP_ALPN.to_vec()])
                .relay_mode(relay_mode)
                .bind(),
        )
        .await?;
        let gossip = Gossip::builder()
            .max_message_size(128 * 1024)
            .spawn(endpoint.clone())
            .await?;
        let router = iroh035::protocol::Router::builder(endpoint)
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        Ok(Self { router, gossip })
    }

    pub(crate) async fn network_change(&self) {
        self.router.endpoint().network_change().await
    }

    pub(crate) async fn close(self) -> Result<()> {
        self.router.shutdown().await.context("Closing legacy iroh failed")
    }

    /// Legacy `NodeAddr` (relay only) to put into the `Iroh-Node-Addr` header.
    pub(crate) async fn node_addr_json(&self) -> Result<String> {
        let mut addr = self.router.endpoint().node_addr().await?;
        addr.direct_addresses = Default::default();
        Ok(serde_json::to_string(&addr)?)
    }

    /// Joins the legacy swarm for `topic`.
    pub(crate) async fn subscribe(
        &self,
        ctx: &Context,
        msg_id: MsgId,
        topic: [u8; 32],
    ) -> Result<(GossipSender, GossipReceiver)> {
        let peers = get_legacy_peers(ctx, msg_id).await?;
        for p in &peers {
            if !p.is_empty() {
                self.router.endpoint().add_node_addr(p.clone())?;
            }
        }
        let ids = peers.iter().map(|p| p.node_id).collect::<Vec<_>>();
        info!(ctx, "IROH_REALTIME(legacy 0.35): joining with peers {ids:?}.");
        Ok(self
            .gossip
            .subscribe_with_opts(TopicId::from_bytes(topic), JoinOptions::with_bootstrap(ids))
            .split())
    }

    /// Adds a legacy peer to an active topic.
    pub(crate) async fn add_peer(&self, sender: &GossipSender, addr: NodeAddr) -> Result<()> {
        let id = addr.node_id;
        self.router.endpoint().add_node_addr(addr)?;
        sender.join_peers(vec![id]).await?;
        Ok(())
    }
}

/// Parses a legacy iroh 0.35 `NodeAddr` JSON (`Iroh-Node-Addr` header from Delta Chat).
pub(crate) fn parse_legacy_node_addr(s: &str) -> Result<NodeAddr> {
    Ok(serde_json::from_str::<NodeAddr>(s)?)
}

/// Legacy peers of a webxdc instance (from the upstream `iroh_gossip_peers` table).
pub(crate) async fn get_legacy_peers(ctx: &Context, msg_id: MsgId) -> Result<Vec<NodeAddr>> {
    ctx.sql
        .query_map(
            "SELECT public_key, relay_server FROM iroh_gossip_peers WHERE msg_id = ? AND public_key != ?",
            (msg_id, PUBLIC_KEY_STUB),
            |row| {
                let key: Vec<u8> = row.get(0)?;
                let server: Option<String> = row.get(1)?;
                Ok((key, server))
            },
            |g| {
                g.map(|data| {
                    let (key, server) = data?;
                    let server = server
                        .map(|s| Ok::<_, url::ParseError>(RelayUrl::from(Url::parse(&s)?)))
                        .transpose()?;
                    let id = NodeId::from_bytes(
                        &key.try_into()
                            .map_err(|_| anyhow!("Can't convert sql data to [u8; 32]"))?,
                    )?;
                    Ok::<_, anyhow::Error>(NodeAddr::from_parts(id, server, vec![]))
                })
                .collect::<std::result::Result<Vec<_>, _>>()
            },
        )
        .await
}

/// Receives from one swarm, emits each message once and forwards it to the other swarm.
#[expect(clippy::arithmetic_side_effects)]
pub(crate) async fn legacy_subscribe_loop(
    ctx: &Context,
    mut stream: GossipReceiver,
    topic: [u8; 32],
    msg_id: MsgId,
    seen: SharedSeen,
    forward_v1: iroh_gossip::api::GossipSender,
    join_tx: super::JoinTx,
) -> Result<()> {
    while let Some(event) = stream.try_next().await? {
        match event {
            Event::Gossip(GossipEvent::Joined(nodes)) => {
                if let Some(tx) = join_tx.lock().take() {
                    tx.send(()).ok();
                }
                for node in nodes {
                    add_legacy_peer_row(ctx, msg_id, topic, node.as_bytes(), None).await?;
                }
            }
            Event::Gossip(GossipEvent::NeighborUp(node)) => {
                if let Some(tx) = join_tx.lock().take() {
                    tx.send(()).ok();
                }
                info!(ctx, "IROH_REALTIME(legacy 0.35): NeighborUp: {node}");
                add_legacy_peer_row(ctx, msg_id, topic, node.as_bytes(), None).await?;
            }
            Event::Gossip(GossipEvent::NeighborDown(_)) => {}
            Event::Gossip(GossipEvent::Received(message)) => {
                if !seen.lock().insert(&message.content) {
                    continue;
                }
                ctx.emit_event(crate::EventType::WebxdcRealtimeData {
                    msg_id,
                    data: message
                        .content
                        .get(0..message.content.len() - 4 - super::PUBLIC_KEY_LENGTH)
                        .context("too few bytes in iroh message")?
                        .into(),
                });
                // Bridge Delta Chat peers -> iroh 1.x swarm.
                if let Err(err) = forward_v1.broadcast(message.content).await {
                    warn!(ctx, "IROH_REALTIME: failed to bridge legacy->v1: {err:#}");
                }
            }
            Event::Lagged => warn!(ctx, "Legacy gossip lost some messages"),
        }
    }
    Ok(())
}

async fn add_legacy_peer_row(
    ctx: &Context,
    msg_id: MsgId,
    topic: [u8; 32],
    public_key: &[u8; 32],
    relay_server: Option<&str>,
) -> Result<()> {
    ctx.sql
        .execute(
            "INSERT OR REPLACE INTO iroh_gossip_peers (msg_id, public_key, topic, relay_server) VALUES (?, ?, ?, ?)",
            (msg_id, public_key.as_slice(), topic.as_slice(), relay_server),
        )
        .await?;
    Ok(())
}

/// Stores a legacy peer from the `Iroh-Node-Addr` header.
pub(crate) async fn store_legacy_peer(
    ctx: &Context,
    msg_id: MsgId,
    topic: [u8; 32],
    addr: &NodeAddr,
) -> Result<()> {
    let relay = addr.relay_url().map(|r| r.to_string());
    add_legacy_peer_row(ctx, msg_id, topic, addr.node_id.as_bytes(), relay.as_deref()).await
}
