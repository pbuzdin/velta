# iroh second layer — research (core 2.62.0, Velta 1.4.x)

Status: research, 2026-10-06. Companion plan: [`../iroh-layer-plan.md`](../iroh-layer-plan.md).

Question (Pavel): add an **iroh-first second layer** for messaging and calls,
using the iroh that already ships inside chatmail core. It must **not replace**
email/chatmail transport. iroh chats and calls get their own folders and an
**"iroh" chip** next to the avatar.

Sources: the vendored core in `core/` is upstream tag **v2.62.0**
(chatmail/core commit `c41cac76d284f44094341c5d9f4eb3a847e2c34b`, released
2026-09-22). Line numbers refer to this checkout. Upstream state was checked
on 2026-10-06 against chatmail/core `main` at `145147891186` (2026-10-06
16:54 UTC). Anything not checked against source or a dated upstream page is
labelled **(unverified)**.

---

## 0. Summary: the framing, checked

The framing holds in outline. Email stays the reliable store-and-forward path
(offline delivery, multi-device, history, OpenPGP). iroh is a live path
between online peers. Seven corrections:

1. **Core does not offer iroh as a general facility.** It uses iroh for two
   things only: **webxdc realtime channels** (iroh-gossip, scoped to one webxdc
   message) and **backup transfer / second-device setup**. Nothing in core uses
   iroh for chat messages, presence, typing, read state or calls. Velta can reach
   core's iroh endpoint only through 3 webxdc-realtime JSON-RPC methods, 2 events
   and the backup methods. No method returns a node id, the peer list or the
   relay URL. No method sends to a contact.
2. **Velta already ships its own iroh endpoint.** That is Local chat:
   `velta-app/src-tauri/src/p2p.rs`, ~7k lines. It uses the same iroh `0.35`
   crate as core and has a persistent ed25519 identity, authenticated 1:1 QUIC
   sessions, msg/ack/typing frames, chunked files up to 256 MB and groups of up to
   5. Today it is LAN-only (`RelayMode::Disabled`) and has nothing to do with
   core contacts. It is a much better base for the data plane than core's gossip
   channel.
3. **Core's iroh identity is ephemeral and not bound to the Autocrypt key.**
   Core generates a fresh `SecretKey` every time it initializes peer channels and
   drops the endpoint on `stop_io`. The only binding is indirect: the node address
   travels inside an OpenPGP-encrypted, signed chat message.
4. **The gossip channel does not authenticate senders for the app.** The
   `WebxdcRealtimeData` event carries only `msg_id` and `data`, with no sender. Any
   node that knows the topic id and one peer can join, because iroh-gossip has no
   admission control.
5. **Calls are WebRTC with TURN. Signalling rides two email messages.**
   Accepting a call needs the call message to be present in the callee's core.
   iroh can speed up the ring and the answer. Carrying media over iroh is not
   realistic inside a WebView.
6. **Time pressure on iroh 0.35.** n0 shuts down its public 0.35 relays on
   **2026-12-31**. Core falls back to the n0 default relays when the chatmail
   relay publishes no iroh relay. The upgrade to iroh 1.0 is an open upstream PR,
   and chatmail relays still run iroh-relay 0.35.
7. **PWA:** a browser can reach iroh only through a relay over WebSocket. The
   wasm patch series leaves the iroh dependencies in but never exercises them,
   and Velta's own iroh engine is Tauri-only.

**Bottom line:** chat content and calls cannot ride core's iroh cleanly
without core patches. The only route without patches is a helper webxdc per
chat that carries gossip traffic (§6 option A). It works for a prototype, but
it costs one hidden email per join, gives ephemeral identities, no sender
attribution, a 128 KiB message cap, and leaves a visible app card in other
clients. The recommended architecture (plan §3) keeps **core as the system of
record and the authenticated rendezvous**. The **live data plane moves to Velta's
Tauri iroh engine**, with no changes to production `core/`.

---

## 1. What iroh is in core 2.62

### 1.1 Crates

| Crate | Version | Where |
|---|---|---|
| `iroh` | 0.35.0, `default-features = false` | `core/Cargo.toml:70`, lock `core/Cargo.lock:3000` |
| `iroh-gossip` | 0.35.0, `features = ["net"]` | `core/Cargo.toml:69`, lock `core/Cargo.lock:3091` |
| `iroh-relay` (transitive) | 0.35.0 | `core/Cargo.lock:3201` |
| `iroh-quinn` (transitive) | 0.13.0 | `core/Cargo.lock:3147` |

There is no `iroh-net` any more. Core's docs still say "iroh-net based backup
transfer" (`core/src/qr.rs:39,143`), a leftover from before iroh merged
`iroh-net` into `iroh`. Upstream `main` is still on 0.35 (checked 2026-10-06).

Velta's Tauri shell depends on the same `iroh = "0.35"` with the
`discovery-local-network` feature (`velta-app/src-tauri/Cargo.toml:53-54`). Its
lock holds a single `iroh 0.35.0` (`velta-app/src-tauri/Cargo.lock:3525`). On
Android, where core is linked in-process (`Cargo.toml:58-60`), both use one
crate build. On desktop, core runs as the separate `deltachat-rpc-server`
sidecar process (AGENTS.md §9.2), so the shell and core never share an
endpoint.

### 1.2 Webxdc realtime channels (`core/src/peer_channels.rs`)

Design notes at the top of the module (`peer_channels.rs:1-24`):

- **Topic:** a random 32-byte `TopicId` per webxdc instance, created on the
  sender's device (`create_random_topic`, `:514-516`; `create_iroh_header`,
  `:520-525`). It is sent in the `Iroh-Gossip-Topic` header of the message that
  carries the `.xdc` (`mimefactory.rs:2104-2114`). The receiver stores it as a
  stub row (`receive_imf.rs:2271-2280`, `:2481-2486`;
  `insert_topic_stub`, `peer_channels.rs:399-407`).
- **Peer advertisement:** when an app calls `joinRealtimeChannel`, the UI calls
  `send_webxdc_realtime_advertisement` (`:463-482`). Core joins the gossip and
  sends a **hidden** chat message (`msg.hidden = true`) with
  `SystemMessage::IrohNodeAddr`, in reply to the webxdc message (`:474-479`).
  The `Iroh-Node-Addr` header holds a JSON `NodeAddr` with **direct addresses
  stripped**: only the node id and the home relay URL (`get_node_addr`,
  `:192-197`; header `mimefactory.rs:1850-1864`; definition
  `headerdef.rs:151-160`). Reason, from the module docs (`:19-20`): "Direct IP
  address is not included as this information can be persisted by email
  providers."
- **Receiving an advertisement** (`receive_imf.rs:2035-2065` →
  `add_gossip_peer_from_header`, `peer_channels.rs:358-396`): core stores the
  `(msg_id, node id, topic, relay)` row in table `iroh_gossip_peers`
  (`sql/migrations.rs:1622-1638`), emits `WebxdcRealtimeAdvertisementReceived`
  and adds the peer if the channel is active. The advertisement message itself
  is trashed (`receive_imf.rs:1143-1149`), so it never shows in the chat.
- **Data:** `send_webxdc_realtime_data` (`:151-178`, wrapper `:485-493`)
  broadcasts to the topic. Core appends a 4-byte sequence number and the 32-byte
  sender public key to defeat gossip's content dedup (`:66-69`, `:168-169`). The
  subscribe loop strips both and emits `WebxdcRealtimeData { msg_id, data }`
  (`:568-578`). **The sender is not passed on.** iroh-gossip's own
  `Message::delivered_from` is documented as "not the same as the original
  author" (iroh-gossip 0.35.0 `src/net/handles.rs:226-227`).
- **Size:** messages up to 128 KiB (`Gossip::builder().max_message_size(128 * 1024)`,
  `:271-274`).
- **Leave:** `leave_webxdc_realtime` (`:500-511`).
- **Endpoint:** created lazily by `get_or_try_init_peer_channel` (`:299-326`),
  which refuses to start when realtime is disabled (`:302-304`).
  `init_peer_channels` (`:236-287`) does three things:
  - generates a **new random `SecretKey` on every init** (`:238`);
  - uses the **first transport's** IMAP-METADATA iroh relay
    (`RelayMode::Custom`), or else **`RelayMode::Default` (n0 relays)**, with
    the in-code note "FIXME: this should be RelayMode::Disabled instead"
    (`:241-254`);
  - accepts only the gossip ALPN, and uses `.tls_x509()` "for compatibility with
    iroh <0.34.0" (`:256-263`).
- **Lifecycle:** `Context.iroh` (`context.rs:315-316`) is closed in `stop_io`
  (`context.rs:540-555`) and nudged on `maybe_network` (`:563-567`). The next
  start creates a new key, which means **a new node id**.

### 1.3 Backup transfer / second device (`core/src/imex/transfer.rs`)

Provider and getter, each with a separate endpoint and ALPN
`/deltachat/backup` (`transfer.rs:55-56`), **`RelayMode::Disabled`**
(`:99-104`, `:309-322`). Authentication uses the node id plus a token in the
QR code (`:9-27`). JSON-RPC: `provide_backup`, `get_backup_qr`,
`get_backup_qr_svg`, `get_backup` (`deltachat-jsonrpc/src/api.rs:1980-2060`).
Velta uses it for "add second device" (`app/js/app.js:3162-3168`). This path
is unrelated to messaging and only useful as a pattern; Velta's p2p.rs is
already modelled on it.

### 1.4 Relay configuration

- The chatmail relay publishes its iroh relay in IMAP METADATA
  `/shared/vendor/deltachat/irohrelay`. Core reads it in `imap.rs:1243-1275`
  and stores it in `ServerMetadata.iroh_relay` (`imap.rs:124`, `:1319-1330`). The
  same fetch reads the TURN credentials (`/shared/vendor/deltachat/turn`,
  `:1278-1289`).
- On the relay side, chatmail/relay nginx proxies `location /relay` to the
  local iroh-relay, and serves `/ping` and `/generate_204` for probes "by
  iroh-relay 0.35 and by the 1.0 line" (chatmail/relay
  `cmdeploy/src/cmdeploy/nginx/nginx.conf.j2:122-142`, main `672cea6dbe`,
  2026-10-01). The METADATA value comes from `iroh_relay` in the relay config
  (`chatmaild/src/chatmaild/metadata.py:108-132`). Its default value is
  **(unverified)**.
- **JSON-RPC does not expose the relay URL.** No method returns
  `iroh_relay`.
- Some relays have broken iroh relays. `autorelay.rs:32` carries the comment
  `"chat.adminforge.de", // iroh relay 404s`. Upstream PR #8490 (open,
  2026-07-29) probes `/generate_204` to pick a working relay, and names
  chat.adminforge.de and chatmail.woodpeckersnest.space as broken.
- iroh traffic is **never proxied**. `net/proxy.rs:158-159` says
  "all traffic (except for iroh p2p connections)".

### 1.5 Config keys and events

- `webxdc_realtime_enabled` (`Config::WebxdcRealtimeEnabled`, default `"1"`,
  `config.rs:434-436`). It is the only iroh-related config key. There is no
  relay override key.
- Events: `WebxdcRealtimeData { msg_id, data }` and
  `WebxdcRealtimeAdvertisementReceived { msg_id }` (`events/payload.rs:333-347`;
  JSON-RPC `api/types/events.rs:370-385`, mapping `:622-630`). JSON-RPC message
  types expose `SystemMessageType::IrohNodeAddr`
  (`api/types/message.rs:427-458`).

### 1.6 What Velta can call today

JSON-RPC (`core/deltachat-jsonrpc/src/api.rs`):

| Method | Line | Use for an iroh layer |
|---|---|---|
| `send_webxdc_realtime_advertisement(acc, msg)` | 2212-2224 | join and advertise on a webxdc topic (sends a hidden email) |
| `send_webxdc_realtime_data(acc, msg, bytes)` | 2202-2210 | broadcast ≤128 KiB to the topic |
| `leave_webxdc_realtime(acc, msg)` | 2231-2234 | leave |
| `send_webxdc_status_update(acc, msg, json, descr)` | 2190-2199 | encrypted, store-and-forward side channel, see §2.3 |
| `place_outgoing_call` / `accept_incoming_call` / `end_call` / `call_info` / `ice_servers` | 2312-2357 | calls, see §3 |
| `get_message_info_object(acc, msg)` → `rfc724Mid` | 1540-1546; type `api/types/message.rs:680-689` | Message-ID for dedup |
| `send_msg(acc, chat, MessageData)` | 2469 | `MessageData` has **no custom headers** (`api/types/message.rs:616-627`) |

Velta wraps only `sendWebxdcRealtimeData` and `leaveWebxdcRealtime`
(`app/js/rpc-core.js:1064-1069`). It does not wrap the advertisement method,
and its webxdc host does not wire realtime: "Realtime (low-latency) channels
are NOT wired" (`docs/agents/webxdc.md:73`).

How Velta talks to core: `app/js/rpc-core.js` speaks JSON-RPC through
`app/js/transport.js`. On Tauri desktop that goes over the `rpc` command to the
stdio sidecar, on Android to the in-process `deltachat-jsonrpc`. The Android
background poller in Rust (`velta-app/src-tauri/src/bg_events.rs`, lib.rs)
posts the native notifications for `IncomingMsg` (AGENTS.md §9.2). Velta's own
iroh engine is driven by `p2p_*` Tauri commands and `p2p-event` events
(`docs/agents/p2p.md`).

### 1.7 Velta's existing iroh engine (Local chat)

From `docs/agents/p2p.md` and `velta-app/src-tauri/src/p2p.rs`:

- The identity is a persisted ed25519 key, so the node id is long-term.
  ALPNs are `/velta/p2p/2` and `/velta/p2p/1` with per-session negotiation
  (`p2p.rs:54-70`). `MAX_FRAME` is 256 KiB (`:78`), the idle timeout 60 s
  (`:84`).
- Frames (`p2p.rs:102-160`): `Msg`, `Ack`, `FileBegin/Chunk/End`, `Ping`,
  group frames, `Typing { gid?, on }` and `GroupCaps`. `#[serde(other)] Unknown`
  skips frame types it does not know.
- The endpoint uses **`RelayMode::Disabled`** with `discovery_local_network()`
  (`p2p.rs:620-635`), so it works on the LAN only.
- Pairing is a `VELTAP2P1:` QR ticket with a token, or a LAN beacon plus
  approval. Unpaired node ids are rejected.
- Disabled by default. A fresh install must not open sockets (AGENTS.md §5.4
  KEEP).
- UI: `p2p:<peer>` / `p2pg:<gid>` chats are injected by the `local-chat.js`
  Proxy around the core object. They carry a wifi badge instead of the
  open-lock badge (`app/js/components.js:269-275`).

---

## 2. Peer advertisement, keys, security

### 2.1 Identity binding

- **Core:** the iroh node id is **not** derived from or signed by the OpenPGP
  key. It is random per endpoint init (`peer_channels.rs:238`). The only binding
  comes from the channel: the `Iroh-Node-Addr` header sits in the **protected
  inner headers** of an encrypted message. When encrypting, only `Chat-Version`,
  `Chat-Is-Post-Message`, a masked `Subject` and a masked `To` are copied to the
  outer headers, and everything else stays inside the OpenPGP payload
  (`mimefactory.rs:351-380`). An advertisement is therefore exactly as
  authentic as the encrypted chat message that carries it.
- That binding is **transitive and per webxdc instance**. Peers are stored by
  `msg_id` and topic (`peer_channels.rs:341-355`) and lost when the instance is
  deleted. Every new endpoint needs a new advertisement email.
- **Velta Local chat:** the long-term node id is bound to a human by in-person
  QR pairing, not to a core contact.

### 2.2 Gossip encryption and admission

- Every hop is QUIC with TLS 1.3, authenticated by the node keys and forward
  secret. Relays forward encrypted QUIC packets and cannot read content (n0 docs,
  https://docs.iroh.computer/languages/wasm-browser, fetched 2026-10-06). Core
  adds **no payload encryption** on top. Gossip forwards messages through other
  topic members, so **every member of the swarm sees the plaintext** of every
  message. In a 1:1 chat the swarm is both participants plus their own devices.
- **Admission:** iroh-gossip 0.35 accepts any connection on its ALPN
  (`ProtocolHandler::accept` → `handle_connection`, iroh-gossip 0.35.0
  `src/net.rs:157-165`, `:701-735`) and has no membership check. Whoever knows the
  32-byte topic id and a reachable member can join, read and broadcast. The topic
  id itself is secret: it only travels inside encrypted mail to chat members.
- **No sender authenticity** for UI consumers (§1.2). In a group, any member
  can impersonate another inside realtime payloads unless the app signs them, and
  Velta's JS cannot sign with the OpenPGP key because no JSON-RPC exposes that.
- **IP exposure:** the advertisement leaves out direct IPs (§1.2), but once
  peers connect, iroh hole-punching exchanges direct addresses, so each peer
  learns the other's IP. Upstream (#7058, 2025-07-31) notes that an idle
  endpoint keeps pinging its relay. The forum thread "Wider usage of Iroh?"
  (2026-06-06) asks that typing and online indicators over iroh be optional
  "because the IP address is transmitted".

### 2.3 The status-update side channel (relevant for rendezvous)

`send_webxdc_status_update` sends an OpenPGP-encrypted update to all chat
members and to own devices (store-and-forward, so it survives offline). Core
accepts an update **only from SELF or a member of the instance's chat**
(`webxdc.rs:692-700`). The JSON handed to the UI (`StatusUpdateItemAndSerial`,
`webxdc.rs:220-228`, fields `webxdc.rs:183-218`) does **not** include the
sender. In a 1:1 chat an update therefore comes either from the contact or from
one of my own devices. The payload can say which, and only my own trusted
devices could forge "it was the contact". In a group this is not enough to
attribute an update to a member. `StatusUpdateItem.uid` is documented as a
dedup id "if the message is sent over multiple transports"
(`webxdc.rs:208-213`).

### 2.4 Implications for chat content over iroh

| Property | Email path (core) | Core gossip (webxdc realtime) | Velta engine (p2p.rs) |
|---|---|---|---|
| Confidentiality | OpenPGP E2EE | QUIC TLS per hop; plaintext to all swarm members | QUIC TLS end to end (1:1 session) |
| Sender authenticity | OpenPGP signature, key-contact | none at app level | remote node id pinned by the QUIC handshake |
| Binding to a contact | key-contact | via the encrypted advert, per instance, ephemeral | QR pairing today; needs a core-backed link (plan §4) |
| Offline delivery | yes | no | engine-side queue for paired peers only |
| Forward secrecy | no (OpenPGP) **(unverified for 2.62 specifics)** | yes (TLS 1.3) | yes (TLS 1.3) |

---

## 3. Calls

### 3.1 Core 2.62

- A call is a message (`calls.rs:1-4`). `place_outgoing_call(chat, info, video)`
  works only in 1:1 non-self chats (`:195-228`). It sends a `Viewtype::Call`
  message whose `Param::WebrtcRoom` holds the caller's `place_call_info` (the SDP
  offer) and starts a 120 s ring timer (`RINGING_SECONDS`, `:38`).
- On the callee, `handle_call_msg` (`:350-410`) checks `who_can_call_me`
  (`:363-383`, enum `:763-776`, default *Contacts*) and emits
  `IncomingCall { msg_id, chat_id, place_call_info, has_video }`. Stale calls
  become "missed".
- `accept_incoming_call(call_id, accept_call_info)` (`:231-271`) **needs the
  incoming call message in the database** (`load_call_by_id`). It sends a hidden
  `CallAccepted` message with the SDP answer, quoting the call, to the caller and
  to own devices. `end_call` (`:274-321`) sends `CallEnded`.
  `emit_end_call_if_unaccepted` ends unanswered calls after the timer
  (`:317-348`).
- **ICE servers:** TURN from the relay's METADATA (`imap.rs:1278-1289`;
  `create_ice_servers_from_metadata`, `calls.rs:644-660`), or the fallback
  `turn.delta.chat:3478` with public credentials (`calls.rs:719-730`).
  `ice_servers()` resolves hosts to IPs for Desktop (`:742-760`). Since PR #8486
  (merged 2026-08-03) servers are collected from all relays.
- JSON-RPC: `api.rs:2312-2357`. Events: `IncomingCall`, `IncomingCallAccepted`
  (stops ringing on other devices), `OutgoingCallAccepted`, `CallEnded`
  (`api/types/events.rs:437-475`).

### 3.2 Delta Chat clients

Clients embed `deltachat/calls-webapp`, "P2P videocalls via WebRTC", latest
commit `c3ccd96400` from 2026-08-15. The app exposes
`window.calls.{startCall, acceptCall, endCall, getIceServers, getAvatar}`, and
the offer and answer go by email. Its README diagram says ICE candidates are
gathered before the SDP goes out, and that a WebRTC data channel can later swap
more candidates. Open upstream issues: #7334 (SDP stored forever), #8635
(multi-device call events), #8631 (declining desyncs read state), #7309 (call
traffic is not proxied).

### 3.3 Velta

`app/js/calls.js` does audio-only WebRTC in the WebView. Core carries the
signalling with "non-trickle ICE, candidates are gathered before the SDP is
sent" (`calls.js:1-12`, gather timeout 3 s `:14`, `:323`). ICE servers come
from `core.iceServers()` (`calls.js:213`, `rpc-core.js:1043`). The Calls side
view is a **local** call log in localStorage `velta-call-log`
(`app/js/app.js:76`, `recordCallEnded` `:1243-1250`, `renderCallsView`
`:1365-1384`), because "the core stores no call log".

### 3.4 Can iroh carry calls?

- **Signalling: yes.** Over a live iroh session the offer and answer (and
  trickle ICE) can reach the peer in one RTT instead of an SMTP→IMAP-IDLE round
  trip per message. Core state must still be updated, both for multi-device and
  for interop. Because `accept_incoming_call` needs the call message locally, an
  iroh-accelerated accept has to be **queued until the email copy arrives**, and
  the 120 s timers on both sides (`calls.rs:38`, `:317-348`) can end a call in
  core that is live over iroh. Plan §6 covers how the two states are reconciled.
- **Media over iroh: not realistic now.** The WebView's `RTCPeerConnection` can
  only use ICE/UDP/TURN. It cannot run on an iroh QUIC stream. Media over iroh
  would need a native pipeline in the Tauri Rust side: capture and playback
  (cpal on desktop, Oboe/AAudio over JNI on Android), Opus, echo cancellation and
  noise suppression, which WebRTC gives for free, plus jitter buffering over QUIC
  datagrams. Upstream position (link2xt, forum "Wider usage of Iroh?",
  2026-06-02): Delta Chat uses WebRTC "because at the time calls were introduced
  Iroh did not even have version 1.0 yet", and Media over QUIC "is not that easy
  … you also need codecs, rate control …". adbenitez (2026-06-15): "using iroh
  for calls brings very little to the table … what makes more sense is to use
  iroh for things we are lacking: … sending files".
- **Where it can run:**

  | Shell | iroh signalling | WebRTC media | Media over iroh |
  |---|---|---|---|
  | Tauri desktop (WebView2/WebKitGTK) | yes (Rust engine) | yes (today) | possible natively, large effort |
  | Tauri Android (WebView) | yes (in-process engine) | yes (today) | possible natively, larger effort (JNI audio) |
  | PWA | relay-only iroh in wasm (§5) | yes (browser WebRTC + TURN) | no |

---

## 4. Upstream direction (checked 2026-10-06)

- **No upstream plan to use iroh for chat messages, presence or calls.** The
  forum thread "Messaging over LAN? [could DC skip the relay when peers are
  nearby?]" (2026-05-28, https://support.delta.chat/t/5321) got the reply "this
  is not a planned feature" (ccclxxiii). Users point to webxdc apps (Realtime
  Chat, ArcaneCircle Live Chat). "Wider usage of Iroh?" (2026-06-01,
  https://support.delta.chat/t/5353) says the next step is the 0.35→1.0 upgrade.
  Files are named as the most useful new use.
- **iroh 1.0:** chatmail/core PR #8182 "feat: upgrade to Iroh 1.0" is open
  (head `02f2990423`, last updated 2026-09-29). Its body says chatmail relays
  have no 1.0 relays yet, a new METADATA key is needed (chatmail/relay#1010, open
  since 2026-06-15), and backup transfer would need both 0.35 and 1.0 or a
  lockstep upgrade. Earlier attempts to 0.90, 0.92 and 0.94 were closed
  (#6960, #7267, #7353).
- **iroh support schedule** (n0 blog "Iroh 1.0 – Dial Keys, not IPs", release
  v1.0.0 published 2026-06-15): public relays for **v0.35x run until
  2026-12-31**, and "the 0.35 minor version won't receive further releases".
  Core's fallback to `RelayMode::Default` (`peer_channels.rs:251-253`) stops
  working on that date for accounts whose relay publishes no iroh relay. Velta's
  engine is not affected, because it is relay-less today.
- **Relay selection:** #5591 "Do not use default iroh relays" (closed
  2024-11-02: chatmail servers host iroh-relay). #8482 (closed) and #8490 (open)
  use community relays such as nine.testrun.org instead of n0.
- **Lifecycle and privacy:** #7058 "Stop iroh when it is not used" (open).
  #6443 (local-network permission prompts, closed 2026-04-19). #7210 "don't init
  Iroh on channel leave" (merged 2025-09-20).
- **WebSocket mail transport:** #8559 (open, 2026-08-11) covers native
  WebSocket to chatmail relays. Per link2xt (2026-08-31), the wasm target is out
  of scope there.
- **Interop rule for Velta:** no other Delta Chat client speaks a Velta iroh
  layer. Every user-visible message must also exist as a normal chatmail
  message, and anything Velta adds to a chat (for example a helper webxdc) must
  render acceptably in other clients.

---

## 5. wasm / PWA

- iroh compiles to `wasm32-unknown-unknown` with `default-features = false`.
  In a browser it is **relay-only over WebSocket**, with no UDP and no hole
  punching, and stays end-to-end encrypted. iroh-gossip has supported browsers
  since 0.33 (n0 docs, fetched 2026-10-06; iroh 0.32 "browser alpha" blog). n0
  says it "continually check[s]" wasm builds for 1.0 (v1 blog).
- The Velta wasm patch series **does not disable iroh**: patch 0002 keeps
  `iroh`/`iroh-gossip` 0.35 as plain dependencies
  (`docs/research/wasm-patches/series/0002-…patch:63-64`), and no patch touches
  `peer_channels.rs` or `imex/transfer.rs` networking. Earlier research recorded
  that slothfulchat found iroh 0.35 compiles for wasm32 "linked but unused"
  (`docs/research/wasm-core-mail-proxy.md:97`, `:152-154`). The production-shaped
  estimate there assumes **capability gates "no webxdc / iroh / local-chat"**
  (`wasm-core-mail-proxy.md:255`). Peer channels in the wasm core are therefore
  **unexercised (unverified)**.
- Velta's engine is Tauri-only (`app/js/p2p.js:1-3`: "the plain-browser PWA has
  no iroh endpoint to talk to"). PLAN-PWA-WEBSOCKET Architecture B estimates a
  wasm port of p2p.rs at ~1.5–3 person-months
  (`wasm-core-mail-proxy.md:262`).
- **Verdict:** a PWA iroh layer is possible later, but relay-only. The relay
  hop costs ~30–100 ms, the same estimate as PLAN-PWA §2, and it hides the user's
  IP from peers. Two ways to get there: the wasm core's peer channels, or a wasm
  build of the Velta engine. Build it on iroh 1.0, where wasm is CI-checked
  upstream, not on 0.35. A browser peer can talk to a native peer only through a
  relay both can reach.

---

## 6. Ways to build the layer (evidence for plan §3)

| | A. JS-only on core gossip | B. Velta engine (p2p.rs) as data plane, core as rendezvous | C. Core patch series (apply-on-copy) |
|---|---|---|---|
| Rust changes | none | Tauri shell only | core + jsonrpc (never production `core/`) |
| Transport | iroh-gossip broadcast | 1:1 QUIC streams, per-peer backpressure | anything; e.g. ship the **same encrypted MIME** over iroh |
| Identity | ephemeral per IO start | persistent per device/profile | can be bound in core |
| Sender attribution | none (§1.2) | QUIC-pinned node id | core contact id |
| Cost per (re)join | one hidden email per chat (`peer_channels.rs:474-479`) | none once linked | none |
| Size | 128 KiB/msg | 256 KiB frames, files ≤256 MB today | any |
| Visible artefacts in other clients | a webxdc app card per chat | helper webxdc **or** none (QR link) | none (invisible header) |
| Relay | chatmail iroh relay or n0 (n0 for 0.35 ends 2026-12-31) | needs the relay URL, which JSON-RPC does not expose (§1.4) | core already has it |
| Desktop sidecar | works | works (engine is in the shell) | needs a custom-built sidecar |
| PWA | maybe, if wasm core peer channels work | needs an engine port | wasm core + patch on top of the wasm series |
| Maintenance | low | medium (Velta already owns p2p.rs) | high: rebase every core release, on top of 13 production patches (`tools/apply-core-patches.py`) and the wasm series |

**About option C:** core already de-duplicates by Message-ID. An incoming
message whose `rfc724_mid` exists is dropped at `receive_imf.rs:554-561`. If
iroh delivered the exact encrypted RFC 5322 message, the peer's core could
ingest it and silently drop the later IMAP copy, keeping full OpenPGP
semantics. But the receive entry point is `#[cfg(any(test, feature =
"internals"))]` and "only used for tests and REPL" (`receive_imf.rs:157-185`),
and JSON-RPC exposes neither raw outgoing MIME nor a receive call. It is a good
proposal to take upstream later, not something to build now.

---

## 7. Velta UI facts relevant to the folders and the chip

- **Folders today:** the category bar `#chat-categories`
  (`app/index.html:46-52`, `role="toolbar"`, buttons
  `All/People/Groups/Channels/Bots/System`). The filter is
  `visibleChats()`/`chatCategoryOf()` (`app/js/app.js:1516-1524`,
  `app/js/rpc-core.js:16-22`). Chips can be hidden per setting
  (`velta-cats-hidden`, `app.js:62-66`, `syncChatCategoryBar` `:1539-1551`) and
  swiped (`swipeCategoryStep`, `rpc-core.js:42-45`). Archived is a tab of the
  search screen (`app.js:2941-2967`).
- **Calls folder:** the bottom bar `chats/contacts/calls/qr`
  (`app.js:1231`). Calls is a side view over the local log (§3.3).
- **Chat row:** `<velta-chat-item>` renders `<velta-avatar>` plus name badges
  (`components.js:301-362`; badges `:265-275`: open lock for unencrypted, wifi
  for p2p). Rows are still `role="option"`. WC plan 2.1 turns them into buttons
  (`docs/web-components-plan.md:126`), and 2.7 gives every status icon text
  (`:132`). The a11y plan asks for forced colors and contrast (N4) and bidi (N6)
  (`docs/accessibility-and-keybindings.md:465-467`).
- **Avatar:** `<velta-avatar>` takes `name, color, kind, size, avatar,
  contact-id, addr` (`components.js:13-15`).
