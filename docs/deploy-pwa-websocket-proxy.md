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
  small Python bridge behind nginx with Let's Encrypt, an origin
  allowlist, a target allowlist and rate limits.

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

What it installs (safe to re-run; it rewrites everything from the arguments):

- `/usr/local/lib/velta-ws-proxy/bridge.py` (python3-websockets), on
  `127.0.0.1:8153`, settings in `/etc/velta-ws-proxy/config`.
- `velta-ws-proxy.service` (DynamicUser, read-only system).
- nginx site `velta-ws-proxy.conf` plus `conf.d/velta-ws-proxy-maps.conf`:
  `Origin` allowlist, `limit_conn` per IP, `limit_req` 10 req/s (burst 40)
  per IP, 1 h idle timeout; certbot adds the 443 block and HTTP→HTTPS redirect.

**Not an open relay:** non-allowlisted hosts resolve to `[]`; `/tcp/`
closes with code 1008 for any IP that isn't a current address of an
allowlisted host, for private/loopback/reserved IPs, and for other ports;
the bridge caps total tunnels (`MAX_CONNS`, default 500).

To change the allowlist later, re-run the command with the new `--allow`,
or edit `/etc/velta-ws-proxy/config` and `systemctl restart velta-ws-proxy`.

## 3. Point the PWA at it

- **Per visitor:** drawer → **WebSocket relays** → add `ws.example.org` →
  select it (the page reloads). The app checks it with
  `/dns/ws.example.org`.
- **Baked in:** `node scripts/build-pwa.mjs --ws-proxy wss://ws.example.org`
  (see [`pwa-self-host.md`](pwa-self-host.md); keep that URL out of git).

New-account signup (`/cm-new/`) is not part of this proxy; use an
existing account or a relay that has the relay module.

## 4. Verify

```sh
systemctl status velta-ws-proxy
set -a; . /etc/velta-ws-proxy/config; set +a
python3 /usr/local/lib/velta-ws-proxy/bridge.py --check      # allowlist + resolved IPs

O='Origin: https://pwa.example.org'
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
