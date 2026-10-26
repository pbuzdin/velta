#!/usr/bin/env bash
# One-command WebSocket-to-TCP proxy for the Velta PWA (wasm core in the browser).
# Run as root on a fresh Debian 12+/Ubuntu 22.04+ VPS whose DNS name already
# points at it. Idempotent: re-running rewrites the bridge, unit and nginx site.
#
#   sudo ./deploy-ws-proxy.sh --domain ws.example.org --email admin@example.org \
#        --origin https://pwa.example.org --allow mail.example.org,relay.example.net \
#        [--ports 443,465,993] [--conn-limit 10] [--no-tls] [--no-auth]
#   sudo ./deploy-ws-proxy.sh --uninstall
#   sudo ./deploy-ws-proxy.sh invite [NAME] [--expires 30d|2027-01-31] [--uses N] [--json]
#   sudo ./deploy-ws-proxy.sh invite --list [--json] | --revoke ID | --reset ID
#
# Invite links (on by default for new installs): every WebSocket must carry a
# token signed with the proxy's secret (/etc/velta-ws-proxy/secret), sent as
# the subprotocol "tok.<token>" next to "velta.v1". `invite` prints a
# velta://ws link with &t=<token> (and a QR when qrencode is installed);
# --revoke adds the invite id to /etc/velta-ws-proxy/revoked, which the bridge
# re-reads within seconds. --uses N caps the invite at N devices (each app
# install sends a random device id; the ids are kept in
# /var/lib/velta-ws-proxy/uses.json, --reset ID forgets them). --no-auth keeps the old open-to-allowed-origins
# mode; re-running over an install that predates invites keeps it open until
# you pass --auth.
#
# Endpoints (what the PWA speaks):
#   wss://<domain>/dns/<host>        -> one text frame: JSON array of IPv4/IPv6, then close
#                                       ([] when <host> is not allowlisted)
#   wss://<domain>/tcp/<ip>/<port>   -> binary byte tunnel to <ip>:<port>; only IPs that an
#                                       allowlisted host resolves to, only --ports
# Docs: docs/deploy-pwa-websocket-proxy.md
set -euo pipefail

DOMAIN="" EMAIL="" ORIGINS="" ALLOW="" PORTS="443,465,993" CONN_LIMIT=10 TLS=1 UNINSTALL=0 AUTH=""
LIB=/usr/local/lib/velta-ws-proxy
ETC=/etc/velta-ws-proxy
UNIT=/etc/systemd/system/velta-ws-proxy.service
SITE=/etc/nginx/sites-available/velta-ws-proxy.conf
LISTEN_PORT=8153
# StateDirectory of the DynamicUser unit (systemd keeps it in /var/lib/private).
STATE=/var/lib/velta-ws-proxy

usage() { sed -n '2,30p' "$0"; exit 2; }

# ---- invite subcommand: needs an installed proxy, touches only $ETC ----
if [ "${1:-}" = "invite" ]; then
  shift
  [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
  [ -f "$ETC/config" ] && [ -f "$LIB/bridge.py" ] || { echo "proxy not installed; run the deploy first" >&2; exit 1; }
  [ -s "$ETC/secret" ] || { echo "invite links are off on this proxy (installed with --no-auth); re-run the deploy with --auth" >&2; exit 1; }
  NAME="" EXPIRES="" USES="" MODE=mint REVOKE="" JSON=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --expires) EXPIRES="${2:-}"; shift 2 ;;
      --uses) USES="${2:-}"; shift 2 ;;
      --json) JSON=--json; shift ;;
      --list) MODE=list; shift ;;
      --reset) MODE=reset; REVOKE="${2:-}"; shift 2 ;;
      --revoke) MODE=revoke; REVOKE="${2:-}"; shift 2 ;;
      -h|--help) usage ;;
      -*) echo "unknown argument: $1" >&2; usage ;;
      *) NAME="$1"; shift ;;
    esac
  done
  set -a
  # shellcheck source=/dev/null
  . "$ETC/config"
  set +a
  case "$MODE" in
    list) exec python3 "$LIB/bridge.py" --list-invites $JSON --secret "$ETC/secret" --log "$ETC/invites.tsv" --revoked "$ETC/revoked" --uses-file "$STATE/uses.json" ;;
    reset)
      case "$REVOKE" in ''|*[!A-Za-z0-9]*) echo "--reset needs an invite id (see --list)" >&2; exit 2 ;; esac
      [ -d "$STATE" ] || { echo "no device has used an invite yet"; exit 0; }
      exec python3 "$LIB/bridge.py" --reset "$REVOKE" $JSON --uses-file "$STATE/uses.json" ;;
    revoke)
      case "$REVOKE" in ''|*[!A-Za-z0-9]*) echo "--revoke needs an invite id (see --list)" >&2; exit 2 ;; esac
      grep -qx "$REVOKE" "$ETC/revoked" 2>/dev/null || echo "$REVOKE" >> "$ETC/revoked"
      chmod 644 "$ETC/revoked"
      echo "Revoked $REVOKE. New connections with it are refused within a few seconds; tunnels already open stay up until they reconnect."
      exit 0 ;;
  esac
  case "$USES" in ''|*[!0-9]*) [ -z "$USES" ] || { echo "--uses must be a number of devices" >&2; exit 2; } ;; esac
  if [ -n "$JSON" ]; then
    exec python3 "$LIB/bridge.py" --mint --json --secret "$ETC/secret" --log "$ETC/invites.tsv" --name "$NAME" --expires "$EXPIRES" --uses "$USES" --url "$PUBLIC_URL"
  fi
  link=$(python3 "$LIB/bridge.py" --mint --secret "$ETC/secret" --log "$ETC/invites.tsv" --name "$NAME" --expires "$EXPIRES" --uses "$USES" --url "$PUBLIC_URL")
  echo "$link"
  if command -v qrencode >/dev/null 2>&1; then qrencode -t ansiutf8 "$link"; fi
  echo "Anyone with this link can use the proxy. Revoke with: $0 invite --revoke <id> (ids: $0 invite --list)" >&2
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --origin) ORIGINS="${ORIGINS:+$ORIGINS }${2:-}"; shift 2 ;;
    --allow) ALLOW="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    --conn-limit) CONN_LIMIT="${2:-}"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    --no-auth) AUTH=0; shift ;;
    --auth) AUTH=1; shift ;;
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
  rm -rf "$UNIT" "$LIB" "$ETC" "$STATE" /var/lib/private/velta-ws-proxy
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
# Auth default: on for new installs; an install from before invite links
# (config without AUTH=) stays open unless --auth is given.
if [ -z "$AUTH" ]; then
  if [ -f "$ETC/config" ] && ! grep -q '^AUTH=' "$ETC/config"; then
    AUTH=0; echo "note: existing install without invite links; keeping it open (pass --auth to require invites)" >&2
  elif [ -f "$ETC/config" ]; then AUTH=$(sed -n 's/^AUTH=//p' "$ETC/config"); else AUTH=1; fi
fi
scheme=wss; [ "$TLS" -eq 1 ] || scheme=ws
install -d -m 755 "$LIB" "$ETC"
if [ "$AUTH" = 1 ] && [ ! -s "$ETC/secret" ]; then
  (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$ETC/secret")
fi
[ -f "$ETC/revoked" ] || install -m 644 /dev/null "$ETC/revoked"
cat > "$ETC/config" <<CFG
ALLOW_HOSTS=$DOMAIN,$ALLOW
ALLOW_PORTS=$PORTS
AUTH=$AUTH
PUBLIC_URL=$scheme://$DOMAIN
REVOKED_FILE=$ETC/revoked
CFG

cat > "$LIB/bridge.py" <<'PY'
#!/usr/bin/env python3
"""WebSocket <-> TCP bridge for the Velta PWA. Not an open relay:
/dns/<host> answers only allowlisted hosts, /tcp/<ip>/<port> dials only
addresses those hosts resolve to, on allowlisted ports, never private ones.
With AUTH=1 every handshake must offer the subprotocol tok.<invite token>
(next to velta.v1); it is checked before anything is resolved or dialed.
An invite minted with --uses N ("u":N in the signed payload) admits at most
N distinct devices: each client offers dev.<random per-install id>, and the
ids seen per invite persist in $STATE_DIRECTORY/uses.json."""
import asyncio, base64, fcntl, hashlib, hmac, ipaddress, json, os, secrets, socket, sys, time
from http import HTTPStatus
import websockets

ALLOW_HOSTS = {h.strip().lower().rstrip(".") for h in os.environ.get("ALLOW_HOSTS", "").split(",") if h.strip()}
ALLOW_PORTS = {int(p) for p in os.environ.get("ALLOW_PORTS", "443,465,993").split(",") if p.strip()}
MAX_CONNS = int(os.environ.get("MAX_CONNS", "500"))
IDLE = int(os.environ.get("IDLE_TIMEOUT", "900"))
AUTH = os.environ.get("AUTH", "0") == "1"
REVOKED_FILE = os.environ.get("REVOKED_FILE", "")
USES_FILE = os.path.join(os.environ.get("STATE_DIRECTORY", "/var/lib/velta-ws-proxy").split(":")[0], "uses.json")
USES_MAX = 10000
SUBPROTOCOL = "velta.v1"
TOKEN_MAX = 1024
active = 0


# ---- invite tokens: b64url(json payload) "." b64url(HMAC-SHA256(secret, payload part)) ----
def b64e(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_secret(path=None):
    path = path or os.environ.get("SECRET_FILE") or os.path.join(os.environ.get("CREDENTIALS_DIRECTORY", "/nonexistent"), "secret")
    with open(path, "rb") as f:
        key = f.read().strip()
    if len(key) < 32:
        raise SystemExit("secret too short: " + path)
    return key


def mint(key, invite_id, name="", exp=0, uses=0):
    payload = {"v": 1, "i": invite_id}
    if name:
        payload["n"] = name
    if exp:
        payload["e"] = int(exp)
    if uses:
        payload["u"] = int(uses)
    body = b64e(json.dumps(payload, separators=(",", ":")).encode())
    return body + "." + b64e(hmac.new(key, body.encode(), hashlib.sha256).digest())


def verify(key, token, revoked=(), now=None):
    """Payload dict, or raises ValueError with a short reason."""
    if not token or len(token) > TOKEN_MAX or token.count(".") != 1:
        raise ValueError("malformed")
    body, sig = token.split(".")
    want = hmac.new(key, body.encode(), hashlib.sha256).digest()
    try:
        ok = hmac.compare_digest(b64d(sig), want)
        payload = json.loads(b64d(body)) if ok else None
    except (ValueError, TypeError):
        raise ValueError("malformed")
    if not ok:
        raise ValueError("bad signature")
    if not isinstance(payload, dict) or payload.get("v") != 1 or not isinstance(payload.get("i"), str):
        raise ValueError("malformed")
    u = payload.get("u")
    if u is not None and (type(u) is not int or not 1 <= u <= USES_MAX):
        raise ValueError("malformed")
    exp = payload.get("e")
    if exp and (time.time() if now is None else now) >= exp:
        raise ValueError("expired")
    if payload["i"] in revoked:
        raise ValueError("revoked")
    return payload


_revoked = {"mtime": None, "ids": frozenset(), "checked": 0.0}


def revoked_ids():
    """The revoked list, re-read when the file changes (checked every 2 s)."""
    now = time.monotonic()
    if REVOKED_FILE and now - _revoked["checked"] >= 2:
        _revoked["checked"] = now
        try:
            m = os.stat(REVOKED_FILE).st_mtime_ns
            if m != _revoked["mtime"]:
                with open(REVOKED_FILE) as f:
                    _revoked["ids"] = frozenset(l.strip() for l in f if l.strip() and not l.startswith("#"))
                _revoked["mtime"] = m
        except OSError:
            pass
    return _revoked["ids"]


def offered(header, prefix):
    for p in (header or "").split(","):
        p = p.strip()
        if p.startswith(prefix):
            return p[len(prefix):]
    return ""


def offered_token(header):
    return offered(header, "tok.")


def valid_device(d):
    return 16 <= len(d) <= 64 and all(c.isascii() and (c.isalnum() or c in "-_") for c in d)


# ---- device caps: {"v":1,"invites":{id:{"devices":{dev:first_seen}}}} ----
class Uses:
    """uses.json under an flock (shared with `invite --list/--reset`, which
    run as root), re-read when its mtime changes, replaced atomically."""

    def __init__(self, path):
        self.path, self.mtime, self.data = path, None, {"v": 1, "invites": {}}

    def __enter__(self):
        d = os.path.dirname(self.path)
        self.lock = open(os.path.join(d, "uses.lock"), "a")
        st = os.stat(d)
        if os.geteuid() == 0 and st.st_uid != 0:
            os.fchown(self.lock.fileno(), st.st_uid, st.st_gid)
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        try:
            m = os.stat(self.path).st_mtime_ns
            if m != self.mtime:
                with open(self.path) as f:
                    v = json.load(f)
                if isinstance(v, dict) and isinstance(v.get("invites"), dict):
                    self.data = v
                self.mtime = m
        except FileNotFoundError:
            self.data, self.mtime = {"v": 1, "invites": {}}, None
        except (OSError, ValueError):
            pass  # keep the last good copy; never admit beyond it
        return self

    def save(self):
        d = os.path.dirname(self.path)
        st = os.stat(d)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        if os.geteuid() == 0 and st.st_uid != 0:
            os.chown(tmp, st.st_uid, st.st_gid)  # root CLI: keep it the service's
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)
        self.mtime = os.stat(self.path).st_mtime_ns

    def __exit__(self, *a):
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()

    def devices(self, iid):
        e = self.data["invites"].get(iid)
        return e.get("devices", {}) if isinstance(e, dict) and isinstance(e.get("devices"), dict) else {}

    def admit(self, iid, dev, cap, now=None):
        devs = self.devices(iid)
        if dev in devs:
            return True
        if len(devs) >= cap:
            return False
        devs = dict(devs)
        devs[dev] = int(time.time() if now is None else now)
        self.data["invites"][iid] = {"devices": devs}
        self.save()
        return True


USES = None
LIMIT = "invite device limit reached"


def check_auth(headers):
    """None when allowed, else the refusal text. Never logs the token."""
    if not AUTH:
        return None
    proto = headers.get("Sec-WebSocket-Protocol")
    try:
        payload = verify(KEY, offered_token(proto), revoked_ids())
    except ValueError as e:
        return "invite " + str(e)
    cap = payload.get("u")
    if not cap:
        return None
    dev = offered(proto, "dev.")
    if not valid_device(dev):
        return "invite needs a device id (update the app)"
    try:
        with USES as u:
            return None if u.admit(payload["i"], dev, cap) else LIMIT
    except OSError:
        return "invite state unavailable"


def refusal(why):
    """(status, extra headers) for a refusal text."""
    if why == LIMIT:
        return HTTPStatus.FORBIDDEN, [("X-Velta-Refusal", "device-limit")]
    return HTTPStatus.UNAUTHORIZED, []


def process_request(*args):
    # websockets <= 12 legacy API: (path, headers); new API: (connection, request).
    if len(args) == 2 and hasattr(args[1], "headers"):
        conn, req = args
        why = check_auth(req.headers)
        if not why:
            return None
        status, extra = refusal(why)
        resp = conn.respond(status, why + "\n")
        for k, v in extra:
            resp.headers[k] = v
        return resp
    why = check_auth(args[1])
    if not why:
        return None
    status, extra = refusal(why)
    return (status, [("Content-Type", "text/plain")] + extra, (why + "\n").encode())


def select_subprotocol(a, b):
    # velta.v1 when offered, else none (never a refusal: clients without
    # invites send no subprotocol). Legacy API: (offered, available);
    # websockets >= 13: (connection, offered).
    offered = a if isinstance(a, (list, tuple)) else b
    return SUBPROTOCOL if SUBPROTOCOL in (offered or ()) else None


KEY = None


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


def parse_expiry(s, now=None):
    """'' -> 0 (never); '30d' / '12h' / '2027-01-31' -> unix time."""
    s = (s or "").strip()
    now = time.time() if now is None else now
    if not s:
        return 0
    if s[-1] in "dh" and s[:-1].isdigit():
        return int(now + int(s[:-1]) * (86400 if s[-1] == "d" else 3600))
    import datetime
    return int(datetime.datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp())


def arg(name, default=""):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def cli_invites():
    from urllib.parse import quote
    as_json = "--json" in sys.argv
    uses_file = arg("--uses-file", USES_FILE)
    log = arg("--log")
    if "--reset" in sys.argv:
        iid = arg("--reset")
        if not iid or not iid.isalnum():
            raise SystemExit("--reset needs an invite id")
        with Uses(uses_file) as u:
            n = len(u.devices(iid))
            u.data["invites"].pop(iid, None)
            u.save()
        print(json.dumps({"id": iid, "cleared": n}) if as_json else f"Reset {iid}: forgot {n} device(s).")
        return
    key = load_secret(arg("--secret"))
    if "--list-invites" in sys.argv:
        rev = set()
        try:
            rev = {l.strip() for l in open(arg("--revoked")) if l.strip()}
        except OSError:
            pass
        try:
            rows = [l.rstrip("\n").split("\t") for l in open(log) if l.strip()]
        except OSError:
            rows = []
        try:
            with Uses(uses_file) as u:
                seen = {i: dict(u.devices(i)) for i in u.data["invites"]}
        except OSError:
            seen = {}
        out = []
        for r in rows:
            iid, name, exp, cap = (r + ["", "", "0", "0"])[:4]
            exp, cap = int(exp or 0), int(cap or 0)
            st = "revoked" if iid in rev else ("expired" if exp and exp <= time.time() else "active")
            devs = seen.get(iid, {})
            out.append({"id": iid, "name": name, "expires": exp or None, "status": st, "uses": cap or None,
                        "used": len(devs), "devices": [{"id": d[:8], "first_seen": t} for d, t in sorted(devs.items(), key=lambda x: x[1])]})
        if as_json:
            print(json.dumps(out))
            return
        print("id\tname\texpires (UTC)\tstatus\tdevices")
        for o in out:
            when = time.strftime("%Y-%m-%d %H:%M", time.gmtime(o["expires"])) if o["expires"] else "never"
            used = f"{o['used']}/{o['uses']}" if o["uses"] else f"{o['used']}/unlimited"
            print(f"{o['id']}\t{o['name']}\t{when}\t{o['status']}\t{used}")
            for d in o["devices"]:
                print(f"  device {d['id']}…  first seen {time.strftime('%Y-%m-%d %H:%M', time.gmtime(d['first_seen']))} UTC")
        return
    name = "".join(c for c in arg("--name") if c.isprintable() and c not in "\t")[:64].strip()
    exp = parse_expiry(arg("--expires"))
    if exp and exp <= time.time():
        raise SystemExit("--expires is in the past")
    uses = arg("--uses")
    if uses and (not uses.isdigit() or not 1 <= int(uses) <= USES_MAX):
        raise SystemExit(f"--uses must be a number of devices, 1..{USES_MAX}")
    uses = int(uses or 0)
    iid = secrets.token_hex(6)
    tok = mint(key, iid, name, exp, uses)
    if log:
        with open(log, "a") as f:
            f.write(f"{iid}\t{name}\t{exp}" + (f"\t{uses}" if uses else "") + "\n")
        os.chmod(log, 0o600)
    url = arg("--url")
    link = "velta://ws?u=" + quote(url, safe="") + ("&n=" + quote(name, safe="") if name else "") + "&t=" + tok
    if as_json:
        print(json.dumps({"id": iid, "link": link, "token": tok, "name": name, "expires": exp or None, "uses": uses or None}))
        return
    print(link)
    print(f"invite id: {iid}", file=sys.stderr)


async def main():
    global KEY
    global USES
    if "--mint" in sys.argv or "--list-invites" in sys.argv or "--reset" in sys.argv:
        return cli_invites()
    if AUTH:
        KEY = load_secret()
        USES = Uses(USES_FILE)
    if "--check" in sys.argv:
        print("allow hosts:", sorted(ALLOW_HOSTS), "ports:", sorted(ALLOW_PORTS), "invites:", "required" if AUTH else "off")
        print("allowed IPs:", sorted(await allowed_ips()))
        return
    port = int(os.environ.get("LISTEN_PORT", "8153"))
    async with websockets.serve(handler, "127.0.0.1", port, max_size=2**20, ping_interval=30,
                                process_request=process_request, subprotocols=[SUBPROTOCOL],
                                select_subprotocol=select_subprotocol):
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
UNITEOF
# The secret reaches the DynamicUser service as a systemd credential.
if [ "$AUTH" = 1 ]; then
  printf 'LoadCredential=secret:%s/secret\nEnvironment=SECRET_FILE=%%d/secret\n' "$ETC" >> "$UNIT"
fi
cat >> "$UNIT" <<UNITEOF
ExecStart=/usr/bin/python3 $LIB/bridge.py
Restart=always
RestartSec=2
DynamicUser=yes
StateDirectory=velta-ws-proxy
StateDirectoryMode=0700
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
  # Apps (Android/Windows WebSocket transport) send no Origin; with invites
  # on, the bridge's token check is what admits them.
  [ "$AUTH" != 1 ] || echo '    "" 1;'
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
SECRET_FILE="$ETC/secret" python3 "$LIB/bridge.py" --check

cat <<OUT

Proxy ready: $scheme://$DOMAIN
  allowed origins: $ORIGINS
  allowed hosts:   $ALLOW   ports: $PORTS
  invite links:    $([ "$AUTH" = 1 ] && echo "required — create one with: $0 invite \"Name\" [--expires 30d]" || echo "off (--no-auth)")
In the PWA: drawer -> WebSocket relays -> add "$DOMAIN" and select it,
or build the dist with: node scripts/build-pwa.mjs --ws-proxy $scheme://$DOMAIN
OUT
