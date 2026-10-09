# WS relay endpoints probe — chatmail.uk `/ygg-ws` (2026-10-09)

Question: can the Velta PWA use `wss://chatmail.uk:443/ygg-ws` (server
`201:9b0a:8dca:2be0:f2c0:4313:b8d3:a23d` = the relay's Yggdrasil address)?

## Verdict: no — it's a Yggdrasil peering link, not a mail tunnel

Probed from this box (node 26 global WebSocket, `probe-chatmail-uk.mjs` in
the workspace root):

- Without a subprotocol the server closes with `1008 "client must speak the
  ygg-ws subprotocol"`.
- With subprotocol `ygg-ws` the socket opens and the server immediately
  pushes a binary `meta\0…` frame (Yggdrasil link-protocol handshake:
  version/pubkey fields), then rejects TEXT frames with `1003 "unexpected
  frame type read (expected MessageBinary): MessageText"`. Binary-only.
  Matches yggdrasil-go's `wss://` peering transport (v0.5.7+): this is a
  node-to-node overlay link — routers join the Yggdrasil network here; chat
  clients do not tunnel mail through it.
- Velta's C3 contract (`{base}/tcp/{host}/{port}` raw byte tunnel +
  `{base}/dns/{host}`, TLS terminating inside wasm — wasm-patches 0007
  `net/ws_tcp.rs`) was probed anyway: `…/ygg-ws/tcp/[201:…]/993`, `/143`
  and `…/ygg-ws/dns/chatmail.uk` all die instantly (1006). Root-base
  `/tcp/…` also 1006.
- PWA-side limitation regardless: `normalizeHost` (`app/js/ws-relays.js`)
  strips path and port — relay entries are bare hosts, so the client would
  dial `wss://chatmail.uk/tcp/…` at root.
- A browser cannot join Yggdrasil at all (needs a tun/yggdrasil-go runtime).

## Working paths

1. chatmail.uk runs a C3-style websockify at root (`/tcp/{host}/{port}` +
   `/dns/{host}`) → PWA users just add `chatmail.uk`.
2. We bridge: the private relay joins Yggdrasil by peering over
   `wss://chatmail.uk:443/ygg-ws` (exactly what the endpoint is for), then
   the relay's C3 proxy routes `201:9b0a:…:993/465` over `ygg0`. PWA users
   keep adding the relay domain they already use;
   chatmail.uk's real IP never appears in any client artifact. Also a
   censorship-resistant path (Yggdrasil rides reachable transports).
   Open question: whether chatmail.uk's ygg node exposes 993/465 on its
   overlay address — verify from the relay once it has a ygg interface.
