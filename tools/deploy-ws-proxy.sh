#!/usr/bin/env bash
# One-command WebSocket-to-TCP proxy for the Velta PWA (wasm core in the browser).
# Run as root on a fresh Debian 12+/Ubuntu 22.04+ VPS whose DNS name already
# points at it. Idempotent: re-running rewrites the bridge, unit and nginx site.
#
#   sudo ./deploy-ws-proxy.sh --domain ws.example.org --email admin@example.org \
#        --origin https://pwa.example.org --allow mail.example.org,relay.example.net \
#        [--ports 443,465,993] [--conn-limit 10] [--no-tls]
#   sudo ./deploy-ws-proxy.sh --uninstall
#
# Endpoints (what the PWA speaks):
#   wss://<domain>/dns/<host>        -> one text frame: JSON array of IPv4/IPv6, then close
#                                       ([] when <host> is not allowlisted)
#   wss://<domain>/tcp/<ip>/<port>   -> binary byte tunnel to <ip>:<port>; only IPs that an
#                                       allowlisted host resolves to, only --ports
# Docs: docs/deploy-pwa-websocket-proxy.md
set -euo pipefail

DOMAIN="" EMAIL="" ORIGINS="" ALLOW="" PORTS="443,465,993" CONN_LIMIT=10 TLS=1 UNINSTALL=0
LIB=/usr/local/lib/velta-ws-proxy
ETC=/etc/velta-ws-proxy
UNIT=/etc/systemd/system/velta-ws-proxy.service
SITE=/etc/nginx/sites-available/velta-ws-proxy.conf
LISTEN_PORT=8153

usage() { sed -n '2,16p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --origin) ORIGINS="${ORIGINS:+$ORIGINS }${2:-}"; shift 2 ;;
    --allow) ALLOW="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    --conn-limit) CONN_LIMIT="${2:-}"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

if [ "$UNINSTALL" -eq 1 ]; then
  rm -f /etc/nginx/sites-enabled/velta-ws-proxy.conf "$SITE" /etc/nginx/conf.d/velta-ws-proxy-maps.conf
  if command -v nginx >/dev/null 2>&1 && nginx -t 2>/dev/null; then systemctl reload nginx || true; fi
  systemctl disable --now velta-ws-proxy 2>/dev/null || true
  rm -rf "$UNIT" "$LIB" "$ETC"
  systemctl daemon-reload
  echo "Removed. nginx, certbot and the certificate are left in place."
  exit 0
fi

if [ -z "$DOMAIN" ] || [ -z "$ORIGINS" ] || [ -z "$ALLOW" ]; then usage; fi
[ "$TLS" -eq 0 ] || [ -n "$EMAIL" ] || { echo "--email is required for Let's Encrypt (or pass --no-tls)" >&2; exit 2; }
case "$CONN_LIMIT" in ''|*[!0-9]*) echo "--conn-limit must be a number" >&2; exit 2 ;; esac
for o in $ORIGINS; do
  case "$o" in https://*) ;; *) echo "origin must start with https:// ($o)" >&2; exit 2 ;; esac
  case "$o" in */) echo "origin must not end with / ($o)" >&2; exit 2 ;; esac
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
pkgs="nginx python3 python3-websockets"
[ "$TLS" -eq 0 ] || pkgs="$pkgs certbot python3-certbot-nginx"
# shellcheck disable=SC2086
apt-get install -y -qq $pkgs >/dev/null

# The proxy's own name is allowlisted too: the PWA's "WebSocket relays"
# probe asks /dns/<proxy-domain> and autopick measures /tcp/<its-ip>/443.
install -d -m 755 "$LIB" "$ETC"
cat > "$ETC/config" <<CFG
ALLOW_HOSTS=$DOMAIN,$ALLOW
ALLOW_PORTS=$PORTS
CFG

cat > "$LIB/bridge.py" <<'PY'
#!/usr/bin/env python3
"""WebSocket <-> TCP bridge for the Velta PWA. Not an open relay:
/dns/<host> answers only allowlisted hosts, /tcp/<ip>/<port> dials only
addresses those hosts resolve to, on allowlisted ports, never private ones."""
import asyncio, ipaddress, json, os, socket, sys
import websockets

ALLOW_HOSTS = {h.strip().lower().rstrip(".") for h in os.environ.get("ALLOW_HOSTS", "").split(",") if h.strip()}
ALLOW_PORTS = {int(p) for p in os.environ.get("ALLOW_PORTS", "443,465,993").split(",") if p.strip()}
MAX_CONNS = int(os.environ.get("MAX_CONNS", "500"))
IDLE = int(os.environ.get("IDLE_TIMEOUT", "900"))
active = 0


def public(ip):
    a = ipaddress.ip_address(ip)
    return a.is_global and not a.is_multicast


async def resolve(host):
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return []
    out = []
    for i in infos:
        ip = i[4][0]
        if public(ip) and ip not in out:
            out.append(ip)
    return out


async def allowed_ips():
    ips = set()
    for h in ALLOW_HOSTS:
        ips.update(await resolve(h))
    return ips


async def pipe_ws_to_tcp(ws, writer):
    async for msg in ws:
        writer.write(msg if isinstance(msg, bytes) else msg.encode())
        await writer.drain()
    writer.close()


async def pipe_tcp_to_ws(reader, ws):
    while True:
        data = await asyncio.wait_for(reader.read(65536), IDLE)
        if not data:
            break
        await ws.send(data)
    await ws.close()


async def handler(ws, path=None):
    global active
    if path is None:
        path = ws.request.path if hasattr(ws, "request") else ws.path
    parts = path.split("?")[0].strip("/").split("/")
    if len(parts) == 2 and parts[0] == "dns":
        host = parts[1].lower().rstrip(".")
        ips = await resolve(host) if host in ALLOW_HOSTS else []
        await ws.send(json.dumps(ips))
        await ws.close()
        return
    if len(parts) != 3 or parts[0] != "tcp" or not parts[2].isdigit():
        await ws.close(1008, "bad path")
        return
    ip, port = parts[1], int(parts[2])
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        await ws.close(1008, "not an IP")
        return
    if port not in ALLOW_PORTS or not public(ip) or ip not in await allowed_ips():
        await ws.close(1008, "target not allowed")
        return
    if active >= MAX_CONNS:
        await ws.close(1013, "busy")
        return
    active += 1
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), 10)
    except (OSError, asyncio.TimeoutError):
        active -= 1
        await ws.close(1011, "dial failed")
        return
    try:
        t1 = asyncio.ensure_future(pipe_ws_to_tcp(ws, writer))
        t2 = asyncio.ensure_future(pipe_tcp_to_ws(reader, ws))
        _, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    except Exception:
        pass
    finally:
        active -= 1
        writer.close()
        await ws.close()


async def main():
    if "--check" in sys.argv:
        print("allow hosts:", sorted(ALLOW_HOSTS), "ports:", sorted(ALLOW_PORTS))
        print("allowed IPs:", sorted(await allowed_ips()))
        return
    port = int(os.environ.get("LISTEN_PORT", "8153"))
    async with websockets.serve(handler, "127.0.0.1", port, max_size=2**20, ping_interval=30):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
PY
chmod 755 "$LIB/bridge.py"

cat > "$UNIT" <<UNITEOF
[Unit]
Description=Velta PWA WebSocket-to-TCP proxy
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ETC/config
Environment=LISTEN_PORT=$LISTEN_PORT
ExecStart=/usr/bin/python3 $LIB/bridge.py
Restart=always
RestartSec=2
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable velta-ws-proxy >/dev/null
systemctl restart velta-ws-proxy

# shellcheck disable=SC2016  # nginx variables, not shell
# nginx: origin allowlist + per-IP limits, TLS via certbot.
{
  echo 'map $http_origin $velta_ws_origin_ok {'
  echo '    default 0;'
  for o in $ORIGINS; do echo "    \"$o\" 1;"; done
  echo '}'
  echo 'limit_conn_zone $binary_remote_addr zone=velta_ws_conn:10m;'
  echo 'limit_req_zone $binary_remote_addr zone=velta_ws_req:10m rate=10r/s;'
} > /etc/nginx/conf.d/velta-ws-proxy-maps.conf

cat > "$SITE" <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location = / { return 204; }

    location ~ ^/(dns|tcp)/ {
        if (\$velta_ws_origin_ok = 0) { return 403; }
        limit_req zone=velta_ws_req burst=40 nodelay;
        limit_conn velta_ws_conn $CONN_LIMIT;
        proxy_pass http://127.0.0.1:$LISTEN_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
NGX
ln -sf "$SITE" /etc/nginx/sites-enabled/velta-ws-proxy.conf
nginx -t
systemctl reload nginx || systemctl restart nginx

if [ "$TLS" -eq 1 ]; then
  # --keep-until-expiring + --redirect: safe to re-run; certbot adds the 443 server block.
  certbot --nginx -n --agree-tos -m "$EMAIL" -d "$DOMAIN" --keep-until-expiring --redirect
  systemctl reload nginx
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

sleep 1
systemctl is-active --quiet velta-ws-proxy || { journalctl -u velta-ws-proxy -n 30 --no-pager >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. "$ETC/config"
set +a
python3 "$LIB/bridge.py" --check

scheme=wss; [ "$TLS" -eq 1 ] || scheme=ws
cat <<OUT

Proxy ready: $scheme://$DOMAIN
  allowed origins: $ORIGINS
  allowed hosts:   $ALLOW   ports: $PORTS
In the PWA: drawer -> WebSocket relays -> add "$DOMAIN" and select it,
or build the dist with: node scripts/build-pwa.mjs --ws-proxy $scheme://$DOMAIN
OUT
