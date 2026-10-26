# Deploy a DNS tunnel server (one command)

Velta's optional DNS tunnel ([`agents/dns-tunnel.md`](agents/dns-tunnel.md))
needs a [soar](https://github.com/getlantern/soar) server that is the
authoritative name server for a delegated zone. `tools/deploy-dns-tunnel.sh`
installs it on a fresh Debian 12+ / Ubuntu 22.04+ VPS.

All names and addresses below are placeholders (`example.com`,
`203.0.113.10` from RFC 5737). Never commit your real zone, key or IP: they
are exactly what a censor needs to block the server.

## Platform support

| Platform | DNS tunnel |
|---|---|
| Android | **Yes.** CI builds `libsoartunnel.so` (`build-android.yml`), `tunnel.rs` loads it, the drawer shows the **DNS tunnel** row after a link is accepted. |
| Windows | **Yes.** CI cross-compiles `soartunnel.dll` (Go c-shared, mingw-w64) in the `tunnel-dll` job of `build-windows.yml` / `build-windows-cross.yml` and bundles it next to the sidecar; `tunnel.rs` loads it, takes the network's resolvers from the adapters (`GetAdaptersAddresses`) and sets the proxy on every profile over the sidecar's JSON-RPC. Open the link in Velta (the `velta://` scheme is registered by the installer) or paste it. |
| macOS / Linux desktop | **No** (not built yet). `tunnel_status` reports `unsupported`. `soar-socks` can be run by hand as a SOCKS5 proxy and set as the profile proxy (advanced). |
| Browser PWA | **No.** A browser cannot send raw UDP DNS, and the tunnel code is native. The PWA reaches mail through the WebSocket proxy instead ([`deploy-pwa-websocket-proxy.md`](deploy-pwa-websocket-proxy.md)). |

## 1. DNS records

Pick a short zone under a domain you control, e.g. `t.example.com`, and add
at the provider of `example.com`:

| Name | Type | Value |
|---|---|---|
| `tns.example.com.` | A | `203.0.113.10` (the VPS) |
| `t.example.com.` | NS | `tns.example.com.` |

The NS record delegates the zone; the A record is the glue that tells
resolvers where `tns.example.com` lives. Do not create other records under
`t.example.com`. A short zone leaves more room for data in each query.

## 2. One command

```sh
git clone https://github.com/pbuzdin/velta && cd velta
sudo tools/deploy-dns-tunnel.sh --zone t.example.com --ip 203.0.113.10
# reuse an existing server key (base64 32-byte seed, from `soar-server keygen`):
sudo tools/deploy-dns-tunnel.sh --zone t.example.com --ip 203.0.113.10 --key '<base64 private seed>'
```

What it does (safe to re-run; it keeps the key it generated):

1. Installs Go (from go.dev; distro Go is too old) and builds
   `soar-server` at the version pinned in `velta-app/soar-tunnel/go.mod`
   (`SOAR_VERSION=v0.2.0`; server and client must match).
2. Generates the key into `/etc/soar-server/key` (mode 600) unless one exists
   or `--key` is given.
3. Frees UDP 53: turns off the systemd-resolved stub listener
   (`/etc/systemd/resolved.conf.d/soar-no-stub.conf`) and points
   `/etc/resolv.conf` at the real upstream list. Aborts if anything else
   still listens on 53.
4. Writes `soar-server.service` (DynamicUser, only `CAP_NET_BIND_SERVICE`,
   key passed as a systemd credential) and allows destination ports
   `443,465,993` only. soar itself refuses private/loopback destinations.
5. Opens `53/udp` in ufw if ufw is active. With a cloud firewall
   (security group), open UDP 53 inbound there yourself.
6. Prints the DNS records, the public key and the `velta://tunnel` link.

Overrides: `SOAR_VERSION`, `GO_VERSION`, `PORTS` environment variables.

## 3. Verify

```sh
# on the server
systemctl status soar-server
ss -lunp 'sport = :53'                       # soar-server
journalctl -u soar-server -f                 # never logs the zone or key

# from anywhere: delegation is in place
dig +short NS t.example.com                  # tns.example.com.
dig +short A tns.example.com                 # 203.0.113.10
dig @203.0.113.10 x1.t.example.com TXT       # direct answer (NXDOMAIN/garbage is fine; a timeout is not)
dig x2$RANDOM.t.example.com TXT @8.8.8.8     # through a public resolver
# on the server, the second query should arrive:
tcpdump -lni any 'udp dst port 53'
```

Field-check resolvers in the target region with Globalping as in
[`agents/dns-tunnel.md`](agents/dns-tunnel.md#choosing-resolvers-field-check-with-globalping).

## 4. Add it in Velta (Android or Windows)

Send the printed link privately (QR code or message to yourself):

```
velta://tunnel?v=1&zone=t.example.com&key=<url-encoded public key>
```

Open it on the phone or Windows PC (or paste it in Velta) → confirm. The drawer then shows **DNS tunnel**;
the default mode **Auto** uses the tunnel only when relays are blocked.
Optional link parameters: `r=<ip:port,…>` extra resolvers (IP literals,
port 853 = DoT), `c=<host:port,…>` replacement canaries. Velta
Diagnostics shows "DNS tunnel:" lines; the tunnel sheet can share a report.

## Troubleshooting

| Symptom | Check |
|---|---|
| `address already in use` on start | `ss -lunp 'sport = :53'`; another DNS server (bind9, dnsmasq, resolved stub). Stop it and re-run. |
| `dig @203.0.113.10` times out | Cloud firewall / provider blocks inbound UDP 53; some providers need a ticket. |
| Direct query works, `@8.8.8.8` does not arrive | NS/glue wrong or not propagated: `dig +trace t.example.com NS`. |
| Server name resolution broken after install | `/etc/resolv.conf` should link to `/run/systemd/resolve/resolv.conf`. |
| Phone connects but mail never flows | Destination port not in `PORTS`; the relay uses a non-standard port. |
| Very slow, ~512 B answers | Android Private DNS is on; turn it off on the phone. |
| Windows: "DNS tunnel library not available" | `soartunnel.dll` is missing next to `deltachat-rpc-server.exe` in the install folder (a build without the `tunnel-dll` job); reinstall from a CI build. |
| Windows: no network resolvers in the report | No adapter is up with DNS servers; the tunnel still uses its built-in resolver list. |
| Client/server mismatch errors | Rebuild with the `SOAR_VERSION` from the app's `go.mod`. |

The server only listens on UDP; it does not answer DNS over TCP.

## Uninstall

```sh
sudo tools/deploy-dns-tunnel.sh --uninstall   # stops service, restores resolved stub, keeps key
sudo rm -rf /etc/soar-server                  # destroys the key (old links stop working)
```

Then remove the NS and A records, and the tunnel in Velta (DNS tunnel →
Remove).
