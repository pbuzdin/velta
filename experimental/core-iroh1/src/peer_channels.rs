//! Peer channels for realtime communication in webxdcs.
//!
//! We use Iroh as an ephemeral peer channels provider to create direct communication
//! channels between webxdcs. See [here](https://webxdc.org/docs/spec/joinRealtimeChannel.html) for the webxdc specs.
//!
//! Ephemeral channels should be established lazily, to avoid bootstrapping p2p connectivity
//! when it's not required. Only when a webxdc subscribes to realtime data or when a reatlime message is sent,
//! the p2p machinery should be started.
//!
//! Adding peer channels to webxdc needs upfront negotiation of a topic and sharing of public keys so that
//! nodes can connect to each other. The explicit approach is as follows:
//!
//! 1. We introduce a new [`IrohGossipTopic`](crate::headerdef::HeaderDef::IrohGossipTopic) message header with a random 32-byte TopicId,
//!    securely generated on the initial webxdc sender's device. This message header is encrypted
//!    and sent in the same message as the webxdc application.
//! 2. Whenever `joinRealtimeChannel().setListener()` or `joinRealtimeChannel().send()` is called by the webxdc application,
//!    we start a routine to establish p2p connectivity and join the gossip swarm with Iroh.
//! 3. The first step of this routine is to introduce yourself with a regular message containing the [`IrohNodeAddr`](crate::headerdef::HeaderDef::IrohNodeAddr).
//!    This message contains the users relay-server and public key.
//!    Direct IP address is not included as this information can be persisted by email providers.
//! 4. After the announcement, the sending peer joins the gossip swarm with an empty list of peer IDs (as they don't know anyone yet).
//! 5. Upon receiving an announcement message, other peers store the sender's [NodeAddr] in the database
//!    (scoped per WebXDC app instance/message-id). The other peers can then join the gossip with `joinRealtimeChannel().setListener()`
//!    and `joinRealtimeChannel().send()` just like the other peers.

use anyhow::{Context as _, Result, anyhow, bail};
use data_encoding::BASE32_NOPAD;
use futures_lite::StreamExt;
use iroh::address_lookup::MemoryLookup;
use iroh::endpoint::presets;
use iroh::{
    Endpoint, EndpointAddr as NodeAddr, EndpointId as NodeId, PublicKey, RelayMode, RelayUrl,
    SecretKey,
};
use iroh_gossip::api::{Event, JoinOptions};
use iroh_gossip::net::{GOSSIP_ALPN, Gossip};
use iroh_gossip::proto::TopicId;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::env;
use tokio::sync::{RwLock, oneshot};
use tokio::task::JoinHandle;
use url::Url;

use crate::EventType;
use crate::chat::send_msg;
use crate::config::Config;
use crate::context::Context;
use crate::log::warn;
use crate::message::{Message, MsgId, Viewtype};
use crate::mimeparser::SystemMessage;

/// The length of an ed25519 `PublicKey`, in bytes.
const PUBLIC_KEY_LENGTH: usize = 32;
const PUBLIC_KEY_STUB: &[u8] = b"static_string";

#[cfg(feature = "dc-compat")]
pub(crate) mod legacy;

/// iroh 1.x peers are stored separately from the upstream (iroh 0.35) `iroh_gossip_peers`
/// table, which keeps holding the topic stub and Delta Chat (legacy) peers.
/// Created lazily to avoid a DB migration in this experimental build.
const CREATE_V1_TABLE: &str = "CREATE TABLE IF NOT EXISTS iroh1_gossip_peers (msg_id INTEGER NOT NULL, topic BLOB NOT NULL, public_key BLOB NOT NULL, relay_server TEXT, PRIMARY KEY(topic, public_key)) STRICT";

async fn ensure_v1_table(ctx: &Context) -> Result<()> {
    ctx.sql.execute(CREATE_V1_TABLE, ()).await?;
    Ok(())
}

/// Store Iroh peer channels for the context.
#[derive(Debug)]
pub struct Iroh {
    /// Iroh router  needed for Iroh peer channels.
    pub(crate) router: iroh::protocol::Router,

    /// In-memory address book (replaces `Endpoint::add_node_addr` from iroh 0.35).
    pub(crate) address_lookup: MemoryLookup,

    /// [Gossip] needed for Iroh peer channels.
    pub(crate) gossip: Gossip,

    /// Sequence numbers for gossip channels.
    pub(crate) sequence_numbers: Mutex<HashMap<TopicId, i32>>,

    /// Topics for which an advertisement has already been sent.
    pub(crate) iroh_channels: RwLock<HashMap<TopicId, ChannelState>>,

    /// Currently used Iroh public key.
    ///
    /// This is attached to every message to work around `iroh_gossip` deduplication.
    pub(crate) public_key: PublicKey,

    /// iroh 0.35 stack for talking to unmodified Delta Chat clients.
    #[cfg(feature = "dc-compat")]
    pub(crate) legacy: Option<legacy::LegacyIroh>,

    /// Test-only: do not send `Iroh-Endpoint-Addr`, i.e. behave like a Delta Chat peer
    /// that can only be reached over the legacy stack.
    #[cfg(test)]
    pub(crate) skip_endpoint_addr: std::sync::atomic::AtomicBool,
}

/// Shared "joined" notifier: fired by whichever swarm sees the first neighbor.
pub(crate) type JoinTx = std::sync::Arc<Mutex<Option<oneshot::Sender<()>>>>;

impl Iroh {
    /// Notify the endpoint that the network has changed.
    pub(crate) async fn network_change(&self) {
        #[cfg(feature = "dc-compat")]
        if let Some(legacy) = &self.legacy {
            legacy.network_change().await;
        }
        self.router.endpoint().network_change().await
    }

    /// Closes the QUIC endpoint.
    pub(crate) async fn close(self) -> Result<()> {
        #[cfg(feature = "dc-compat")]
        if let Some(legacy) = self.legacy {
            legacy.close().await.ok();
        }
        self.router.shutdown().await.context("Closing iroh failed")
    }

    /// JSON for the `Iroh-Node-Addr` header.
    ///
    /// In dual-stack mode this is the iroh 0.35 address so that Delta Chat understands it,
    /// otherwise the iroh 1.x address.
    pub(crate) async fn node_addr_header(&self) -> Result<String> {
        #[cfg(feature = "dc-compat")]
        if let Some(legacy) = &self.legacy {
            return legacy.node_addr_json().await;
        }
        Ok(serde_json::to_string(&self.get_node_addr().await?)?)
    }

    /// Join a topic and create the subscriber loop for it.
    ///
    /// If there is no gossip, create it.
    ///
    /// The returned future resolves when the swarm becomes operational.
    async fn join_and_subscribe_gossip(
        &self,
        ctx: &Context,
        msg_id: MsgId,
    ) -> Result<Option<oneshot::Receiver<()>>> {
        let topic = get_iroh_topic_for_msg(ctx, msg_id)
            .await?
            .with_context(|| format!("Message {msg_id} has no gossip topic"))?;

        // Take exclusive lock to make sure
        // no other thread can create a second gossip subscription
        // after we check that it does not exist and before we create a new one.
        // Otherwise we would receive every message twice or more times.
        let mut iroh_channels = self.iroh_channels.write().await;

        if iroh_channels.contains_key(&topic) {
            return Ok(None);
        }

        let peers = get_iroh_gossip_peers(ctx, msg_id).await?;
        let node_ids = peers.iter().map(|p| p.id).collect::<Vec<_>>();

        info!(
            ctx,
            "IROH_REALTIME: Joining gossip {topic} with peers: {:?}.", node_ids,
        );

        // Inform iroh of potentially new node addresses
        for node_addr in &peers {
            if !node_addr.is_empty() {
                self.address_lookup.add_endpoint_info(node_addr.clone());
            }
        }

        let (join_tx, join_rx) = oneshot::channel();

        let (gossip_sender, gossip_receiver) = self
            .gossip
            .subscribe_with_opts(topic, JoinOptions::with_bootstrap(node_ids))
            .await?
            .split();

        let seen = Seen::default();
        let join_tx: JoinTx = std::sync::Arc::new(Mutex::new(Some(join_tx)));

        #[cfg(feature = "dc-compat")]
        let (legacy_sender, legacy_loop) = match &self.legacy {
            Some(legacy) => {
                let (tx, rx) = legacy.subscribe(ctx, msg_id, *topic.as_bytes()).await?;
                let ctx2 = ctx.clone();
                let seen2 = seen.clone();
                let fwd = gossip_sender.clone();
                let join_tx2 = join_tx.clone();
                let topic_bytes = *topic.as_bytes();
                let handle = tokio::spawn(async move {
                    if let Err(e) = legacy::legacy_subscribe_loop(
                        &ctx2,
                        rx,
                        topic_bytes,
                        msg_id,
                        seen2,
                        fwd,
                        join_tx2,
                    )
                    .await
                    {
                        warn!(ctx2, "legacy subscribe_loop failed: {e}")
                    }
                });
                (Some(tx), Some(handle))
            }
            None => (None, None),
        };

        let ctx = ctx.clone();
        let bridge = Bridge {
            seen: seen.clone(),
            #[cfg(feature = "dc-compat")]
            legacy_sender: legacy_sender.clone(),
        };
        let subscribe_loop = tokio::spawn(async move {
            if let Err(e) =
                subscribe_loop(&ctx, gossip_receiver, topic, msg_id, join_tx, bridge).await
            {
                warn!(ctx, "subscribe_loop failed: {e}")
            }
        });

        iroh_channels.insert(
            topic,
            ChannelState {
                subscribe_loop,
                sender: gossip_sender,
                seen,
                #[cfg(feature = "dc-compat")]
                legacy_sender,
                #[cfg(feature = "dc-compat")]
                legacy_loop,
            },
        );

        Ok(Some(join_rx))
    }

    /// Add gossip peer to realtime channel if it is already active.
    pub async fn maybe_add_gossip_peer(&self, topic: TopicId, peer: NodeAddr) -> Result<()> {
        if let Some(state) = self.iroh_channels.read().await.get(&topic) {
            self.address_lookup.add_endpoint_info(peer.clone());
            state.sender.join_peers(vec![peer.id]).await?;
        }
        Ok(())
    }

    /// Add a Delta Chat (iroh 0.35) peer to the realtime channel if it is already active.
    #[cfg(feature = "dc-compat")]
    pub async fn maybe_add_legacy_peer(
        &self,
        topic: TopicId,
        peer: iroh035::NodeAddr,
    ) -> Result<()> {
        if let (Some(legacy), Some(state)) =
            (&self.legacy, self.iroh_channels.read().await.get(&topic))
            && let Some(sender) = &state.legacy_sender
        {
            legacy.add_peer(sender, peer).await?;
        }
        Ok(())
    }

    /// Send realtime data to the gossip swarm.
    pub async fn send_webxdc_realtime_data(
        &self,
        ctx: &Context,
        msg_id: MsgId,
        mut data: Vec<u8>,
    ) -> Result<()> {
        let topic = get_iroh_topic_for_msg(ctx, msg_id)
            .await?
            .with_context(|| format!("Message {msg_id} has no gossip topic"))?;
        self.join_and_subscribe_gossip(ctx, msg_id).await?;

        let seq_num = self.get_and_incr(&topic);

        let mut iroh_channels = self.iroh_channels.write().await;
        let state = iroh_channels
            .get_mut(&topic)
            .context("Just created state does not exist")?;
        data.extend(seq_num.to_le_bytes());
        data.extend(self.public_key.as_bytes());

        let data: bytes::Bytes = data.into();
        state.seen.lock().insert(&data);
        #[cfg(feature = "dc-compat")]
        if let Some(legacy_sender) = &state.legacy_sender
            && let Err(err) = legacy_sender.broadcast(data.clone()).await
        {
            warn!(ctx, "IROH_REALTIME: legacy broadcast failed: {err:#}");
        }
        state.sender.broadcast(data).await?;

        if env::var("REALTIME_DEBUG").is_ok() {
            info!(ctx, "Sent realtime data");
        }

        Ok(())
    }

    fn get_and_incr(&self, topic: &TopicId) -> i32 {
        let mut sequence_numbers = self.sequence_numbers.lock();
        let entry = sequence_numbers.entry(*topic).or_default();
        *entry = entry.wrapping_add(1);
        *entry
    }

    /// Get the iroh [NodeAddr] without direct IP addresses.
    ///
    /// The address is guaranteed to have home relay URL set
    /// as it is the only way to reach the node
    /// without global discovery mechanisms.
    pub(crate) async fn get_node_addr(&self) -> Result<NodeAddr> {
        let endpoint = self.router.endpoint();
        // Make sure we have a home relay before advertising.
        tokio::time::timeout(std::time::Duration::from_secs(10), endpoint.online())
            .await
            .ok();
        let addr = endpoint.addr();
        let addr = NodeAddr::from_parts(addr.id, addr.addrs.into_iter().filter(|a| a.is_relay()));
        debug_assert!(addr.relay_urls().next().is_some());
        Ok(addr)
    }

    /// Leave the realtime channel for a given topic.
    pub(crate) async fn leave_realtime(&self, topic: TopicId) -> Result<()> {
        if let Some(channel) = self.iroh_channels.write().await.remove(&topic) {
            // Dropping the last GossipTopic results in quitting the topic.
            // It is split into GossipReceiver and GossipSender.
            // GossipSender (`channel.sender`) is dropped automatically.

            // Subscribe loop owns GossipReceiver.
            // Aborting it and waiting for it to be dropped
            // drops the receiver.
            channel.subscribe_loop.abort();
            let _ = channel.subscribe_loop.await;
            #[cfg(feature = "dc-compat")]
            if let Some(legacy_loop) = channel.legacy_loop {
                legacy_loop.abort();
                let _ = legacy_loop.await;
            }
        }
        Ok(())
    }
}

/// Single gossip channel state.
#[derive(Debug)]
pub(crate) struct ChannelState {
    /// The subscribe loop handle.
    subscribe_loop: JoinHandle<()>,

    sender: iroh_gossip::api::GossipSender,

    /// Deduplication across the two swarms.
    seen: Seen,

    #[cfg(feature = "dc-compat")]
    legacy_sender: Option<iroh_gossip035::net::GossipSender>,

    #[cfg(feature = "dc-compat")]
    legacy_loop: Option<JoinHandle<()>>,
}

#[cfg(feature = "dc-compat")]
type Seen = legacy::SharedSeen;

/// Without the compat stack there is a single swarm, iroh-gossip already deduplicates.
#[cfg(not(feature = "dc-compat"))]
#[derive(Debug, Clone, Default)]
struct Seen(());

#[cfg(not(feature = "dc-compat"))]
impl Seen {
    fn lock(&self) -> &Self {
        self
    }
    fn insert(&self, _content: &[u8]) -> bool {
        true
    }
}

/// What the iroh 1.x subscribe loop needs for bridging.
struct Bridge {
    seen: Seen,
    #[cfg(feature = "dc-compat")]
    legacy_sender: Option<iroh_gossip035::net::GossipSender>,
}

impl Context {
    /// Create iroh endpoint and gossip.
    async fn init_peer_channels(&self) -> Result<Iroh> {
        info!(self, "Initializing peer channels.");
        let secret_key = SecretKey::generate();
        let public_key = secret_key.public();
        ensure_v1_table(self).await?;
        #[cfg(feature = "dc-compat")]
        let secret_key_bytes = secret_key.to_bytes();

        let chatmail_relay = self
            .metadata
            .read()
            .await
            .values()
            .next()
            .and_then(|conf| conf.iroh_relay.clone());
        #[cfg(not(feature = "dc-compat"))]
        let _ = &chatmail_relay;

        let relay_mode = if let Some(relay_url) = self
            .metadata
            .read()
            .await
            .values()
            .next()
            .and_then(|conf| conf.iroh_relay.clone())
        {
            RelayMode::Custom(RelayUrl::from(relay_url).into())
        } else {
            // FIXME: this should be RelayMode::Disabled instead.
            // Currently using default relays because otherwise Rust tests fail.
            RelayMode::Default
        };

        let address_lookup = MemoryLookup::new();
        let endpoint = Box::pin(
            Endpoint::builder(presets::Minimal)
                .address_lookup(address_lookup.clone())
                .secret_key(secret_key.clone())
                .alpns(vec![GOSSIP_ALPN.to_vec()])
                .relay_mode(relay_mode)
                .bind(),
        )
        .await?;

        // create gossip
        // Allow messages up to 128 KB in size.
        // We set the limit to 128 KiB to account for internal overhead,
        // but only guarantee 128 KB of payload to WebXDC developers.

        let gossip = Gossip::builder()
            .max_message_size(128 * 1024)
            .spawn(endpoint.clone());

        // NB: chatmail servers currently run an iroh 0.35 relay
        // (`/shared/vendor/deltachat/irohrelay`), which iroh 1.x cannot use.
        // The legacy stack uses it; the 1.x stack uses the URL as well, which only
        // works once the server also runs an iroh-relay 1.x.
        #[cfg(feature = "dc-compat")]
        let legacy = match legacy::LegacyIroh::spawn(secret_key_bytes, chatmail_relay).await {
            Ok(l) => Some(l),
            Err(err) => {
                warn!(self, "Failed to start legacy iroh 0.35 stack: {err:#}.");
                None
            }
        };

        let router = iroh::protocol::Router::builder(endpoint)
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();

        Ok(Iroh {
            router,
            address_lookup,
            gossip,
            sequence_numbers: Mutex::new(HashMap::new()),
            iroh_channels: RwLock::new(HashMap::new()),
            public_key,
            #[cfg(feature = "dc-compat")]
            legacy,
            #[cfg(test)]
            skip_endpoint_addr: Default::default(),
        })
    }

    /// Returns [`None`] if the peer channels has not been initialized.
    pub async fn get_peer_channels(&self) -> Option<tokio::sync::RwLockReadGuard<'_, Iroh>> {
        tokio::sync::RwLockReadGuard::<'_, std::option::Option<Iroh>>::try_map(
            self.iroh.read().await,
            |opt_iroh| opt_iroh.as_ref(),
        )
        .ok()
    }

    /// Get or initialize the iroh peer channel.
    pub async fn get_or_try_init_peer_channel(
        &self,
    ) -> Result<tokio::sync::RwLockReadGuard<'_, Iroh>> {
        if !self.get_config_bool(Config::WebxdcRealtimeEnabled).await? {
            bail!("Attempt to initialize Iroh when realtime is disabled");
        }

        if let Some(lock) = self.get_peer_channels().await {
            return Ok(lock);
        }

        let lock = self.iroh.write().await;
        match tokio::sync::RwLockWriteGuard::<'_, std::option::Option<Iroh>>::try_downgrade_map(
            lock,
            |opt_iroh| opt_iroh.as_ref(),
        ) {
            Ok(lock) => Ok(lock),
            Err(mut lock) => {
                let iroh = self.init_peer_channels().await?;
                *lock = Some(iroh);
                tokio::sync::RwLockWriteGuard::<'_, std::option::Option<Iroh>>::try_downgrade_map(
                    lock,
                    |opt_iroh| opt_iroh.as_ref(),
                )
                .map_err(|_| anyhow!("Downgrade should succeed as we just stored `Some` value"))
            }
        }
    }

    pub(crate) async fn maybe_add_gossip_peer(&self, topic: TopicId, peer: NodeAddr) -> Result<()> {
        if let Some(iroh) = &*self.iroh.read().await {
            info!(
                self,
                "Adding (maybe existing) peer with id {} to {topic}.", peer.id
            );
            iroh.maybe_add_gossip_peer(topic, peer).await?;
        }
        Ok(())
    }
}

/// Cache a peers [NodeId] for one topic.
pub(crate) async fn iroh_add_peer_for_topic(
    ctx: &Context,
    msg_id: MsgId,
    topic: TopicId,
    peer: NodeId,
    relay_server: Option<&str>,
) -> Result<()> {
    ensure_v1_table(ctx).await?;
    ctx.sql
        .execute(
            "INSERT OR REPLACE INTO iroh1_gossip_peers (msg_id, public_key, topic, relay_server) VALUES (?, ?, ?, ?)",
            (msg_id, peer.as_bytes(), topic.as_bytes(), relay_server),
        )
        .await?;
    Ok(())
}

/// Add gossip peer from `Iroh-Node-Addr` header to WebXDC message identified by `instance_id`.
pub async fn add_gossip_peer_from_header(
    context: &Context,
    instance_id: MsgId,
    node_addr: &str,
) -> Result<()> {
    if !context
        .get_config_bool(Config::WebxdcRealtimeEnabled)
        .await?
    {
        return Ok(());
    }

    let node_addr = match serde_json::from_str::<NodeAddr>(node_addr) {
        Ok(addr) => addr,
        Err(err) => {
            #[cfg(feature = "dc-compat")]
            if let Ok(legacy_addr) = legacy::parse_legacy_node_addr(node_addr) {
                return add_legacy_gossip_peer(context, instance_id, legacy_addr).await;
            }
            return Err(err).context("Failed to parse node address");
        }
    };

    info!(
        context,
        "Adding iroh peer with node id {} to the topic of {instance_id}.", node_addr.id
    );

    context.emit_event(EventType::WebxdcRealtimeAdvertisementReceived {
        msg_id: instance_id,
    });

    let Some(topic) = get_iroh_topic_for_msg(context, instance_id).await? else {
        warn!(
            context,
            "Could not add iroh peer because {instance_id} has no topic."
        );
        return Ok(());
    };

    let node_id = node_addr.id;
    let relay_server = node_addr.relay_urls().next().map(|relay| relay.as_str());
    iroh_add_peer_for_topic(context, instance_id, topic, node_id, relay_server).await?;

    context.maybe_add_gossip_peer(topic, node_addr).await?;
    Ok(())
}

/// Stores a Delta Chat (iroh 0.35) peer and joins it if the channel is active.
#[cfg(feature = "dc-compat")]
async fn add_legacy_gossip_peer(
    context: &Context,
    instance_id: MsgId,
    addr: iroh035::NodeAddr,
) -> Result<()> {
    info!(
        context,
        "Adding legacy (iroh 0.35) peer {} to the topic of {instance_id}.", addr.node_id
    );
    context.emit_event(EventType::WebxdcRealtimeAdvertisementReceived {
        msg_id: instance_id,
    });
    let Some(topic) = get_iroh_topic_for_msg(context, instance_id).await? else {
        return Ok(());
    };
    legacy::store_legacy_peer(context, instance_id, *topic.as_bytes(), &addr).await?;
    if let Some(iroh) = &*context.iroh.read().await {
        iroh.maybe_add_legacy_peer(topic, addr).await?;
    }
    Ok(())
}

/// Insert topicId into the database so that we can use it to retrieve the topic.
pub(crate) async fn insert_topic_stub(ctx: &Context, msg_id: MsgId, topic: TopicId) -> Result<()> {
    ctx.sql
        .execute(
            "INSERT OR REPLACE INTO iroh_gossip_peers (msg_id, public_key, topic, relay_server) VALUES (?, ?, ?, ?)",
            (msg_id, PUBLIC_KEY_STUB, topic.as_bytes(), Option::<&str>::None),
        )
        .await?;
    Ok(())
}

/// Get a list of [NodeAddr]s for one webxdc.
async fn get_iroh_gossip_peers(ctx: &Context, msg_id: MsgId) -> Result<Vec<NodeAddr>> {
    ensure_v1_table(ctx).await?;
    ctx.sql
        .query_map(
            "SELECT public_key, relay_server FROM iroh1_gossip_peers WHERE msg_id = ? AND public_key != ?",
            (msg_id, PUBLIC_KEY_STUB),
            |row| {
                let key:  Vec<u8> = row.get(0)?;
                let server: Option<String> = row.get(1)?;
                Ok((key, server))
            },
            |g| {
                g.map(|data| {
                    let (key, server) = data?;
                    let server = server.map(|data| Ok::<_, url::ParseError>(RelayUrl::from(Url::parse(&data)?))).transpose()?;
                    let id = NodeId::from_bytes(&key.try_into()
                    .map_err(|_| anyhow!("Can't convert sql data to [u8; 32]"))?)?;
                    Ok::<_, anyhow::Error>(NodeAddr::from_parts(
                        id, server.map(iroh::TransportAddr::Relay)
                    ))
                })
                .collect::<std::result::Result<Vec<_>, _>>()
            },
        )
        .await
}

/// Get the topic for a given [MsgId].
pub(crate) async fn get_iroh_topic_for_msg(
    ctx: &Context,
    msg_id: MsgId,
) -> Result<Option<TopicId>> {
    if let Some(bytes) = ctx
        .sql
        .query_get_value::<Vec<u8>>(
            "SELECT topic FROM iroh_gossip_peers WHERE msg_id = ? LIMIT 1",
            (msg_id,),
        )
        .await
        .context("Couldn't restore topic from db")?
    {
        let topic_id = TopicId::from_bytes(
            bytes
                .try_into()
                .map_err(|_| anyhow!("Could not convert stored topic ID"))?,
        );
        Ok(Some(topic_id))
    } else {
        Ok(None)
    }
}

/// Send a gossip advertisement to the chat that [MsgId] belongs to.
/// This method should be called from the frontend when `joinRealtimeChannel` is called.
pub async fn send_webxdc_realtime_advertisement(
    ctx: &Context,
    msg_id: MsgId,
) -> Result<Option<oneshot::Receiver<()>>> {
    if !ctx.get_config_bool(Config::WebxdcRealtimeEnabled).await? {
        return Ok(None);
    }

    let iroh = ctx.get_or_try_init_peer_channel().await?;
    let conn = iroh.join_and_subscribe_gossip(ctx, msg_id).await?;

    let webxdc = Message::load_from_db(ctx, msg_id).await?;
    let mut msg = Message::new(Viewtype::Text);
    msg.hidden = true;
    msg.param.set_cmd(SystemMessage::IrohNodeAddr);
    msg.in_reply_to = Some(webxdc.rfc724_mid.clone());
    send_msg(ctx, webxdc.chat_id, &mut msg).await?;
    info!(ctx, "IROH_REALTIME: Sent realtime advertisement");
    Ok(conn)
}

/// Send realtime data to other peers using iroh.
pub async fn send_webxdc_realtime_data(ctx: &Context, msg_id: MsgId, data: Vec<u8>) -> Result<()> {
    if !ctx.get_config_bool(Config::WebxdcRealtimeEnabled).await? {
        return Ok(());
    }

    let iroh = ctx.get_or_try_init_peer_channel().await?;
    iroh.send_webxdc_realtime_data(ctx, msg_id, data).await?;
    Ok(())
}

/// Leave the gossip of the webxdc with given [MsgId].
///
/// NB: When this is called before closing a webxdc app in UIs, it must be guaranteed that
/// `send_webxdc_realtime_*()` functions aren't called for the given `msg_id` anymore until the app
/// is open again.
pub async fn leave_webxdc_realtime(ctx: &Context, msg_id: MsgId) -> Result<()> {
    let Some(iroh) = ctx.get_peer_channels().await else {
        return Ok(());
    };
    let Some(topic) = get_iroh_topic_for_msg(ctx, msg_id).await? else {
        return Ok(());
    };
    iroh.leave_realtime(topic).await?;
    info!(ctx, "IROH_REALTIME: Left gossip for message {msg_id}");

    Ok(())
}

/// Creates a new random gossip topic.
fn create_random_topic() -> TopicId {
    TopicId::from_bytes(rand::random())
}

/// Creates `Iroh-Gossip-Header` with a new random topic
/// and stores the topic for the message.
pub(crate) async fn create_iroh_header(ctx: &Context, msg_id: MsgId) -> Result<String> {
    let topic = create_random_topic();
    insert_topic_stub(ctx, msg_id, topic).await?;
    let topic_string = BASE32_NOPAD.encode(topic.as_bytes()).to_ascii_lowercase();
    Ok(topic_string)
}

/// Converts `Iroh-Gossip-Header` contents to iroh topic ID.
pub(crate) fn iroh_topic_from_str(topic: &str) -> Result<TopicId> {
    let mut topic_raw = [0u8; 32];
    BASE32_NOPAD
        .decode_mut(topic.to_ascii_uppercase().as_bytes(), &mut topic_raw)
        .map_err(|e| e.error)
        .context("Wrong gossip topic header")?;

    let topic = TopicId::from_bytes(topic_raw);
    Ok(topic)
}

#[expect(clippy::arithmetic_side_effects)]
async fn subscribe_loop(
    context: &Context,
    mut stream: iroh_gossip::api::GossipReceiver,
    topic: TopicId,
    msg_id: MsgId,
    join_tx: JoinTx,
    bridge: Bridge,
) -> Result<()> {
    while let Some(event) = stream.try_next().await? {
        match event {
            // iroh-gossip >=0.90 has no `Joined` event; the first `NeighborUp` means joined.
            Event::NeighborUp(node) => {
                if let Some(join_tx) = join_tx.lock().take() {
                    // Try to notify that at least one peer joined,
                    // but ignore the error if receiver is dropped and nobody listens.
                    join_tx.send(()).ok();
                }
                info!(context, "IROH_REALTIME: NeighborUp: {}", node.to_string());
                iroh_add_peer_for_topic(context, msg_id, topic, node, None).await?;
            }
            Event::NeighborDown(_node) => {}
            Event::Received(message) => {
                if !bridge.seen.lock().insert(&message.content) {
                    continue;
                }
                info!(context, "IROH_REALTIME: Received realtime data");
                context.emit_event(EventType::WebxdcRealtimeData {
                    msg_id,
                    data: message
                        .content
                        .get(0..message.content.len() - 4 - PUBLIC_KEY_LENGTH)
                        .context("too few bytes in iroh message")?
                        .into(),
                });
                // Bridge iroh 1.x swarm -> Delta Chat peers.
                #[cfg(feature = "dc-compat")]
                if let Some(legacy_sender) = &bridge.legacy_sender
                    && let Err(err) = legacy_sender.broadcast(message.content).await
                {
                    warn!(
                        context,
                        "IROH_REALTIME: failed to bridge v1->legacy: {err:#}"
                    );
                }
            }
            Event::Lagged => {
                warn!(context, "Gossip lost some messages");
            }
        };
    }
    Ok(())
}

#[cfg(test)]
mod peer_channels_tests;
