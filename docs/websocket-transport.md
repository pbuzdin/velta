# WebSocket transport (Android and Windows apps)

The PWA reaches IMAP/SMTP through a WebSocket byte-tunnel proxy
(`tools/deploy-ws-proxy.sh`, [deploy guide](deploy-pwa-websocket-proxy.md)).
The native Android and Windows apps can use the **same proxy** as a transport:
useful on networks where only web traffic (HTTPS on 443) gets through.

## How it works

```
core (IMAP/SMTP) ──SOCKS5──▶ 127.0.0.1:<random port>  (ws_transport.rs)
                                   │  CONNECT host:port
                                   ├─ wss://<proxy>/dns/<host>        → ["ip", …]  (cached 5 min)
                                   └─ wss://<proxy>/tcp/<ip>/<port>   ⇄ raw bytes (binary frames)
```

* `velta-app/src-tauri/src/ws_transport.rs` runs a small SOCKS5 server on a
  random loopback port (kept across restarts). SOCKS username/password is
  required (`velta-ws` + a random per-install password), so other local apps
  can't use it.
* Domain targets are resolved through the proxy's `/dns/` (the local DNS may
  be the thing that's blocked); IP targets go straight to `/tcp/`. Up to 4
  returned addresses are tried in order.
* WebSocket client: tokio + `tokio-rustls` (webpki roots, already in the
  lock — no new crates), RFC 6455 framing, masks from the OS RNG, pings
  answered. 15 s connect/handshake timeout, at most 64 concurrent
  connections (more are refused and the core retries), frames > 1 MiB
  rejected.
* Nothing about credentials or payload is logged; the log names only the
  proxy host and the local port. `velta://ws?…` links are logged redacted.
* Android and Windows share the module; the profile proxy is written by the
  DNS tunnel's proxy keeper (`tunnel.rs`, in-process core on Android,
  `sidecar_call` JSON-RPC on Windows). macOS/Linux: the commands answer
  "unsupported" and the UI says so. The PWA already uses WebSocket natively
  ("WebSocket relays" in the drawer); the native-only drawer row is hidden
  there.

## DNS tunnel vs WebSocket transport

Both point every profile's `proxy_url` at a local SOCKS5 port, so **only one
is in use at a time**:

* Turning on a WebSocket proxy (Use / Add and use / a link) stops the DNS
  tunnel (it stays saved).
* Starting a DNS tunnel turns the WebSocket transport off (it stays saved).
* If both were ever saved as active, the DNS tunnel wins at boot.
* The proxy keeper only touches a profile whose `proxy_url` is empty or one
  of ours (`socks5://velta-tunnel:` / `socks5://velta-ws:`). A proxy the
  user set up themselves always wins and is never overwritten, so turning
  either transport off restores the previous state: ours is cleared and
  `proxy_enabled` goes back to 0. After any change the account's IO is
  restarted and the core is told the network changed.
* Backups/transfers: the tunnel's detach logic (`tunnel_backup_begin/end`)
  covers both, so a backup never carries the 127.0.0.1 port.

## Settings

Drawer → **WebSocket transport: <name|Off>** (`app/js/ws-transport.js`):
saved proxies (URL + optional name), Use/Stop, **Test** (asks the proxy's
`/dns/` for the profile's IMAP host — `configured_mail_server`, else the
address's domain), Share (link), Delete (confirmed), and an add form.

URLs are validated strictly (JS and Rust agree): `wss://host[:port][/path]`,
no credentials, query or fragment; a bare host means `wss://`. Plain `ws://`
is accepted only for a loopback proxy (local testing).

## Share link

```
velta://ws?u=wss%3A%2F%2Fproxy.example.org&n=Office
```

Only `u` (required) and `n` (name, ≤ 64 chars), each once, ≤ 1024 chars.
Opening or scanning it shows a confirm dialog warning that all chat traffic
goes through that server (same as tunnel links). Android claims
`velta://ws` in the manifest; desktop uses the existing `velta` scheme.

## Tests

* JS: `tests/ws-transport.test.mjs` (validation, link round-trip, list
  HTML escaping/labels, actions, confirm flow, platform notes).
* Rust (`cargo test --lib ws_transport`): URL building, SOCKS5 parsing,
  framing/accept key, store, and `socks_through_local_bridge`, which
  extracts the bridge from `tools/deploy-ws-proxy.sh`, runs it on 127.0.0.1
  (loopback allowed for the test only, one allowlisted name and the echo
  port) and pipes 100 KB through the SOCKS5 server by name and by IP, plus
  wrong-password and disallowed-port cases. Skipped if `python3` +
  `websockets` are missing.

## Needs device testing

* Android: Doze/background — the server runs on the app's tokio runtime like
  the DNS tunnel; check IMAP IDLE survives long idle periods (the bridge has
  a 900 s idle timeout and pings every 30 s).
* Windows: sidecar restart picks the proxy back up (the keeper re-applies
  every minute).
* Network switches: open sockets drop with the WebSocket; the core
  reconnects. `/dns/` answers are cached 5 minutes.
