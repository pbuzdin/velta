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
- Rust tests: `cargo test --lib p2p::` (loopback pairing + offline queue
  flush).

## Rendering in the chat UI (1.3.38)

P2P peers are rendered as regular chats by `app/js/local-chat.js`, a Proxy
AROUND the core object — getChatList/getChat/getMessages/sendMessage/
markRead are intercepted for `p2p:<peerId>` string chat ids, everything
else passes through untouched. Do not special-case p2p ids inside
chat-view.js; add adapter methods instead.

- Media goes over FileBegin/FileChunk/FileEnd frames (base64, 96 KB raw per
  frame, 256 MB cap) in p2p.rs and lands in
  `<accounts>/p2p-blobs/<nodeId>/` — that directory MUST stay under the
  accounts dir because blobfile/media-server refuse paths outside it, and
  that check is the sandbox: peer-supplied file names are sanitized
  (basename only, safe chars) before they ever touch the filesystem.
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
