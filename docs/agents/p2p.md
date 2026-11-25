# Local chat (P2P) — agent notes

Extracted from AGENTS.md. Source: `velta-app/src-tauri/src/p2p.rs` +
`app/js/p2p.js` + `app/js/local-chat.js`.

## Transport

A second chat transport completely independent of the Delta Chat core: 1:1
end-to-end-encrypted chat between paired devices on the same network, using
QUIC TLS 1.3 keyed by the ed25519 node identity (the pairing QR pins that
identity, so the tunnel authenticates both directions); group membership
states are signed by the group's creator. Media is VLTA-encrypted at rest by
default (#465/#473: outgoing copies are sealed on store, received files are
sealed in place once the transfer finishes; per-device opt-out via the
"Encrypt stored media" toggle) — see storage below.
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
- UI (`app/js/p2p.js`): drawer entry is shown when the engine exists, and
  also while the preference is on, so a browser that used "Enter local chat…"
  can turn the preview off. The typing row stays engine-only. Hub with online dots, "Nearby devices" (UDP beacon on port 53717),
  invite QR display, pairing via beacon tap (requires approval on the other
  device) or pasted/scanned code (`acquireCode` offers camera scanning —
  native `BarcodeDetector` where the WebView supports it, vendored jsQR (minified, ~131 KB,
  `app/vendor/jsQR.js`, loaded on demand) fallback otherwise — plus paste everywhere else). Engine-side errors
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
  frame; the sender streams chunks from the blobs copy through a bounded
  channel into a frame-builder task — no whole-file RAM buffer (#459) —
  2 GB sanity cap shared with the receiver) in p2p.rs and lands in
  `<accounts>/p2p-blobs/<nodeId>/` — that directory MUST stay under the
  accounts dir because blobfile/media-server refuse paths outside it, and
  that check is the sandbox: peer-supplied file names are sanitized
  (basename only, safe chars) before they ever touch the filesystem.
  - Storage at rest (#465/#473, parity with relay media): by default every
    blob copy is VLTA-ciphertext under THIS device's attachment key —
    outgoing files are sealed on store (`store_outgoing`, the wire still
    announces the plaintext length), received files are sealed in place on
    FileEnd (the plaintext partial is removed before the rename — Windows
    cannot rename over a live file). Reads decrypt transparently
    (`open_plain`); rendering/thumbnails/Extract-here go through
    `read_media_bytes`, so VLTA magic is expected in `p2p-blobs/`. History:
    before #473 blob copies rested as plaintext (the #448/#451 caveat) — the
    sender's uploads/ copy was core-encrypted VLTA the receiver could not
    unwrap, so `copy_plain` decrypts on copy (#450). Opt-out: drawer
    "Encrypt stored media" toggle (default ON, persisted as
    `velta-p2p-seal=0`, applied at shell boot and via `p2p_set_seal` /
    `setLoopSeal`): new sends then rest as plaintext on both disks;
    already-stored files keep their state. The toggle NEVER affects the
    wire — transfers always ride the QUIC-TLS tunnel; it only skips at-rest
    encryption. The chat database itself stays encrypted (#178).
  - Folders (#459): Attach → Send folder… (local chats) — `list_folder_files`
    (picked-path gate, depth 12, dotfiles skipped) → `folder-zip.js` STORE zip
    (CRC-32, UTF-8 names, dot segments resolved) → the archive rides the normal
    send. Received zips offer Extract here: `unzipToMap` validates the central
    directory + CRCs and rejects non-STORE entries / path escapes;
    `extract_zip_entries` writes under a user-picked destination with an
    escape-proof join (`<dest>/<base>/<rel>`). The renderer never composes
    absolute paths.
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
  ≤ 5 (4 until v1.4.57), sig}; `validate()` is enforced on EVERY state we accept (cap 5, no
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
  Commands (groups come with `p2p_status`; `p2p_group_create{name,memberIds}`, `_add|_remove{gid,
  nodeId}`, `_rename{gid,name}`, `_disband|_leave{gid}`, `_send{gid,text,
  replyTo,replyText}` -> `{id,seq,ts,tsEff,queued}`, `_messages{gid,limit}` ->
  rows with `delivered:[node ids that acked]`) are registered in lib.rs next
  to the 1:1 ones. p2p-hub understands `groups|gcreate|gsend|gmsgs|gadd|
  gremove|grename|gdisband|gleave`.

### Local groups in the UI (Phase 3)

- Adapter (`local-chat.js`): a group is the chat `p2pg:<gid>` (`kind:"group"`,
  `isP2p`, `isP2pGroup`, `memberCount`, `onlineCount`, `canManage`,
  `readOnly`). Everything with a `p2pg:` id is answered by the adapter and
  never reaches the real core or 1:1 commands; relay ids fall through with ALL
  arguments (`getChatMembers`, `leaveGroup` too). `getChatList` takes peers
  and groups from ONE `p2p_status` and re-applies the engine roster each time.
- History hydrates once per group from `p2p_group_messages`; message ids are
  numeric `1e9 + seq` style (increasing, never colliding with relay ids).
  Ticks: pending -> sent -> read; read only when EVERY current roster member
  has acked (`delivered`/`group-ack` cumulative `have`), so a removed member
  stops counting. "X added you" / "You created the group" is a derived system
  line (not persisted); `group-removed` appends "no longer in this group".
- "Delete chat" on a group = leave (member) or disband (creator) if still
  active, then `p2p_group_delete` (Phase 4). The localStorage list
  `velta-p2pg-hidden` is only a fallback if the engine refuses; it is migrated
  to real deletes on the next chat-list load.
- UI guards hide relay-only features for `isP2pGroup`: invite QR, edit,
  add members, mute/pin/archive, forward (in and out), save, react, delete
  message, voice, stickers (photos/files came in Phase 5, see below). The create
  modal (`showCreateGroupModal`, p2p.js) offers only online v2 peers, max 3.
- Everything is behind the local-chat switch: `hubModel()` is null when it is
  off, and both "new group" entries are gated on `p2pEnabled()`.
- Tests: tests/local-group-chat.test.mjs.

### Group member management (Phase 4)

- Only the creator renames, adds and removes (single signer); every member can
  leave, the creator disbands. Info sheet buttons come from the pure
  `groupActionsModel()`; `showAddMembersModal` (p2p.js) offers online v2 paired
  peers within the 5-member cap.
- System lines: the device that observes a change writes `dir:"sys"` records
  into `messages-g-<gid>.jsonl` (`seq 0`, `from ""`, `id sys:<kind>:<epoch>:<i>`;
  kinds created, joined, added, removed, left, gone, renamed, disbanded,
  removed-me, left-me). They are never sent, replayed or counted (`scan_log`
  ignores them) and come back from `p2p_group_messages` with `sysKind`; live
  ones arrive as `group-system`. The creator knows "X left" vs "You removed X";
  members only see the signed roster shrink, so they get "X is no longer in the
  group". The adapter's derived "X added you"/"no longer in this group" lines
  remain only for groups whose log predates this (no `created`/`joined` row).
- `p2p_group_delete{gid}`: only for a finished group (`removed`). It deletes the
  log and the record. If a leave is still undelivered (`pending_leave`) an
  invisible stub (`hidden`) stays until the creator's confirming state arrives,
  then it is purged. Event `group-deleted{gid}`.
- Unpairing: `p2p_peer_groups{peerId}` -> `{created,member}`; `remove_peer`
  deletes every group the peer created (a forgotten creator can't re-sign
  anything for us). Groups it is merely in keep it as an `Introduced` member;
  the confirm dialog (`removePeerImpactText`) says so.
- Message info shows per-member delivery from `delivery:[{id,name,delivered}]`
  (cumulative acks vs the message's seq). Reactions in that sheet are the
  chips already on the message. Local chat does not call
  `get_message_reactions`, so there is no per-person list.

### Typing indicator (Phase 5b, after 1.4.56)

- Wire: `Frame::Typing{gid?, on}` (lowercase tag `typing`). `gid` absent = the
  1:1 chat with the sender, present = that group. Protocol 2 only and LIVE
  only: `typing_peer` / `typing_group` go out through `v2_tx`, never through a
  queue, the log or `peer.msgs`; an offline or v1 peer simply gets nothing
  (a 1.4.x peer would drop the session on an unknown frame, so there is no
  "try anyway"). Receiving: 1:1 needs a paired peer on a v2 session; a group
  hint needs a non-removed group with the sender in the roster; an introduced
  member's 1:1 hint is dropped by the existing non-group gate. Repeats of the
  same state within 500 ms (`TYPING_MIN_GAP`) are collapsed engine-side and
  `Typing` counts toward the 500 frames/s session limit.
- Commands `p2p_typing{peerId? | gid?, on}`; events `typing{peerId,on}` and
  `group-typing{gid,from,name,on}`.
- Sender (`app/js/typing.js`, `TypingSender`, injected clock/timers so it is
  unit-testable): first keystroke sends `on:true`, further keystrokes repeat at
  most every 3 s (`REPEAT_MS`), 5 s without a keystroke or a send/empty box/
  chat close sends `on:false` (`IDLE_MS`). chat-view.js wires it for `isP2p`
  chats via `core.sendTyping(chatId, on)`. The injected timer functions are
  bound to `globalThis` in the constructor: Chromium's `setTimeout` /
  `clearTimeout` throw "Illegal invocation" when called as `this._setTimer(...)`
  (WebView2 hit it), which used to break closing a local chat (#86). Keep the
  `.bind` if the constructor changes.
- Receiver (`local-chat.js`): per chat a map sender -> expiry; a hint lives
  6 s after the last signal (`SHOW_TTL_MS`), an explicit stop or a message from
  that sender clears it. It surfaces as `typingText` on the chat object
  ("Anna is typing…", "Anna and Ben are typing…", "Anna, Ben and Cal are
  typing…") which the chat header (`statusLine`) and the chat-list row show;
  `chat-updated` refreshes both (`refreshLocalGroupHeader` also handles 1:1).
- Setting: drawer row "Typing indicator: on/off" (only while local chat is on),
  localStorage `velta-p2p-typing`, `"0"` = off, default on. Off means neither
  send nor show (incoming hints are ignored too). Frontend-only; the engine has
  no flag.
- Tests: Rust `typing_hints_*`; tests/local-typing.test.mjs.

### Media in groups (Phase 5)

- Wire (v2 sessions only, lowercase tags `groupfilebegin|groupfilechunk|
  groupfileend`, each with `gid` + transfer `id`; the sender is the session's
  authenticated node, never a field). Cap `MAX_GROUP_FILE_BYTES` = 32 MiB, 96 KB
  raw chunks (base64 < `MAX_FRAME`). Files are delivered LIVE to members that
  are online (v2 session, in the roster, not `gone`) when the file is sent; they
  are not queued, not replayed, not part of the seq stream (a replay window
  must not wait for a file an offline member can never get).
- Sender (`group_send_file`, command `p2p_group_send_file{gid,path,name,caption}`
  -> `{id,ts,tsEff,file,members:[{id,state}]}`): validates, copies the file to
  `p2p-blobs/g-<gid>/out-<id>_<name>`, appends a log row (`dir:"out"`, `seq 0`,
  `id` = transfer id, `file{name,size,mime,path}`; counters and `scan_log`
  ignore `seq 0`), then starts one `stream_group_file` task per online member.
  It reads 96 KB from the copy, takes a credit from the session handle's
  semaphore (`GROUP_FILE_CREDITS` = 4) and queues the chunk; the session writer
  hands the credit back after the chunk hit the wire. So memory is O(chunk) per
  recipient however big the file or slow the receiver (the session channel is
  still unbounded for everything else; only bulk chunks are gated). The 1:1
  `send_file` is unchanged (it still builds all its frames up front, 256 MB
  cap). A dying session closes its semaphore and fails its own sends only.
- Per-member state, in memory (`group_xfers`, by transfer id): `sending |
  done | failed | offline` + bytes written. `done` = the End frame was written
  to the wire (there is no receiver ack for files). Events `group-file-progress
  {gid,id,member,dir:"send",state,got,size}`. `p2p_group_messages` rows carry
  `file` and, for own files still in memory, `fileMembers`. After a restart only
  the log row remains (no per-member state; the UI shows a plain sent file).
- Retry: `p2p_group_file_retry{gid,id,member}` re-sends from byte zero to ONE
  member that is `failed`/`offline` (or whose state is unknown after a restart);
  refuses when the member is offline, already sending/done, or the stored copy
  is gone. Receivers ignore a transfer id they already have (log check).
- Receive (`on_group_file`, same hygiene as 1:1): only on a v2 session from a
  current member of a non-removed group; `is_safe_transfer_id` for the id,
  `sanitize_name`, size cap, `MAX_INBOUND_FILES_PER_PEER` (3) and
  `MAX_INBOUND_FILES_TOTAL` (8) shared with 1:1, partial `partial-<node>-<id>`
  under `p2p-blobs/g-<gid>/`, size must match on End (else the partial is
  deleted), a 1:1 `FileChunk/End` never touches a group transfer and vice
  versa (`FileRx.gid`). Partials of a peer that went fully offline are dropped
  (group transfers only). Completion writes a log row (`dir:"in"`, `seq 0`)
  and emits `group-message{... seq:0, file{name,size,mime,path}}`. Group frames
  other than file chunks keep the 500/s limit; file frames are exempt.
- Group delete / unpair cascade removes `p2p-blobs/g-<gid>/` and the transfers.
- Adapter: a file message is identified by `(author, transfer id)`, not seq
  (`rowKey`, `fileKey`); `sendMessage` with a file calls `p2p_group_send_file`
  and REJECTS when the engine refuses (nobody online, over 32 MB) so no phantom
  bubble appears; voice is still rejected; a reply quote does not travel with a
  file. Tick: clock while anyone is receiving, double when every current member
  has it, single when some do, failed card (Retry) when nobody does. The bubble
  bar is the average over the members being sent to. Message info lists each
  member with a Retry button for `failed`/`offline` ones (`lcRetryTransfer(
  chatId, msgId, memberId?)`; without a member it retries all that miss it).
  Progress events that beat the command reply are buffered (`earlyXfer`).
  The attach button and image paste are enabled in groups; stickers stay hidden.
- Tests: Rust `group_file_*` (pacing/credits, offline+v1 skipped, per-member
  failure and retry, retry after restart, receive limits/sanitization, gating,
  cleanup, real engines); tests/local-group-media.test.mjs.

### Groups of up to 5 (after 1.4.57)

- `MAX_GROUP_MEMBERS` = 5 (creator included, so up to 4 invitees; UI
  `GROUP_MAX_OTHERS` = 4); `LEGACY_MAX_GROUP_MEMBERS` = 4 is the cap of
  v1.4.56/57. Mesh sizing at 5: 4 sessions per member (full mesh), the frame
  limit (500/s) and ack window (200) are per session / per member so they do not
  change, `MAX_GROUPS` is unchanged, `MAX_MEMBER_ADDRS` is per roster entry, and
  the worst legal `GroupState` (5 members, 64-char multi-byte names, 3 IPv6
  addrs each) is < 8 KB against `MAX_FRAME` 256 KB (unit-tested).
- KNOWN LIMITATION / capability signal: v1.4.56/57 reject any roster above 4
  (silently: "group state ignored") and report protocol 2 like current builds,
  so the engine cannot tell them apart by protocol. Each v2 session therefore
  opens with `GroupCaps{max}` (is_group, lowercase tag `groupcaps`; old builds
  skip it as an unknown frame). `require_group_cap` refuses a roster of 5 (create
  with 4 invitees, or add a 5th) unless EVERY other member announced `max >= 5`
  in this run (`GroupRt.caps`, in memory, not persisted); an offline member or
  one that never announced counts as an old build and the error names it
  ("… may not support groups of more than 4 … update it and keep it online").
  Groups of up to 4 never need it. Consequence: to make or grow a group to 5,
  all members must be online (connected at least once since app start) and on
  the new build. There is no UI-side pre-filter yet; the engine error is shown as
  a toast.
- Late failure of an old transfer attempt no longer overwrites a retry that
  already started (the stream checks that its session handle is still the
  member's current one).
- Tests: `five_member_group_*`, `session_open_announces_the_group_cap_*`,
  `five_real_engines_form_a_group_and_chat`, the worst-case size check in
  groups.rs.

## Velta Dash — automatic iroh file transfer (#470)

**Name.** User-facing brand: **Velta Dash** (short: **Dash**), kept
untranslated in ru/fr like Velta Loop and Velta Beam. Dash is the automatic
over-6-MB 1:1 file path; Loop is the local-network chat, Beam the send-to-many
webxdc. Code, prefs, commands and config keys keep the internal name `xfer`
(`velta-iroh-xfer`, `xfer_*`, `ui.velta.xfer*`, `VXFER1:`).

**UI.**
- The brand mark in the UI is `DASH_SVG` (icons.js): velta.cc/dash-logo.svg
  byte-exact — the user-fixed geometry, filled, like `LOOP_SVG`. Used by the
  header badge (a `hydrateIcons` special case for `data-icon="dash"`), the
  drawer toggle, the card route badge and the explainer. `P.dash` stays the
  house-style outline glyph and exists only as the KMP sync source
  (`VeltaIcons.kt`); never render it in the Tauri/PWA UI.
- Drawer toggle "Velta Dash: on/off" (`data-setting="dash"`, Tauri only). A
  flip fires `velta-dash`: the glue re-announces `ui.velta.xfer` and the chat
  header badge refreshes.
- Chat header badge `#btn-dash` (icon `DASH_SVG` + "Dash"): shown only in a 1:1
  chat with Dash on **and** the contact proven (`dashState() === "on"`);
  hidden for groups, Saved Messages, local chats, the PWA, Delta Chat and
  unproven contacts. A message from the open contact re-checks it. Tap →
  explainer with a link to the drawer setting. 44px hit area.
- Contact profile row "Velta Dash: On / Not yet / Off" opens the same
  explainer; "Not yet" carries the hint "Dash starts after you both exchange
  a message".
- File card: route badge `.xfer-route` — Dash, or Email fallback.
- Diagnostics (#489): a file over 6 MB that goes by email logs
  `iroh xfer: sent <name> by email: <reason>` (`emailReason()`: off, not 1:1,
  contact not proven, PWA).
- The capability is announced on the first chat open (`ensureXfer` in
  `ChatView.open`), so the first message already carries the header: after
  one message each way both sides are proven.

`velta-app/src-tauri/src/xfer.rs` is the engine. It uses **iroh 0.35**
(`iroh035`), the version core and chatmail relays' iroh relays speak.
`app/js/iroh-xfer.js` holds the policy and the message formats;
`app/js/iroh-xfer-ui.js` is the composer / bubble / core-event glue.

**Rule.** An attachment goes over iroh only when all of these hold:
- the chat is 1:1;
- the contact has **proved** it runs Velta with the transfer (below);
- the file is larger than 6 MB (`THRESHOLD`);
- the setting `velta-iroh-xfer` is on (it is on by default);
- the app runs in the Tauri shell.

Anything else is mailed as a normal attachment. The relay domain is never
used as a hint.

**Capability (core patch #31, tracker #490).** The Tauri shell sets the
account config `ui.velta.xfer` to `1` (or `0` when the setting is off). Core
then adds `Chat-Velta-Xfer: 1` to its encrypted messages only. When core
receives that header in an encrypted, signed message (`fingerprint` set), it
stores the time in `ui.velta.xfer.peer.<contact id>`. `peerCanXfer` reads it.
The PWA never announces.

**Ticket** (`VXFER1:` + base64url JSON): `v`, `proto` (`iroh-0.35`),
`node`, `relay`, `addrs`, `hash` (SHA-256), `size`, `name`, `exp` (24 h by
default), `sec` (random per-ticket secret).
- It travels in a small encrypted text message. Two readable lines (the
  second says the file follows by email, for Delta Chat and other apps),
  then the ticket.
- `relay` is the sending account's advertised iroh relay
  (`get_server_metadata` → `irohRelay`). Without one, the endpoint runs with
  `RelayMode::Disabled` and uses direct paths only.
- n0's relays are never used (`relay_mode_for`).

**Provider and fetch.**
- ALPN `/velta/xfer/1`. One bi-stream per request: `{hash, offset, sec}`,
  then a header, then the bytes from `offset`. A wrong secret gets
  "not offered": the hash alone fetches nothing.
- Offers are stored copies under `app_local_data/xfer/out/<sha256>`, sealed
  with the #465 at-rest key when the profile has one. The copy is read
  through `AttachmentReader`, so sealed composer uploads go out as plaintext.
  `offers.json` (sealed, or 0600 without a key) keeps them across restarts.
- The fetch dials the ticket's relay only when it is our **own** advertised
  relay or the **sender's** chatmail relay: the app passes the sender
  contact's mail domains as `peers`, and `allowed_relay` accepts
  `https://<domain>` or `https://iroh.<domain>` for them (never n0, never
  http, no suffix tricks). Two phones on different relays and on 4G (no
  direct path) meet through the sender's relay. Any other relay: direct
  paths only.
- A read that stays idle 30 s (`READ_IDLE`, per-endpoint configurable via
  `set_read_idle`) ends the fetch as `Io("stalled")` (partial kept), so a
  dead peer never leaves a card spinning. The same bound covers the whole
  request/response **handshake**: a peer that accepts the connection but
  never answers the request frame (backgrounded mid-handshake, wedged
  accept loop) stalls out instead of parking `xfer_fetch` forever.
- Belt and braces in JS: `startFetch` caps the WHOLE receive
  (`WAIT_MS.fetchMs` 5 min + `fetchPerMbMs` 500, a ~2 MB/s floor). A peer
  that trickles a byte per idle window passes every Rust bound; past the
  cap the card errors "interrupted" and Retry resumes from the `.part`.
- The first `xfer-progress` event fires at 0 bytes, so the card flips from
  "Waiting for sender…" to "Fetching via Velta Dash 0%" the moment the
  stream opens — handshake-wait and body-stall are distinguishable on
  screen.
- `xfer_health(relay)` → `{ready, relay, relayConnected, direct}` (the
  endpoint up and its home relay connected within 4 s); `xfer_file_size`
  gives the plaintext size of a sealed upload without reading it in JS.
- The receiver refuses tickets over 2 GiB and checks free space first
  (`TooLarge`, `NoSpace` — neither asks for email).
- It resumes from `xfer/part/<hash>.part`, checks the SHA-256 at the end and
  deletes the partial on a mismatch. Partials older than 3 days are removed.
- Received files land in `accounts/xfer-in/`, sealed under the at-rest key
  (the media server decrypts them). Core has no RPC to attach a file to an
  existing message, so they are not core blobs and are not in backups.
- `identity.key` is sealed under the at-rest key, or 0600 without one.
- Tauri commands: `xfer_offer`, `xfer_fetch`, `xfer_withdraw`,
  `xfer_status`, `xfer_health`, `xfer_file_size`. Progress arrives as the `xfer-progress` event.

**Fallback.**
- When `FetchError::wants_email()` is true, the receiver sends
  `VXFER-RESEND:<hash>`. That covers an expired ticket, an unreachable sender,
  a withdrawn offer, a hash mismatch or another iroh version. The PWA (no
  iroh) sends it at once for unexpired cards.
- The sender honours it only from the chat the file went to, or from Saved
  Messages (its own other device, which asks via the "Ask for the email
  copy" button on an outgoing card it has no copy of). The file is mailed to
  the chat that asked; a peer's request also withdraws the offer.
- The pending list (`velta-xfer-pending:<account>`) survives restarts. A
  sweep (boot, account switch, every 5 min) mails expired undelivered offers,
  withdraws delivered ones after an hour, and drops offers xfer.rs lost.
- Files over `EMAIL_MAX` (22 MiB, chatmail's 30 MiB limit minus overhead)
  are never mailed: not on a failed offer (`send` returns `route: "none"`
  and the composer says why — nothing reaches the receiver), not from the
  sweep, and the receiver never asks for an email copy of one (card: "Too
  large for email: ask the sender to resend while you are both online",
  with Retry).
- A broken or stalled stream (`Io`) resumes over iroh by itself after 5 s and
  15 s (`RETRY_DELAYS_MS`), then the card shows "Velta Dash transfer
  interrupted." with Retry.

**Composer (pre-send route, #470 phone test).** Every attachment path goes
through the same policy: the pending strip (photos, videos, and picked files
over 6 MB, which now stage too) shows a `#media-route` line from
`planSend()` → `planRoute()` before Send:
- "Velta Dash: direct to K" — Dash on, contact proven, endpoint up and its
  relay connected (`xfer_health`, cached 20 s);
- "Velta Dash is unavailable right now: sending by email (max 22 MB)";
- "Too big for email (max 22 MB) and Velta Dash is unavailable right now" /
  "Too big to send by email (max 22 MB)" — Send is refused, the file stays
  staged.
A Dash send mails the ticket card, then the caption as its own message.

**Receiver card states.** "Waiting for sender…" → "Fetching via Velta Dash
34%" (`xfer-progress`) → "Received with Velta Dash"; or "Couldn't fetch via
Velta Dash: asked for the email copy"; or the too-large / interrupted states
above (Retry). Hard-won invariants (each was a shipped "stuck spinner /
dead preview" bug):

- The state line lives in `.xfer-foot`, a **sibling** of `[data-xfer]` (the
  foot spans the bubble and carries the timestamp). `paintCard` resolves it
  through `card.parentElement` — querying inside the card finds nothing and
  silently never updates, which is exactly how a finished fetch kept
  showing "Waiting for sender…" while `cardState` said done. The row-resize
  height check counts the foot too (error text wraps).
- Byteless media (a transfer that succeeded on the sender's other device)
  falls back to the small kind tile, so a settled card reads like an
  ordinary file with Ask/Retry intact. The "Preview unavailable" dead tile
  renders only when bytes are present but the codec refused them (the
  decode-failure runtime path). An in-flight fetch keeps the file-type
  glyph — never a dead tile under the busy ring. (`paintCard` must count
  dead tiles as "have": checking only for `.xfer-preview-btn` stacked a
  fresh dead tile on every repaint.)
- A preview media error retries ONCE with `fileUrl` recomputed before going
  dead: the first paint can precede the media server / blobfile probe, and
  the `convertFileSrc` fallback serves the VLTA-sealed bytes raw.
- `xferProgressEvent` ignores cards settled with an error (like done ones):
  a late event must not resurrect the busy ring — nothing would clear it.

**File card layout (#519).** A Dash message is still a text bubble carrying
the ticket, but the card is a file row, not a wrapping flex line: a 44px
type tile (accent fill + `--on-accent` icon from a closed kind map — video,
audio, image, archive, file; no extension letter), a one-line filename that
keeps its extension (`splitFileName`; `.tar.gz` and `.tar.bz2` stay whole,
everything else keeps the last suffix; the base ellipsizes, the extension
never breaks off), and a size row: byte count (`fmtSize`), the route chip
(a passive status token on `--text-meta-in` / `--text-meta-out`, never
accent), and the action. The status sentence shares the timestamp row with
`.msg-meta` (`.xfer-foot`) instead of crowding the size row, and an ERRORS
sentence wraps there (`.is-error`) without moving the tile. Open and Show in
folder are `.btn-text` buttons, not anchors and not pills — Open computes the
`fileUrl` at click time from card state and never carries an href (and never
`open_document`: a Dash file is not a core blob, the sealed `accounts/xfer-in/`
path would reach the OS as ciphertext). A fetched image/video shows the real
preview in place of the tile (#517): the picture opens the image lightbox,
the play disc opens the player; bytes on the sender's device preview the same
way. The size row spans the full card width (grid `"sub sub"`), so glyph and
media cards align; the row verb (Open / Show in folder / Retry / Ask) hugs
the far end (`margin-left: auto`). Ask shows only where email can actually
carry the file: `noteCard` stores the size on outgoing cards too, and an
own-other-device card over the 22 MiB cap hides Ask (it could only invite a
doomed request). `refresh()` dispatches `velta-row-resized` only when the
card's integer
height (card + sibling foot) changes — a percent tick never moves the
history — and a recycled row repaints via `paintXferIn` before the scroller
measures it.

**Plain email over the cap.** Core sends a big attachment as a small
pre-message plus the full post-message. When the sender's relay refuses the
post-message, the receiver's stub stays `InProgress` forever. After 60 s the
bubble says "Not arrived yet: it may be too large for email" and a tap
explains (`EMAIL_STALL_MS`, `inProgressSince`).

**Badge convergence (capability echo).** Proof is one-way: the header rides
only on our own normal messages. When a proven peer's 1:1 message arrives,
the glue sends an empty reaction (`clearReaction`) at most once a week per
contact (`velta-xfer-told:<account>:<contact>`): a hidden encrypted message
core stamps with the header, so after one message in either direction both
phones show the badge. Core test `test_velta_xfer_capability_echo`.
- Core events (`incoming-msg`, `msg-updated`) feed the glue, so requests and
  cards are handled with the chat closed — for the selected account only.

**Tests.**
- `xfer.rs`, 16 tests, including: only our own or the sender's chatmail
  relay is dialled; phones on two relays meet through the sender's relay; the hash
  alone does not fetch; too-large tickets refused before connecting; offers
  survive a restart and rest sealed; keyless identity is 0600 and stale
  partials go; a peer that accepts but never answers stalls out (read-idle
  bound on the handshake) instead of hanging.
- `tests/iroh-xfer.test.mjs`: route, relay pick (camelCase), card codec,
  persisted pending + resend rules, sweep, PWA auto-ask, UI glue in Tauri
  and PWA modes, pre-send routes and the email cap, receiver card states
  (in-flight shows no dead tile; a never-settling fetch hits the hard cap;
  a late progress event cannot resurrect a settled card), the foot-sibling
  structure contract, the `DASH_SVG` mark geometry, and both phones
  converging on the badge.
- Core: `test_velta_xfer_capability`, `test_velta_xfer_capability_echo`
  (patch #31).

**Not done yet:**
- per-relay rate caps; reading the relay's real size limit;
- Loop-only mode and the linked-chat live path (phases 2–3).
## PWA Loop over WebRTC (#468, engine slice)

`app/js/webrtc-loop.js` is the PWA's Loop transport. Browsers can't use iroh's
direct paths, so `LoopLink` uses one reliable, ordered `RTCDataChannel` per
contact.

- **Signaling** goes over encrypted Velta messages. `createXdcSignal` sends
  `{payload: {veltaLoop: {vlw: 1, t: offer|answer|bye, from, sid, sdp, fp}}}`
  as webxdc status updates in the 1:1 chat, with no `info`, so nothing shows
  in the chat. Offer and answer go out once, with every candidate gathered
  (non-trickle), because Velta messages take seconds.
- **No ICE servers by default.** There is no TURN, and STUN only if a caller
  passes `iceServers`. A dead path ends in `failed` / `network` with a message
  about isolating networks. Traffic is never relayed silently.
- **DTLS pin.** `fp` is the sender's certificate fingerprint, inside the
  encrypted message.
  - A signal whose SDP names another fingerprint is refused before any WebRTC
    object is created.
  - On open, the certificate the peer presented (`getStats`, transport →
    `remoteCertificateId`) must equal the pin. `link.verified` reports that
    this check ran.
- **Frames.** Text frames are JSON (`msg`/`ack`, `file-begin|end|cancel|reject`).
  File chunks are binary `[idLen][id][16 KiB]`, sent with `bufferedAmount`
  back-pressure, and handled strictly in order.
- **Receiving files.** They stream into OPFS (`createWritable`, Chromium).
  Elsewhere they go to memory, capped by `MEM_CAP` (150 MB). Every file is
  SHA-256 checked against `file-begin`.
- **Opt-in per contact** (`loopOptIn` / `setLoopOptIn`, localStorage
  `velta-loop-webrtc`), because WebRTC shows the peer your local IPs. State
  lines never show an address.
- **Tests.** `tests/webrtc-loop.test.mjs` (pure parts) and
  `scripts/e2e-webrtc-loop.mjs`. The e2e runs two real Chromium pages with no
  ICE servers and covers: direct connect plus pin verified, chat plus ack, a
  3 MB file to OPFS with hash check, cancel, a tampered SDP refused, and no
  path reported as failed.
- **Not done yet:**
  - UI wiring: the per-contact toggle, the state chip, and Loop chats in the
    chat list for PWA peers;
  - the Tauri side (`webrtc-rs`) for PWA ↔ desktop/Android;
  - optional user-configured TURN.
