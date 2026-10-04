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
  Commands (`p2p_groups`, `p2p_group_create{name,memberIds}`, `_add|_remove{gid,
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
  (cumulative acks vs the message's seq).

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
  chats via `core.sendTyping(chatId, on)`.
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
