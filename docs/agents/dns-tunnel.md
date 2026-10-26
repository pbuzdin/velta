# Optional DNS tunnel — agent notes

Velta on Android and Windows can reach the relays over a
[soar](https://github.com/getlantern/soar) DNS tunnel when the mobile network
only lets allowlisted sites through (allowlist-only mobile internet in
restrictive areas). Off by default: nothing runs until the user accepts a
tunnel link.

## Pieces

| Where | What |
|---|---|
| `velta-app/soar-tunnel/tunnel` | Go: link parsing, SOCKS5 server (user/pass), DIRECT/TUNNEL router, allowlist monitor, event ring |
| `velta-app/soar-tunnel/cmd/libsoartunnel` | C ABI (`-buildmode=c-shared`) the shell dlopens |
| `velta-app/soar-tunnel/cmd/soar-socks` | Same router as a standalone SOCKS5 proxy (Linux/macOS/Termux): `-link-file`, machine DNS from resolv.conf as first paths (`-system-dns`), `-operator`, `-paths` |
| `gen/android/.../org/velta/NetInfo.kt` | Network-assigned DNS servers, SIM MCC+MNC, transport, Private DNS state |
| `velta-app/src-tauri/src/tunnel.rs` | Loads the library, keeps the saved tunnels in `tunnels.json` (list logic + `tunnel.json` migration in `tunnel_store.rs`, unit-tested), sets `proxy_url` on every profile, Tauri commands (Android + Windows; macOS/Linux stubs report `unsupported`) |
| `velta-app/src-tauri/src/tunnel_android.rs` | Android platform: `libsoartunnel.so`, NetInfo.kt, in-process accounts |
| `velta-app/src-tauri/src/tunnel_windows.rs` | Windows platform: `soartunnel.dll` from the bundle resources, adapters' DNS (`GetAdaptersAddresses`), accounts via JSON-RPC to the sidecar (`sidecar_call` in lib.rs). A macOS port = one more such module + a dylib build |
| `app/js/tunnel.js` | Deep link confirm (Add and use / Add / Cancel, duplicate → use), drawer row + settings sheet with the saved-tunnel list, diagnostics share |
| `.github/workflows/build-android.yml` | Builds `libsoartunnel.so` into `gen/android/app/src/main/soarLibs` (gradle `jniLibs.srcDir`) |
| `.github/workflows/build-windows*.yml` | `tunnel-dll` job: cross-compiles `soartunnel.dll` on Ubuntu (cgo + mingw-w64, `-extldflags=-static`), the installer job bundles it as a resource (`tauri.conf.json`) |

## Configuration never lives in the repo

The tunnel zone and server key arrive in a link, accepted by the user:

```
velta://tunnel?v=1&zone=<tunnel-zone>&key=<base64 ed25519 pubkey>[&r=<ip:port,…>][&c=<host:port,…>]
```

`r` adds resolvers to the defaults (IP literals only; port 853 =
DNS-over-TLS) — it never replaces them, so better defaults in an app update
reach tunnels installed earlier; `c` replaces the allowlist canaries.

Paths in order: the resolvers the phone's current network handed out
(`NetInfo.kt`: the operator's DNS on mobile data, the one that keeps
answering under an allowlist), then the SIM operator's known resolvers by
MCC+MNC (`tunnel/operators.go`), then the link's `r`, then the defaults.
Before handing the list to soar the tunnel drops private-address resolvers
(RFC 1918, CGNAT, ULA) that the current network did not hand out — operator
internal resolvers only answer on their own network, where they arrive as
the network's DNS anyway — drops IPv6 resolvers when there is no IPv6 route,
and moves IPv6 after IPv4: soar sends its first hellos down the first paths,
and a 464XLAT mobile network was seen with an IPv6 route but no working IPv6
DNS. `tunnel.rs` restarts the tunnel when the network's resolvers or the operator
change (checked every minute and on `tunnel_network_changed`). Defaults are public resolvers (NSDI, MSK-IX,
Yandex basic/Safe/Family incl. IPv6 and DoT, SafeDNS, Google, Quad9) and
canaries `ya.ru`, `max.ru`, `gosuslugi.ru`. Like `dcbackup:`, a tunnel link can come from any
page, so it is applied only after `confirmModal`. Without a link nothing
starts and the app is upstream Velta. The shell never logs the link.

Public-repo hygiene (§6.6) applies to the tunnel server too: never commit its
zone, key, IP or hostnames; docs and tests use `t.example.org`.

## Routing

The core always talks to `socks5://velta-tunnel:<random>@127.0.0.1:<port>`;
the router decides per connection:

- **auto** (default): DIRECT while a relay answers; a failed direct dial
  falls back to the tunnel for that connection. The monitor probes the
  relays the core used and the canaries over real TLS (a TCP connect proves
  nothing behind fake-IP VPNs or SYN-passing allowlists), on the port the core
used when it starts with TLS (993, 465, 443) and on 443 for STARTTLS ports. All relays failing
  while any canary answers twice in a row = blocked → TUNNEL; a relay
  answering directly three times = back to DIRECT; nothing answering =
  offline, no change. Before that switch the same relays are TLS-probed
  through the tunnel: if a live soar session can't reach any of them
  either, they are down, not blocked (one profile with one dead relay
  looks exactly like an allowlist), so the route stays DIRECT with state
  `relays-down`, rechecked every minute. Without a live session the
  check proves nothing and the switch goes ahead. A route switch closes the old route's connections so
  the core reconnects at once.
- **always**: fixed route through the tunnel.
- **off** (1.4.85, #175): really off. The tunnel library is stopped and our
  local SOCKS proxy is removed from every profile, so the core dials
  directly. Before, Off only switched routing: the local proxy stayed on
  every profile, and once it died a send stalled ~60 s and the IO restart
  that followed blocked chat switching. Boot skips a tunnel whose mode is
  Off, and the 60 s proxy keeper removes a stale `socks5://velta-tunnel:`
  value, which repairs already-affected installs on the next start.

Switching `proxy_enabled` in the core instead was rejected: it restarts the
IO scheduler on every flip and can't fall back per connection.

`tunnel.rs` writes `proxy_url` only when a profile has none or has ours
(prefix `socks5://velta-tunnel:`); a proxy the user set wins. A 60 s loop
re-applies it so profiles added later pick it up. Removing the tunnel clears
only our value. A bare connect-and-close (the liveness probe) no longer logs
`socks: EOF` in the Go tunnel.

## DNS interception

Some networks redirect all port-53 traffic to one resolver (seen: a home
router forwarding everything to NextDNS, another to China's 114DNS — every
"path" then showed the same ~450 ms RTT and died after a few answers). At
start the tunnel sends an A query to two RFC 5737 TEST-NET addresses
(`interceptProbeTargets`, 0.8 s): no DNS server lives there, so any answer
was forged on the way. Then DoT paths go first (they are the only real
paths), Diagnostics says so, `whoami.akamai.net` via 77.88.8.8 names the
resolver that really answers, and the status carries `dns_intercepted` /
`dns_egress` for the report and a warning in the settings sheet.

## Diagnostics chat

Tunnel events show up in Velta Diagnostics with a "DNS tunnel:" prefix.
Router events come from the Go event ring; shell events (start, proxy set
per profile, restart on network change, errors) from a 100-line ring in
tunnel.rs (`SHELL_EVENTS`, returned as `shell_events` by tunnel_status), so
lines logged while the WebView sleeps are not lost. `initTunnelDiagnostics`
(tunnel.js) polls every 20 s, on resume and on the `velta-tunnel-log` wake-up
event, and appends only events newer than a high-water mark kept in
localStorage (no repeats after a UI reload).

## Known limits

- The core puts a 60 s read/write timeout on every socket, proxied ones
  included (`core/src/net.rs` `TIMEOUT`). A tunnel path that stalls longer
  kills that IMAP FETCH or SMTP DATA; the core retries on a new connection.
- Encrypted attachments over 140 KB travel as a separate post-message
  (`PRE_MSG_ATTACHMENT_SIZE_THRESHOLD`, core/src/download.rs). If its fetch
  fails, the chat shows the "Downloading… / Tap to download" card, not an
  image. "Couldn't load image" is different: the core has the file
  (`downloadState Done` + `filePath`) and the WebView failed to load it — a
  media-path problem, not a transport one (chat-view.js renders `<img>` only
  for downloaded files).
- A route switch closes the old route's connections on purpose; the monitor's
  hysteresis (2 blocked / 3 recovered probes) keeps that rare.

## soar dependency (path stats)

`go.mod` requires `github.com/getlantern/soar` v0.2.0, the first release with
`Client.PathStats()`, `Client.Established()` and `Config.StreamOnly`
(port-853 resolvers get their DoT path at once instead of a UDP path that can
only time out). Path state is otherwise internal, and the `SOAR_DEBUG` dump
goes to stderr, which Android loses. The status JSON carries `paths` (per
resolver: transport udp/tcp/dot, verified, suspended, RTT in ns, loss,
window, name length, `answer_limit` — the answer size soar's sizing has
accepted, 0 until verified — successes) and the report prints them
working-first; `soar-socks -paths` prints the same table. `StreamOnly` runs
under the client's lock, so `isDoT` must stay a pure string check.

## soar tuning

soar is pre-release (protocol may change; server and client must be
upgraded together; `go.mod` pins a release). Its 101-char starting name
length never grew on Yandex paths and capped upload near 1.5 KB/s; the
library sets `SafeQName 253`, `MaxPathWindow 64`. soar's own server refuses
loopback/private destinations; restrict its egress to the relays with an
owner-match firewall chain on the server.

## Phone gotchas

- Android Private DNS (strict, e.g. NextDNS) intercepts apps' raw UDP 53:
  every resolver path then arrives from the Private DNS provider with ~512 B
  answers. The tunnel still works, slowly; turning Private DNS off restores
  the direct resolver paths.
- A static (`CGO_ENABLED=0`) Go binary on Android can't resolve hostnames;
  the c-shared library uses cgo and the system resolver, and resolvers are
  IP literals anyway.

## Choosing resolvers: field check with Globalping

A resolver is useful only if it forwards queries for the tunnel zone to the
server. Check from residential networks in the target region with Globalping, reusing one
probe set so rows are comparable, and watch arrivals on the server:

```bash
# probe set: 10 residential probes in the target region (<cc> = its country code)
globalping dns g0x$(openssl rand -hex 3).<tunnel-zone> --resolver 77.88.8.8 --type TXT --from "<cc>+eyeball-network" --limit 10 --json
# then per resolver, same probes (unique name per resolver):
globalping dns g7x$(openssl rand -hex 3).<tunnel-zone> --resolver <ip> --type TXT --from <first-measurement-id> --json
# on the server, which names arrived:
tcpdump -lni <iface> 'udp dst port 53' | grep -oiE 'g[0-9]+x[a-f0-9]{6}\.<tunnel-zone>'
```

NOERROR/NXDOMAIN plus an arrival = the path works. Results 2026-10-11 (10
probes, no allowlist active): Yandex (all six v4), SafeDNS and Quad9 10/10;
NSDI 9 and 7/10; MSK-IX 9 and 4/10; Google 9/10; Cloudflare 4/10 (SERVFAIL);
SkyDNS 0 (filters the zone). Operator resolvers (MTS, Beeline, MegaFon,
Tele2, Rostelecom) answered only probes on their own network — MTS's seven
addresses all worked from the one MTS probe. That is why they are not
defaults: every dead path costs throughput for everyone else. They come from
the phone's own network DNS and the SIM's MCC+MNC instead.

Second run, all 28 residential probes in the region, first measurement without
`--resolver` (each probe's ISP-assigned DNS): 20/28 forwarded the zone,
mostly through the home router — evidence for putting the network's own DNS
first. MTS's seven resolvers again answered only MTS probes; its regional
ones did not. Beeline's published resolvers REFUSED/SERVFAIL from a Beeline
probe (dropped). TransTeleCom `217.150.34.129` answered all 28 (added to the
defaults). One probe (AS50009) answered through every address: its ISP
hijacks all UDP 53 — discard such probes. Globalping rejects private
resolver IPs (10.x): only the phone can test those, and they arrive as its
network DNS anyway.
