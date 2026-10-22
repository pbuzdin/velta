# Reply threads

Status: shipped on master 2026-10-22 (post-1.4.76). Core part: quilt op
#14 (VENDORISSUES.MD #14). Code: `app/js/chat-view.js`, `app/js/rpc-core.js`,
`app/css/main.css`, tests in `tests/reply-counts.test.mjs`.

## Model

A reply is any message that quotes another one. The core stores the quoted
message's Message-ID in `msgs.mime_in_reply_to` (set by `Message::set_quote`).
There is no separate thread object; a thread is "the parent plus every
message in the same chat whose `mime_in_reply_to` equals the parent's
`rfc724_mid`".

## Core queries (quilt op #14)

| JSON-RPC | Rust (`core/src/chat.rs`) | Returns |
|---|---|---|
| `get_reply_counts(account_id, chat_id)` | `chat::get_reply_counts` | map quoted msg id → reply count |
| `get_reply_ids(account_id, chat_id, message_id)` | `chat::get_reply_ids` | reply ids, oldest first |

Both scope replies and the quoted message to `chat_id`, so a Message-ID
that also exists in another chat cannot add to a count. No index or
migration is added: the scan runs over one chat's rows through the existing
`chat_id` index, and a `dbversion` bump in the vendored core would collide
with upstream migrations on the next re-vendor. Revisit with an
upstream-friendly index only if profiling shows a slow chat open.

Edit the queries only in `tools/apply-core-patches.py` (op ids
`#14 reply-thread queries (chat.rs|api.rs)`), then run `verify`,
`tree-check --fetch` and `self-test`.

## UI

- **Counts.** With the #14 core the counts are exact for the whole chat.
  Without it (older desktop sidecar, wasm builds without the op) they are
  counted over the loaded window and shown only when no older page is
  missing, so they never under-count.
- **Meta count** (phones, ≤600px): passive `N replies` text next to the
  timestamp, in the meta color (`--text-meta-in` / `--text-meta-out`).
  Not a tap target.
- **Side button** `.msg-thread-btn`: round 32px disc (reply icon + count)
  in a 44px hit box beside the bubble — right of incoming, left of
  outgoing — on desktop and mobile. `aria-label="Show N replies"`,
  keyboard focusable. Shown when the count reaches
  `THREAD_BUTTON_MIN_REPLIES` (chat-view.js; default 1).
- **Thread panel** `#thread-panel`: non-modal `role="dialog"` bottom sheet
  between the history and the composer, 70% of the chat view, own scroll.
  Header: "Thread · N replies", the quoted original (one line), close
  button. Body: parent, separator, replies (live-appended as they arrive).
  The history stays visible above; the composer stays below and is locked
  to the parent (quote re-locked after each send, quote-bar X hidden).
- **Closing:** close button, Escape (in the panel or the composer), chat
  switch, or deletion of the parent. Focus moves to the close button on
  open and back to the opener (side button, else the parent row) on close.
- Opened from the side button or the message menu's **Show replies**.
