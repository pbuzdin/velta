# Deploy the PWA WebSocket-to-TCP proxy (one command)

The browser PWA runs the wasm chatmail core in the tab. Browsers can't open
TCP sockets, so the core talks to IMAP/SMTP through a WebSocket byte tunnel:

| Endpoint | Behaviour |
|---|---|
| `wss://<proxy>/dns/<host>` | one text frame, a JSON array of IPs, then close. `[]` = this proxy won't dial that host. |
| `wss://<proxy>/tcp/<ip>/<port>` | binary bytes to `<ip>:<port>`. TLS to the mail server runs inside, end to end in wasm: the proxy never sees plaintext mail. |

Two ways to get one:

- **On a chatmail relay** (the proxy serves its own mail and can dial
  other relays): the relay-fork module in
  [`relay-modules.md`](relay-modules.md#websocket-proxy).
- **Standalone box** (this page): `tools/deploy-ws-proxy.sh` installs a
  small Python bridge behind nginx with Let's Encrypt, invite links, an
  origin allowlist, a target allowlist and rate limits.

All names below are placeholders (`ws.example.org`, `pwa.example.org`,
`mail.example.org`).

## 1. Prerequisites

- Debian 12+ / Ubuntu 22.04+ VPS, ports 80 and 443 reachable.
- An A/AAAA record `ws.example.org` → the VPS (needed for the certificate).
- The PWA origin (`https://pwa.example.org`), see
  [`pwa-self-host.md`](pwa-self-host.md).
- The mail servers the PWA users' accounts live on (`mail.example.org`, …).

## 2. One command

```sh
git clone https://github.com/pbuzdin/velta && cd velta
sudo tools/deploy-ws-proxy.sh \
  --domain ws.example.org --email admin@example.org \
  --origin https://pwa.example.org \
  --allow mail.example.org,relay.example.net
```

| Option | Meaning |
|---|---|
| `--domain` | proxy hostname (certificate name) |
| `--email` | Let's Encrypt account email |
| `--origin` | allowed browser origin; repeat for several. Other origins get 403. |
| `--allow` | comma list of mail hosts. `/dns/` answers only these (plus the proxy's own name, which the PWA's relay probe needs); `/tcp/` dials only IPs they resolve to. |
| `--ports` | allowed destination ports, default `443,465,993` (IMAPS, SMTPS, 443 speed probe) |
| `--conn-limit` | concurrent WebSockets per client IP, default 10 |
| `--no-tls` | skip certbot (TLS terminated by something in front) |
| `--no-auth` | no invite links: anyone on an allowed origin can use the proxy (the old behaviour) |
| `--auth` | turn invite links on for an install that predates them |

What it installs (safe to re-run; it rewrites everything from the arguments):

- `/usr/local/lib/velta-ws-proxy/bridge.py` (python3-websockets), on
  `127.0.0.1:8153`, settings in `/etc/velta-ws-proxy/config`.
- `velta-ws-proxy.service` (DynamicUser, read-only system). With invites
  on, the signing key `/etc/velta-ws-proxy/secret` (root, 0600, generated
  once, kept across re-runs) reaches the service as a systemd credential.
- nginx site `velta-ws-proxy.conf` plus `conf.d/velta-ws-proxy-maps.conf`:
  `Origin` allowlist, `limit_conn` per IP, `limit_req` 10 req/s (burst 40)
  per IP, 1 h idle timeout; certbot adds the 443 block and HTTP→HTTPS redirect.

**Not an open relay:** non-allowlisted hosts resolve to `[]`; `/tcp/`
closes with code 1008 for any IP that isn't a current address of an
allowlisted host, for private/loopback/reserved IPs, and for other ports;
the bridge caps total tunnels (`MAX_CONNS`, default 500).

To change the allowlist later, re-run the command with the new `--allow`,
or edit `/etc/velta-ws-proxy/config` and `systemctl restart velta-ws-proxy`.

## 3. Invite links

New installs require an invite on every WebSocket. Mint one per person or
device:

```sh
sudo tools/deploy-ws-proxy.sh invite "Mum's phone" --expires 90d
# velta://ws?u=wss%3A%2F%2Fws.example.org&n=Mum's%20phone&t=eyJ2Ijox….Qk3x…
# (+ a terminal QR code when qrencode is installed: apt install qrencode)
sudo tools/deploy-ws-proxy.sh invite "Family" --uses 4  # at most 4 devices
sudo tools/deploy-ws-proxy.sh invite --list             # id, name, expiry, status, devices used/limit
sudo tools/deploy-ws-proxy.sh invite --revoke 3f9c0a1b2d4e
sudo tools/deploy-ws-proxy.sh invite --reset 3f9c0a1b2d4e  # forget its devices (frees the slots)
```

- The token is `base64url(payload) "." base64url(HMAC-SHA256(secret, payload))`;
  the payload is `{"v":1,"i":<invite id>,"n":<name>,"e":<expiry, unix s>,"u":<max devices>}`
  (`n`, `e`, `u` optional; `u` is an integer 1..10000). `--expires` takes `30d`, `12h` or `2027-01-31` (UTC);
  without it the invite never expires.
- The bridge checks it during the WebSocket handshake, before it resolves
  or dials anything, and answers **401** for a missing, malformed, forged,
  expired or revoked token. The token is never logged.
- Clients send it as the subprotocol pair `velta.v1, tok.<token>`
  (`Sec-WebSocket-Protocol`). Browsers can't set other headers on a
  WebSocket, and unlike a `?t=` query it stays out of nginx access logs.
- `--revoke` appends the id to `/etc/velta-ws-proxy/revoked`; the bridge
  re-reads that file within ~2 s, so new connections are refused at once.
  Tunnels that are already open stay up until they reconnect.
- `--uses N` signs `"u":N` into the payload, so the cap can't be raised
  without the secret. A *use* is a **device** (an app install or a
  browser profile), not a connection: apps open many sockets and
  reconnect all the time. See [Device caps](#device-caps-uses-n).
- `invites.tsv` is a local log of minted ids for `--list`; tokens can't be
  recovered from it. Rotating `secret` (delete it, re-run the deploy)
  invalidates every invite at once.
- With invites on, nginx also admits requests **without** an `Origin`
  header (the Android/Windows apps send none); the token is what admits
  them. Browsers always send `Origin`, so the origin allowlist still gates
  web pages.

Anyone holding a link can use the proxy until it expires or is revoked
(or, with `--uses`, until its device slots are taken): send it privately.

### Device caps (`--uses N`)

- Clients offer a third subprotocol, `dev.<id>`: a random per-install id
  (16–64 chars of `A-Za-z0-9_-`; the apps use 22, i.e. 128 bits) that is
  different for every proxy. The Android/Windows app keeps it in
  `ws_transport.json` (`devices`, keyed by proxy URL, so deleting and
  re-adding the proxy is the same device); the PWA in `localStorage`
  (`velta-ws-devices`, keyed by host). It is only sent together with a token.
- For a capped invite the bridge admits a device id it has already seen for
  that invite, admits a new one while fewer than N are recorded, and
  otherwise answers **403** with header `X-Velta-Refusal: device-limit`
  (the app says "This invite has reached its device limit"). A capped
  invite offered **without** a device id (an app from before device caps)
  gets **401**: counting connections instead would lock real users out,
  and admitting them would make the cap meaningless. Uncapped invites
  ignore device ids, so old links and old apps keep working as before.
- State: `/var/lib/velta-ws-proxy/uses.json` (systemd `StateDirectory`,
  owned by the service's dynamic user, 0700), shape
  `{"v":1,"invites":{"<id>":{"devices":{"<device id>":<first seen, unix s>}}}}`.
  Read-modify-write runs under `flock` on `uses.lock`, the file is replaced
  atomically (write + fsync + rename) and survives restarts; the bridge
  re-reads it when its mtime changes, so `--reset` applies at once.
  Revoking an invite doesn't clear its devices (`--reset` does).
- A browser's site-data wipe or an app reinstall is a new device; use
  `--reset ID` (forgets all devices of that invite) or mint a new link.
- Old proxies ignore `dev.` and `u`, so new apps work against them unchanged.

### Scripting (Veltar bot and other tools)

`invite` takes `--json` for machine-readable output (one JSON document on
stdout, nothing else); the same calls work on `bridge.py` directly:

```sh
sudo tools/deploy-ws-proxy.sh invite "Ann" --expires 30d --uses 2 --json
# {"id":"3f9c0a1b2d4e","link":"velta://ws?u=…&n=Ann&t=…","token":"…","name":"Ann","expires":1798761600,"uses":2}
sudo tools/deploy-ws-proxy.sh invite --list --json
# [{"id":"3f9c0a1b2d4e","name":"Ann","expires":1798761600,"status":"active","uses":2,"used":1,
#   "devices":[{"id":"Q2xvdWRz","first_seen":1796200000}]}]     (uses null = unlimited; device ids shortened to 8 chars)
sudo tools/deploy-ws-proxy.sh invite --reset 3f9c0a1b2d4e --json   # {"id":"3f9c0a1b2d4e","cleared":1}
sudo tools/deploy-ws-proxy.sh invite --revoke 3f9c0a1b2d4e
```

Compatibility rules for anything that mints or parses tokens: keep `v` at
1, add only optional keys, ignore unknown ones; a verifier that doesn't know
`u` must not be used with capped invites (it would admit unlimited devices).
`invites.tsv` lines are `id<TAB>name<TAB>expiry[<TAB>uses]`.

## 4. Point the PWA at it

- **Invite link (proxy with invites on):** open or scan the `velta://ws`
  link in the PWA; after a confirm it adds the proxy to **WebSocket relays**
  with its token, selects it and reloads. The token is kept in this
  browser's `localStorage` (`velta-ws-relay-tokens`) and offered as a
  subprotocol on every socket to that proxy (`installWsInvite` in
  `worker-wasm.js`; the wasm core itself is unchanged).
- **Per visitor, no invites:** drawer → **WebSocket relays** → add
  `ws.example.org` → select it (the page reloads). The app checks it with
  `/dns/ws.example.org`.
- **Baked in:** `node scripts/build-pwa.mjs --ws-proxy wss://ws.example.org`
  (see [`pwa-self-host.md`](pwa-self-host.md); keep that URL out of git).

New-account signup (`/cm-new/`) is not part of this proxy; use an
existing account or a relay that has the relay module.

The Android and Windows apps can use the same proxy as a native transport —
see [websocket-transport.md](websocket-transport.md).

## 5. Verify

```sh
systemctl status velta-ws-proxy
set -a; . /etc/velta-ws-proxy/config; set +a
SECRET_FILE=/etc/velta-ws-proxy/secret python3 /usr/local/lib/velta-ws-proxy/bridge.py --check   # allowlist + resolved IPs

O='Origin: https://pwa.example.org'
# With invites on, add the token from an invite link to every websocat call:
#   T=$(sudo tools/deploy-ws-proxy.sh invite test --expires 1h | sed -n 's/.*&t=//p' | head -1)
#   websocat --protocol "velta.v1, tok.$T" …   (without it: 401)
websocat -1 -H "$O" wss://ws.example.org/dns/mail.example.org   # ["198.51.100.7", …]
websocat -1 -H "$O" wss://ws.example.org/dns/other.example      # []
websocat -1 -H 'Origin: https://evil.example' wss://ws.example.org/dns/mail.example.org  # 403
# raw TLS through the tunnel (expect a certificate dump):
websocat -b -H "$O" tcp-l:127.0.0.1:9993 wss://ws.example.org/tcp/198.51.100.7/993 &
openssl s_client -connect 127.0.0.1:9993 -servername mail.example.org </dev/null | head
websocat -1 -H "$O" wss://ws.example.org/tcp/10.0.0.1/993       # closes, code 1008
```

Then sign in on the PWA and send a message.

## Troubleshooting

| Symptom | Check |
|---|---|
| Relay shows as not capable in the PWA | Wrong origin (exact scheme+host, no trailing slash): `grep -A5 map /etc/nginx/conf.d/velta-ws-proxy-maps.conf`. |
| `/dns/<host>` returns `[]` | Host not in `--allow`, or it resolves only to private IPs. |
| `/tcp/` closes with 1008 | IP is not a current address of an allowed host (DNS changed? `--check`), or port not allowed. |
| 401 / "the proxy refused the invite" in the app | Token missing, expired or revoked (`invite --list`), or `secret` was regenerated. Mint a new link. |
| Android/Windows app gets 403 | Invites are off (`--no-auth`), so nginx requires an allowed `Origin`, which apps don't send. Turn invites on (`--auth`). |
| 502 from nginx | Bridge down: `journalctl -u velta-ws-proxy -n 50`. |
| 503 / connections refused under load | `limit_conn`/`limit_req` hit; raise `--conn-limit` or the rate in the maps file. |
| certbot fails | DNS for `--domain` not pointing here yet, or port 80 closed. |
| Chrome logs code 1005 | The wasm client closed without a code; not a failure. |

## Uninstall

```sh
sudo tools/deploy-ws-proxy.sh --uninstall
```

Removes the bridge, unit and nginx site; nginx, certbot and the certificate
stay (`certbot delete --cert-name ws.example.org` to drop it).
