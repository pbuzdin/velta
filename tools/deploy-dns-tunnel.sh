#!/usr/bin/env bash
# One-command DNS tunnel server (soar) for Velta's optional Android DNS tunnel.
# Run as root on a fresh Debian 12+/Ubuntu 22.04+ VPS. Idempotent: re-running
# upgrades the binary, keeps the existing key, and rewrites the unit.
#
#   sudo ./deploy-dns-tunnel.sh --zone t.example.com --ip 203.0.113.10 [--key <base64 private seed>]
#   sudo ./deploy-dns-tunnel.sh --uninstall
#
# Docs: docs/deploy-dns-tunnel.md. Never commit the zone, key or IP you use.
set -euo pipefail

SOAR_VERSION="${SOAR_VERSION:-v0.2.0}"   # must match velta-app/soar-tunnel/go.mod
GO_VERSION="${GO_VERSION:-1.25.3}"
PORTS="${PORTS:-443,465,993}"             # what Velta's core dials (IMAPS, SMTPS, 443)
PREFIX=/usr/local/bin
ETC=/etc/soar-server
UNIT=/etc/systemd/system/soar-server.service
RESOLVED_DROPIN=/etc/systemd/resolved.conf.d/soar-no-stub.conf

ZONE="" IP="" KEY="" UNINSTALL=0
usage() { sed -n '2,9p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --zone) ZONE="${2:-}"; shift 2 ;;
    --ip) IP="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now soar-server 2>/dev/null || true
  rm -f "$UNIT" "$PREFIX/soar-server"
  if [ -f "$RESOLVED_DROPIN" ]; then
    rm -f "$RESOLVED_DROPIN"
    systemctl restart systemd-resolved 2>/dev/null || true
  fi
  if command -v ufw >/dev/null 2>&1; then ufw delete allow 53/udp >/dev/null 2>&1 || true; fi
  systemctl daemon-reload
  echo "Removed. Key kept in $ETC (rm -rf $ETC to destroy it)."
  exit 0
fi

if [ -z "$ZONE" ] || [ -z "$IP" ]; then usage; fi
ZONE="${ZONE%.}"
case "$ZONE" in *.*) ;; *) echo "--zone needs at least two labels" >&2; exit 2 ;; esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl tar git dnsutils >/dev/null

# Go toolchain (distro Go is older than soar's go.mod requires).
arch="$(dpkg --print-architecture)"
case "$arch" in amd64|arm64) ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} "; then
  tmp="$(mktemp)"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o "$tmp"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tmp"
  rm -f "$tmp"
fi

# Build soar-server.
GOBIN="$PREFIX" GOPATH=/root/go GOCACHE=/root/.cache/go-build CGO_ENABLED=0 \
  /usr/local/go/bin/go install -trimpath "github.com/getlantern/soar/cmd/soar-server@${SOAR_VERSION}"

# Key: keep an existing one unless --key is given.
install -d -m 700 "$ETC"
if [ -n "$KEY" ]; then
  (umask 077; printf '%s\n' "$KEY" > "$ETC/key")
elif [ ! -s "$ETC/key" ]; then
  (umask 077; "$PREFIX/soar-server" keygen | awk '$1 == "private" { print $2 }' > "$ETC/key")
fi
chmod 600 "$ETC/key"
PUB="$("$PREFIX/soar-server" pubkey "$ETC/key")"

# systemd-resolved's stub listener holds 127.0.0.53:53; turn it off so :53 is free.
if systemctl is-active --quiet systemd-resolved; then
  install -d /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNSStubListener=no\n' > "$RESOLVED_DROPIN"
  systemctl restart systemd-resolved
  if [ -L /etc/resolv.conf ] && [ "$(readlink /etc/resolv.conf)" != "/run/systemd/resolve/resolv.conf" ]; then
    ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  fi
fi
if ss -Hlunp 'sport = :53' | grep -v soar-server | grep -q .; then
  echo "something else still listens on UDP 53:" >&2
  ss -lunp 'sport = :53' >&2
  exit 1
fi

cat > "$UNIT" <<UNITEOF
[Unit]
Description=soar DNS tunnel server (Velta)
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=2
DynamicUser=yes
LoadCredential=key:$ETC/key
ExecStart=$PREFIX/soar-server -zone $ZONE -key-file \${CREDENTIALS_DIRECTORY}/key -listen :53 -allow-ports $PORTS
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable soar-server >/dev/null
systemctl restart soar-server

# Firewall: open UDP 53 if a host firewall is active.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 53/udp >/dev/null
fi

sleep 1
systemctl is-active --quiet soar-server || { journalctl -u soar-server -n 30 --no-pager >&2; exit 1; }

cat <<OUT

soar-server is running on UDP 53 (ports allowed: $PORTS).

DNS records at the parent zone's provider (add both, then wait for the TTL):
  tns.${ZONE#*.}.   A    $IP
  $ZONE.          NS   tns.${ZONE#*.}.

Velta tunnel link (send it privately; never commit it):
  velta://tunnel?v=1&zone=$ZONE&key=$(printf '%s' "$PUB" | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g')

  zone: $ZONE
  key:  $PUB
OUT
