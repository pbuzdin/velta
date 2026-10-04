# Local chat (P2P) — agent notes

Extracted from AGENTS.md. Source: `velta-app/src-tauri/src/p2p.rs` +
`app/js/p2p.js` + `app/js/local-chat.js`.

## Transport

A second chat transport completely independent of the Delta Chat core: 1:1
end-to-end-encrypted chat between paired devices on the same network, using
iroh (QUIC, `RelayMode::Disabled`, optional mDNS re-discovery via the
`discovery-local-network` feature) — modeled on the core's backup transfer
(`core/src/imex/transfer.rs`).

- Identity: ed25519 key persisted in `<AppLocalData>/p2p/identity.key`; the
  NodeId is the long-term identity. Store: `profile.json`, `peers.json`,
  `messages-<node_id>.jsonl`.
- Pairing: inviter shows a `VELTAP2P1:` ticket (compact base32: NodeId +
  direct addresses + pairing token, rendered as QR via the core's
  `create_qr_svg`); joiner scans/pastes it, presents the token in a `hello`
  frame — token presentation is the out-of-band proof, so the inviter
  accepts automatically. The token is never broadcast: LAN beacons carry
  only names and addresses, and a Nearby tap sends an empty-token request
  that the other device must approve in the UI (`p2p_approve_pair`); wrong
  tokens are rejected without a prompt. Unpaired NodeIds are otherwise
  rejected.
- Messaging: newline-delimited JSON frames (`msg`/`ack`/`ping`) over one
  bidirectional QUIC stream per session; sends to offline peers are queued
  and flushed on reconnect. Events reach the UI as Tauri `p2p-event`s;
  commands are the `p2p_*` Tauri methods registered in `lib.rs`.
- Disabled by default: the Rust flag (`P2pState::empty`) starts `false` and
  `spawn_startup` refuses to start when disabled (checked before *and*
  after `P2p::start`, so a disable request racing the boot spawn still
  wins). `p2p_set_enabled` starts/stops the engine (endpoint socket
  released, beacons off); the opt-in preference lives in the WebView
  (`localStorage["velta-p2p"] === "1"`, applied on every boot by
  `app/js/p2p.js`, which calls `p2p_set_enabled(true)` only when opted
  in). KEEP: a fresh install must not open QUIC sockets or broadcast LAN
  beacons without the user asking for it.
- UI (`app/js/p2p.js`): drawer entry (Tauri-only, hidden in browser/PWA
  mode), hub with online dots, "Nearby devices" (UDP beacon on port 53717),
  invite QR display, pairing via beacon tap (requires approval on the other
  device) or pasted/scanned code (`acquireCode` offers camera scanning —
  native `BarcodeDetector` where the WebView supports it, vendored jsQR
  fallback otherwise — plus paste everywhere else). Engine-side errors
  (background connect retries) go to the Diagnostics chat, never toasts —
  several queued connects can fail at once and the store collapses
  identical consecutive entries into one counted row.
- Protocol versions (local group chat Phase 0b): the endpoint accepts and
  dials ALPN `/velta/p2p/2` first and falls back to `/velta/p2p/1`
  (`connect_with_opts` + `additional_alpns`); the negotiated ALPN is read from
  the connection (`proto_of`) and stored per live session (`LiveHandle.proto`)
  and per peer in `peers.json` (`proto`, `#[serde(default)]`, 0 = unknown;
  also reported as `proto` by `p2p_status`). v2 carries the same frames as
  v1 today. KEEP: a frame that only v2 understands must never be sent on a
  v1 session — the ALPN decides, not a flag inside a frame. `Frame` and
  `Hello` have `#[serde(other)] Unknown`, so a future frame type is skipped
  instead of ending the session (a known type with a broken body still ends
  it). Inbound file transfers are keyed by `(node id, transfer id)`.
- Rust tests: `cargo test --lib p2p::` (loopback pairing, offline queue
  flush, ALPN v2 + v1-only peer, unknown frames, transfer keying).

## Rendering in the chat UI (1.3.38)

P2P peers are rendered as regular chats by `app/js/local-chat.js`, a Proxy
AROUND the core object — getChatList/getChat/getMessages/sendMessage/
markRead are intercepted for `p2p:<peerId>` string chat ids, everything
else passes through untouched. Do not special-case p2p ids inside
chat-view.js; add adapter methods instead.

KEEP (post-1.4.35): relay-chat fall-throughs must forward the FULL
argument list — `(t, id, ...rest)`, never just the first parameter. The
phase-1 fall-through called `deleteMessages(chatId)`, silently dropping
`ids` and `{forAll}`: with local chat ON, every deletion in a normal chat
(relay AND Saved Messages) reached the core as
`delete_messages(account, null)` and failed with serde
`invalid type: null, expected a sequence` (user report, webp attachment);
the same drop killed "Delete for everyone" and setChatFlags
archive/mute/pin. Pinned by tests/local-chat-transfer-progress.test.mjs.
When adding a method to `P2P_HANDLED`, decide explicitly whether the
fall-through needs the full signature.
Chat-list delete of a local chat does not go through this proxy: `app.js`
calls `removePeer` for `p2p:` ids (#34). `deleteChat` is the relay-core
`delete_chat` method and is not in `P2P_HANDLED` — a string id must not
reach it.

## Chatmail core stays (#31, wontfix)

Closed 2026-09-30 as not planned. Do not turn the vendored chatmail core
into an optional transport plugin.

The core owns accounts, history, and the message model (`app/js/rpc-core.js`,
the `deltachat-rpc-server` sidecar, the core SQLite). Identity is an email
address plus an OpenPGP key. Inside the core the word "transport" is already
taken: `core/src/transport.rs` is one IMAP/SMTP relay, not a protocol slot.
A profile can hold several relays and the core refuses to delete the last
one.

Local chat is the side path. It wraps whatever core the app booted and adds
`p2p:` chats. It does not replace the core, and the mail core keeps running.
A profile with no relay is the welcome splash's "Enter local chat…" (#32),
not an app that works with the core uninstalled. Reaching relays through a
SOCKS proxy was #29 and does not start this work.

Research: https://github.com/pbuzdin/velta/issues/31#issuecomment-5887003522.

- Media goes over FileBegin/FileChunk/FileEnd frames (base64, 96 KB raw per
  frame, 256 MB cap) in p2p.rs and lands in
  `<accounts>/p2p-blobs/<nodeId>/` — that directory MUST stay under the
  accounts dir because blobfile/media-server refuse paths outside it, and
  that check is the sandbox: peer-supplied file names are sanitized
  (basename only, safe chars) before they ever touch the filesystem.
  KEEP (1.4.28): peer-supplied **transfer ids** go through
  `is_safe_transfer_id` before joining the `partial-{id}` path — the id is
  also peer input; only short `[A-Za-z0-9_-]` tokens pass.
- Transfer and queue states ARE rendered (since 1.4.1): `file-progress`
  events drive a bubble progress bar (2% steps); a `done` event clears it
  for the file card, and a `failed` event (session died mid-send) renders
  a Retry card — `lcRetryTransfer` re-sends the stored blobs from byte
  zero (NO resume; the engine discards bad partials).
- Media picked while the peer is offline parks in the composer queue chip
  (`#lc-queue-chip`, popup: send-now/remove) and auto-flushes oldest-first
  on the peer's `presence` online transition.
- Offline TEXTS queue inside the engine: `p2p_send` returns
  `{id, queued}`, the bubble shows the `pending` clock (ticksSvg), the
  reconnect flush emits a `msg-state` event (queued → sent) and the peer's
  `ack` completes read. `send_file` still bails when the engine considers
  the peer offline — the frontend queues proactively on its own
  `online === false` before calling.
- Beacons refresh a paired peer's stored addresses (DHCP/roam heals the
  dial book within one beacon interval); tests in
  `tests/local-chat-transfer-progress.test.mjs` pin the event contract.
- Failed texts (since 1.4.2) render the same Retry card as failed
  transfers: mapMsg maps `failed` to state "failed" and the adapter's
  resendMessage re-sends the same text/quote as a FRESH message (swap, not
  append; the failed bubble is restored when the engine rejects the retry —
  identical contract to lcRetryTransfer). Only failed msgs match;
  pending/sent ones fall through to the real core.
- Message ids stay NUMERIC: `_resendTail`/`onMsgsChanged` compare ids with
  `>` — string ids silently drop every message from the "append only new"
  filter (local-chat.js learned this the hard way; its ids are
  `1e9 + seq`).
- History hydration (local group chat Phase 0a): the adapter store is
  memory-only, the engine's `messages-<id>.jsonl` is the source of truth.
  `hydratePeer` in local-chat.js loads it through `p2p_messages` ONCE per peer
  (from `getChatList`, `getChat`, `getMessages`, `getMessageIds`); failures are
  not remembered (retried on the next call). Engine rows get fresh numeric
  `1e9+seq` ids and keep the engine id in `engineId`, which de-duplicates a live
  event that raced the hydration. KEEP: never use engine string ids as message
  ids. Pinned by tests/local-chat-hydration.test.mjs.
- Offline text queue (post-1.4.55): `Peer.queued` is rebuilt on load from the
  log (outbound texts still marked `queued`, media is never queued) and the
  peer is dialled at start; `flush_queue` flips the stored row in place (it
  used to append a second "sent" copy, loading collapses such twins). Sent
  media gets a numeric adapter id like texts (`engineId` holds the engine id).
- Local groups, engine side (Phase 1, no wire messaging and no UI yet; plan:
  local-group-plan.md). `p2p/groups.rs`: `GroupState` = creator-signed
  (ed25519, identity key) roster {gid, creator, epoch, name, closed, members
  ≤ 4, sig}; `validate()` is enforced on EVERY state we accept (cap 4, no
  duplicate/alias node ids, creator first, names ≤ 64 chars, ≤ 3 addrs); addrs
  are not signed, names are; a state is applied only if its epoch is higher.
  `groups.json` (atomic tmp+rename, invalid records dropped on load) holds one
  `GroupRec` per group, `MAX_GROUPS = 16`. Members we have not paired with are
  `PeerKind::Introduced` entries in `inner.peers` so dial/session machinery
  works, but: never in `peers.json`, never in `status().peers`, no `presence`
  events (the adapter would create a `p2p:` chat), `send`/`send_file`/
  `messages`/`remove_peer` refuse them, and `handle_frame` drops every
  non-group frame from them. `rebuild_introduced`/`gc_introduced` keep them
  in step with the rosters. KEEP: group frames go only to ALPN v2
  sessions (`v2_tx`); invitees must be Paired and have
  `proto >= 2`. First contact for a group is accepted only from its creator
  if paired; later states from any member (relay).
- Local groups, messages over the mesh (Phase 2). Frames (v2 sessions only,
  lowercase tags `groupstate|groupsync|groupmsg|groupack|groupleave|groupgone`):
  every session sends `GroupSync{gid,epoch,have,name}` per shared group right
  after its opening Ping (`group_session_open`); a creator whose invitee has
  not confirmed the roster sends `GroupState` first. Epochs reconcile through
  syncs (peer behind -> I send my `GroupState`; peer ahead -> I restate my
  epoch so it relays), and an author replays (`pump`) only to a member that is
  in my roster AND reported the same epoch, so a removed member gets a state,
  never messages. Delivery = per-sender seq: receiver stores only
  `seq == have+1` (log line first, then `have` in groups.json), re-acks
  duplicates, answers a gap with ONE `GroupSync{have}` per `have`. The author's
  own log is the queue: `sent_cursor[member]` (cumulative acks) is the
  delivery state; at most `GROUP_WINDOW` (200) unacked messages are in flight,
  acks pull the rest. Log: append-only `messages-g-<gid>.jsonl`
  (`GroupLogRec`; never rewritten); on start `next_seq` and `have` are
  recomputed from it (crash between log write and groups.json). `ts_eff =
  max(prev, min(ts_author, now))`. `GroupMsg.from` must equal the session's
  node id (else dropped + `error` event), the sender must be in the roster,
  text 1..64k, unknown gid -> `GroupGone` (believed only about the sender;
  clears on its next sync or a newer state), 500 group frames/s/session.
  Creator: re-signs on `GroupLeave` (member retries until the new roster
  arrives, `pending_leave`), announces every edit to the old and new rosters.
  Events: `group-state{group}`, `group-message{gid,from,name,id,seq,ts,tsEff,
  text,replyTo,replyText}`, `group-ack{gid,by,have}`, `group-removed{gid,
  reason:removed|closed}`, `group-presence{peerId,online,gids}` (the only
  presence an Introduced member ever produces). Introduced members claim
  their own name in GroupSync; it wins over the roster name for display.
  Do not route group traffic through `peer.msgs`/`persist_messages`.
  Commands (`p2p_groups`, `p2p_group_create{name,memberIds}`, `_add|_remove{gid,
  nodeId}`, `_rename{gid,name}`, `_disband|_leave{gid}`, `_send{gid,text,
  replyTo,replyText}` -> `{id,seq,ts,tsEff,queued}`, `_messages{gid,limit}` ->
  rows with `delivered:[node ids that acked]`) are registered in lib.rs next
  to the 1:1 ones. p2p-hub understands `groups|gcreate|gsend|gmsgs|gadd|
  gremove|grename|gdisband|gleave`.
