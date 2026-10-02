# Read receipts and message-state ticks (debugging narrative)

Written 2026-10-02 after issue #59 ("v1.4.52 broke a read indicator") and a
follow-up live-session investigation on a real account where ticks appeared
to be "stuck on single". Neither was a rendering bug — the facts below were
verified end-to-end against running real accounts via the raw page RPC.

## The lifecycle (who flips what, and when)

1. Sender's client sends; core advances the message through
   `OutPending(20) → OutDelivered(26)` — the relay accepted it. UI: single
   check. This is the LAST state chatmail guarantees to show.
2. The recipient's client calls `markseen_msgs` — in Velta, exclusively
   from the open-chat watermark (`chat-view _checkSeen` → `markReadSoon`):
   the lowest visible row marks the batch, debounced 400 ms.
3. The recipient's core sends an MDN back over the relay. The sender's core
   processes it and advances the message to `OutMdnRcvd(28)`. UI: double
   check. Observed relay round-trip between two local accounts: ~20 s
   (the receiving core must poll/fetch the MDN first).

Consequences that look like bugs and are not:

- **Notification direct-replies never produce an MDN.** Replying from the
  Android notification shade (or any flow that never opens the chat
  on-screen) does not run the watermark, so the sender's message stays at
  the single check no matter how active the peer is. This is exactly how a
  reply can exist while the replied-to message is still "unread".
- **Both sides must open each other's chat.** The sender watching their own
  tick does nothing; only the PEER's on-screen view moves it.
- **Self-talk / Saved messages never reach 28.** `markseen_msgs` ignores
  own messages, and there is no other party to send an MDN. Saved-messages
  sends rest at `OutDelivered` forever — correct.
- **The chat-list row tick is `summaryStatus` of the LAST message only.**
  A chat whose older messages are all read still shows a single tick while
  the newest message is undelivered/unread; opening the chat shows the
  per-message truth. The row is not stale — it just never summarizes
  history.
- **`InFresh(10)` vs `InSeen(16)`** is the peer-side mirror: a message seen
  10 in the peer's core means nobody ever viewed that chat — the sender's
  single tick is correct by definition.

## Diagnosing a "stuck tick" report

Never judge from the UI; the UI is a faithful mirror of the core state.
Work from the core outward:

1. Read the raw state: `get_message(accountId, msgId)` → `state`. 26 =
   delivered, no MDN yet; 28 = read, double tick must render (if it does
   not, then it is a UI bug — check `_mapState`/`ticksSvg`).
2. If 26 and the user insists the peer read it: find the peer side. The
   peer's copy of the message tells the truth — `state 10` (InFresh) means
   the peer's client never marked it seen, so no MDN can exist.
3. To prove the whole loop without a second device: accounts on the same
   desktop can stand in for both sides (see probe recipe below). Switching
   to the peer account in the UI and opening the chat fires the watermark;
   switching back, the sender's messages flip 26→28 within ~20 s.

## Raw RPC probe recipe (running desktop app)

Launch the app with WebView2 debugging
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9224`), then
`node cdp-eval.mjs '<js>'` (port 9224; adb squats 9223). From the page:

```js
const inv = window.__TAURI__.core.invoke;
const call = async (m, p) => (JSON.parse(await inv('rpc', {
  request: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p })
}))).result;
```

- `params` MUST be an array — even single args
  (`"takes an array of N arguments"` otherwise), and multi-arg methods take
  them positionally, exactly as `rpc-core.js` calls them (`get_message_ids`,
  `[accountId, chatId, false, false]`).
- Responses arrive wrapped (`{jsonrpc, id, result|error}`) — unwrap
  `.result`.
- Useful calls: `get_selected_account_id []`, `get_chatlist_entries
  [acc, null, null, null]`, `get_chatlist_items_by_entries [acc, ids]`
  (returns a MAP keyed by chat id, camelCase fields, `summaryStatus` is the
  numeric MessageState), `get_message [acc, id]`, `markseen_msgs [acc,
  [ids]]`, `select_account [acc]` (raw switching does not move the app UI;
  restore the original account when done).

## Asset/inspection gotchas learned in the same session

- `dc.db` is sqlcipher-encrypted; copying the file (+wal/shm) yields an
  unreadable DB. Use the RPC, not SQLite, for state inspection.
- The debug exe embeds `app/` at build time; a plain rebuild may keep old
  renderer assets (`generate_context!` does not reliably re-expand on
  asset-only changes). Hammer: `cargo clean -p velta-app` then rebuild, and
  verify with `fetch('js/mock-core.js', {cache:'reload'})` — the path is
  relative to the `tauri.localhost` root; `fetch('mock-core.js')` 404s and
  produces a FALSE "stale build" verdict (this cost us a needless
  clean-rebuild loop).
- `_decorate()` in mock-core returns a `structuredClone` — tests must read
  message state from `chat.messages`, not from the `sendMessage` return.

## Demo mode (#59, 1.4.53)

MockCore mirrors the same lifecycle: own sends rest at `delivered`; a 1:1
peer "fetches mail" a few seconds later and returns an MDN through the
normal `msg-state` event (knob: `core.mdnDelay()`); groups never get an
invented receipt. Fixture own messages in 1:1 chats read as `read`. Before
1.4.53 the demo produced NO MDN at all, so the double tick could never
appear — that was the actual #59 regression, demo-only.
