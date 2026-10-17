# iroh 1.x upgrade — research + experimental port (branch `exp/iroh-1`)

> **EXPERIMENTAL. Branch-only. Do not merge to master.** Production `core/`
> (chatmail core 2.63, iroh 0.35) is untouched. All code lives in
> `experimental/core-iroh1/` (a copy of `core/`). No wasm patches applied.

Date: 2026-10-16. Toolchain: Rust 1.91.0 (iroh 1.x MSRV is 1.91; production core is 1.89).

## TL;DR

* **iroh 1.x and 0.35 are NOT wire compatible** — not at the relay layer, not at the
  QUIC/TLS layer, not at the gossip layer. A Velta on iroh 1.x cannot do webxdc
  realtime with an unmodified Delta Chat (iroh 0.35) peer, and backup transfer
  ("add second device") between them fails too.
* Latest iroh-gossip for iroh 1.3 is **iroh-gossip 0.101.0** (2026-06-15, depends on `iroh ^1`).
* Port of core to iroh 1.3 + iroh-gossip 0.101: **done, compiles, all 7 upstream
  `peer_channels` tests pass** (live, over n0 public 1.x relays), backup-transfer and QR tests pass.
* Dual-stack "Delta Chat compatible mode" (feature `dc-compat`): **working spike**,
  9/9 peer_channels tests incl. a new test where the peer is reachable only over 0.35.
* Size (deltachat-rpc-server, release, LTO, opt z, stripped, x86_64 linux):

  | build | bytes | Δ vs prod |
  |---|---|---|
  | production core (iroh 0.35) | 27,549,304 | — |
  | iroh 1.3 only | 26,886,200 | −0.66 MB (−2.4 %) |
  | iroh 1.3 + 0.35 (`dc-compat`) | 31,989,976 | **+4.44 MB (+16 %)** |

## 1. Compatibility findings (with sources)

| Layer | 0.35 | 1.x | Compatible? |
|---|---|---|---|
| Gossip ALPN | `/iroh-gossip/0` (iroh-gossip-0.35.0 `src/net.rs`) | `/iroh-gossip/1` (iroh-gossip-0.101.0 `src/net.rs`) | **No** — ALPN negotiation fails |
| Gossip wire | bi-stream per peer | "Change wire protocol to use uni streams per topic" (#75, iroh-gossip 0.90.0); hyparview changes (#56) | **No** |
| Relay protocol | `PROTOCOL_VERSION = 3`, ClientInfo frame (iroh-relay-0.35.0 `protos/relay.rs`) | new handshake (#3331, 0.91), "Update relay protocol to iroh-relay-v2" (#3955, 0.98) | **No** — 0.35 client can't use a 1.x relay and vice versa |
| QUIC stack | iroh-quinn 0.13 | `noq` 1.3 (multipath QUIC fork; "[breaking] Switch noq" #4005, 0.97) | **No** |
| TLS | raw public keys + x509 (`tls_x509()` used by core "for compat with <0.34") | raw public keys only, `tls_x509` removed | **No** |
| Address JSON | `NodeAddr {node_id, relay_url, direct_addresses}` | `EndpointAddr {id, addrs:[{Relay:..}/{Ip:..}]}` | **No** (serde shapes differ) |
| n0 public relays | 0.35 relays until **2026-12-31** | 1.x relays (new URLs, #4341 "Update relay urls to 1.0 stable") | separate fleets |
| Keys | ed25519 | ed25519 | **Yes** — same 32-byte key/ID can be reused on both stacks |

Sources:
* iroh CHANGELOG — https://github.com/n0-computer/iroh/blob/main/CHANGELOG.md (entries cited above)
* iroh-gossip CHANGELOG — https://github.com/n0-computer/iroh-gossip/blob/main/CHANGELOG.md
* iroh 1.0 announcement ("Wire stability" + public relay table: v0.35x until Dec 31 2026; 0.9x/rc until Sep 30 2026; "Wire-breaking relay changes will get new URLs") — https://www.iroh.computer/blog/v1
* Release & support policy (1.x wire stable within major; 2.x must be backward compatible with 1.x; n0 relays only for latest major — otherwise deploy your own) — https://docs.iroh.computer/about/release-policy
* v1.0.0 release notes — https://github.com/n0-computer/iroh/releases/tag/v1.0.0
* n0 commitment to run 0.35 relays ≥6 months after 1.0 — https://github.com/n0-computer/iroh/discussions/3728
* crates.io: iroh 1.3.0 (2026-09-28, rust-version 1.91); iroh-gossip 0.101.0 (2026-06-15, `iroh ^1`)
* Constants verified in the downloaded crate sources (`~/.cargo/registry/src/.../iroh-gossip-{0.35.0,0.101.0}`, `iroh-relay-{0.35.0,1.3.0}`).

Consequence: wire stability is only promised *from* 1.0 on. Good news for the future
(1.x ↔ 2.x will be compatible), but the 0.35 → 1.x jump is a hard break.

Also important: **chatmail servers advertise an iroh 0.35 relay** via IMAP metadata
`/shared/vendor/deltachat/irohrelay`. iroh 1.x cannot use it. Until chatmail servers
also run iroh-relay 1.x (different URL or same host with both), a 1.x endpoint
configured with that URL will fail to get a home relay. Velta's own relays need an
iroh-relay 1.x deployment.

## 2. Port to iroh 1.3 (commit "port experimental core to iroh 1.3")

Touched: `Cargo.toml`, `src/peer_channels.rs`, `src/imex/transfer.rs`, `src/qr.rs`,
`src/mimefactory.rs`, tests, `deltachat-rpc-server/Cargo.toml`.

* `NodeAddr/NodeId` → `EndpointAddr/EndpointId`; `relay_url()` → `relay_urls()`; `addrs` set of `TransportAddr`.
* `Endpoint::builder()` → `Endpoint::builder(presets::Minimal)`; feature `tls-ring` (was implicit); `tls_x509()` dropped.
* `endpoint.add_node_addr()` → `address_lookup::MemoryLookup` passed to the builder.
* `endpoint.node_addr().await` → `endpoint.online()` (bounded 10 s) + `endpoint.addr()`.
* gossip: `Gossip::builder().spawn()` is sync; `subscribe_*` are async; `api::{Event, GossipSender, GossipReceiver}`;
  no `Joined` event → first `NeighborUp` resolves the join future; adding a peer to an active topic via `sender.join_peers`.
* backup transfer: `QuicTransportConfig::builder()`, `Accepting`; QR decoding accepts legacy 0.35 JSON (parse only — connection still fails cross-version).
* `SecretKey::generate()` (no rng arg); `tokio` feature `signal` for rpc-server (was transitive via 0.35).

Status: `cargo check --tests` clean, `cargo clippy --tests` clean (both feature sets),
`peer_channels` 7/7, `imex::transfer` 3/3, `qr::` 40/40, release `deltachat-rpc-server` builds.

Effort for this part: ~1 day incl. review; small, mechanical (~150 LOC diff).

## 3. Dual-stack "Delta Chat compatible mode" (feature `dc-compat`)

```toml
iroh035        = { package = "iroh",        version = "0.35", optional = true, default-features = false }
iroh_gossip035 = { package = "iroh-gossip", version = "0.35", optional = true, default-features = false, features = ["net"] }
dc-compat = ["dep:iroh035", "dep:iroh_gossip035"]
```

Design (implemented in `src/peer_channels/legacy.rs` + `peer_channels.rs`):

1. **One identity, two endpoints.** The 0.35 endpoint is created with the same ed25519
   secret key bytes, so our ID is identical on both stacks; Delta Chat stores peers by public key.
2. **Advertisement** (hidden `IrohNodeAddr` system message, encrypted headers):
   * `Iroh-Node-Addr`: in dual mode the **0.35 `NodeAddr` JSON** — exactly what Delta Chat expects
     (in 1.x-only builds: 1.x JSON; old clients fail to parse and just log a warning; the message is still trashed because the header is present).
   * new `Iroh-Endpoint-Addr`: 1.x `EndpointAddr` JSON. Unknown headers are ignored by
     Delta Chat; the header sits inside the encrypted part like the others.
   * Receiving: `Iroh-Node-Addr` is parsed as 1.x first, else as legacy 0.35; `Iroh-Endpoint-Addr` as 1.x.
3. **Storage without DB migration**: legacy peers + topic stub stay in upstream `iroh_gossip_peers`;
   1.x peers go into `iroh1_gossip_peers` (`CREATE TABLE IF NOT EXISTS`, same schema). No `dbversion`
   bump, so a profile stays openable by production core (which ignores the extra table).
4. **Join**: v1 swarm with 1.x peers, legacy swarm with 0.35 peers (same `TopicId`). The first
   neighbour on either swarm resolves the "joined" future.
5. **Send**: broadcast on both swarms. **Receive**: dedup by the `seq_num‖public_key` suffix core
   already appends; emit once; **bridge** (forward once) to the other swarm, so Delta Chat peers and
   1.x-only peers see each other through any dual-stack peer. Gossip's own hash-dedup plus our
   suffix dedup stops loops.
6. "Prefer 1.x with Velta peers": a Velta peer is in `iroh1_gossip_peers` → contacted on v1; it also
   gets the legacy copy (harmless, deduped). A pure prefer-and-skip optimisation (don't send legacy to
   peers we know on v1) is not possible with gossip broadcast semantics without per-peer direct sends;
   not worth it for small webxdc swarms.

Tests: `test_dc_compat_legacy_only_peer` — Alice suppresses `Iroh-Endpoint-Addr` (acts like
Delta Chat), Bob only knows her 0.35 address, realtime data flows both ways over the 0.35 stack (live, n0 0.35 relays).
Plus `test_seen_dedup`. All 9 peer_channels tests pass with `--features dc-compat`.

Not yet done / limits of the spike:
* No interop test against a *real* unmodified Delta Chat binary (the legacy stack is the same crate/code
  as upstream, so risk is low, but do one manual test: Velta exp build ↔ Delta Chat desktop, webxdc e.g. "Editor").
* Backup transfer (`DCBACKUP2`) is still 1.x-only → second-device setup Velta-exp ↔ Delta Chat breaks.
  Options: keep 0.35 for backup transfer in dc-compat, or a `DCBACKUP3` scheme.
* Each stack does its own net-report/relay connection: 2 relay websockets, 2 UDP sockets, more battery while a realtime webxdc is open.
* Relay choice: legacy stack uses chatmail `irohrelay` (0.35) or n0 0.35 default; v1 stack uses n0 1.x default
  (or the chatmail URL, which only works when it is a 1.x relay). Needs a separate `irohrelay1` metadata key/config.
* Two copies of rustls/QUIC stacks in the binary: **+5.1 MB vs 1.x-only (+4.4 MB vs production)**.
* After 2026-12-31 n0 stops 0.35 relays; dc-compat then only works via chatmail 0.35 relays (which chatmail
  will run as long as Delta Chat uses 0.35).

Effort to productionise dual-stack: ~4–6 days (relay config, backup-transfer story, real interop test,
cleanup/metrics, Android/iOS build checks for doubled native deps), plus maintenance until upstream
chatmail core moves to 1.x — then drop `dc-compat` (it is a single feature flag + one module).

## 4. Browser / wasm implications

* iroh 1.x officially supports `wasm32-unknown-unknown` in browsers, **relay-only** (WebSocket to the relay;
  no UDP, no hole punching; still E2E encrypted). Use `default-features = false`; metrics/local discovery/pkarr-dht
  are not available. Auth tokens go as `?token=` query on wasm. — https://docs.iroh.computer/languages/wasm-browser
* iroh 0.35 browser support was alpha (0.32 "Browsers Alpha") — the 1.x line is the one to build the PWA on.
* **dc-compat is native-only**: shipping 0.35 to wasm is pointless (old, alpha, +size). A browser Velta would
  therefore only reach Velta 1.x peers (or Delta Chat peers via a native dual-stack bridge peer in the same swarm).
* Velta's wasm patch series (`docs/research/wasm-patches/series`, 0002) still lists iroh 0.35 deps; rebasing it
  onto `experimental/core-iroh1` means: drop the 0.35 deps, use `presets::Minimal` with relay-only, cfg out
  `portmapper`/`tls-ring` as needed. Not attempted here (rule: no wasm patches on production core; also not applied to the experimental copy).
* Browsers need a wss-capable iroh-relay 1.x with CORS/hostname set up (Velta relays).

## 5. Risks

* Ecosystem split: until chatmail/core ships 1.x, any 1.x-only Velta loses realtime with Delta Chat users.
* Upstream drift: chatmail core will do its own 1.x migration (header/format choices may differ from
  `Iroh-Endpoint-Addr`) → expect to re-align; keep the diff small.
* MSRV jump to 1.91 for the whole core (Android NDK/iOS toolchains must follow).
* n0 0.35 relay sunset 2026-12-31 (realtime between Delta Chat users on non-chatmail servers depends on n0 relays — RelayMode::Default fallback in core).
* Dual-stack doubles network work and attack surface; bridging means a dual-stack peer relays data between swarms (same trust as gossip already has).

## 6. Recommended next steps

1. Keep production on 0.35 for now; nothing forces a change before 2026-12-31, and chatmail relays are 0.35.
2. Deploy an iroh-relay 1.x on Velta infra (wss) — needed for both native 1.x and the browser.
3. Manual interop test: `experimental/core-iroh1` + `dc-compat` rpc-server ↔ stock Delta Chat (webxdc realtime both ways, and bridging with a third 1.x-only peer).
4. Decide backup-transfer strategy (keep 0.35 in dc-compat vs new QR version).
5. Watch chatmail/core for their 1.x plan (read-only); align header names before anything ships.
6. Rebase the wasm series onto the iroh-1 copy in a side tree (relay-only), separate branch.

## Reproduce

```sh
cd experimental/core-iroh1            # needs rust >= 1.91
cargo test -p deltachat --lib peer_channels
cargo test -p deltachat --lib --features dc-compat peer_channels
cargo build --release -p deltachat-rpc-server [--features deltachat/dc-compat]
```

## 7. Experimental iroh-relay 1.x on a7.velta.cc (deployed 2026-10-17)

**Relay URL: `https://a7.velta.cc:3343/`** (iroh clients append `/relay` themselves).

| What | Value |
|---|---|
| Binary | official `iroh-relay-v1.3.0-x86_64-unknown-linux-musl.tar.gz` from github.com/n0-computer/iroh releases v1.3.0; tarball sha256 `677f4c62342a6ba8044459b5fd4302f2b1dcb8402542072e3a4ade5039bc0b9e` (verified against the GitHub asset digest); binary sha256 `6d5b32ba921cae5801c38a03682bb2dcc3e2efdf8a7c62fd8a00868b7aad4779` → `/usr/local/bin/iroh-relay-v1` |
| Service | `iroh-relay-v1.service` (enabled), user/group `iroh-relay-v1` (system, nologin, no home), systemd hardening (ProtectSystem=strict, no capabilities, MemoryMax=512M) |
| Config | `/etc/iroh-relay-v1/config.toml` |
| HTTPS relay | TCP `[::]:3343` (relay's own TLS, `cert_mode = "Manual"`) |
| QUIC address discovery | UDP `[::]:7842` |
| HTTP (captive portal) | `127.0.0.1:3344` (loopback only) |
| Metrics | `127.0.0.1:9093/metrics` (loopback only) |
| Access control | open (`everyone`) for experiments |
| Health | `GET /ping` → 200, `GET /healthz` → `{"status":"ok","version":"1.3.0"}` |

Existing services were left alone: nginx (80/443/3341, 3341 proxies to chatmail's
own planned `iroh-relay-1` on 127.0.0.1:3342), chatmail `iroh-relay` (0.35, :3340) and
`iroh-relay-1` units (both were already *inactive/disabled*, untouched), postfix, dovecot,
acmetool, `/var/www/html`. No nginx/postfix/dovecot config changed or restarted.
Firewall: ufw is inactive and iptables/nft INPUT policy is ACCEPT, so no rules were added.

Note: chatmail's nginx already prepares `https://a7.velta.cc:3341` → `127.0.0.1:3342` for an
iroh-relay 1.x (`/etc/iroh-relay-1.toml`, binary staged as `/usr/local/bin/iroh-relay-1.new` —
same sha256 as ours, but not installed/enabled). We deliberately did **not** take port 3342 so a
later chatmail deploy can enable its own relay without conflicts. Long-term the chatmail one
(advertised via `/shared/vendor/deltachat/irohrelay1`) is the "real" one; ours is for experiments.

### TLS / renewal

The Let's Encrypt cert is managed by **acmetool** (`/var/lib/acme/live/a7.velta.cc/`), which we
do not modify. `/usr/local/sbin/iroh-relay-v1-certsync` copies `fullchain` + `privkey` (read-only
source) into `/etc/iroh-relay-v1/tls/{cert,key}.pem` owned by `iroh-relay-v1` (key 0600):
* runs as root as `ExecStartPre=+` on every relay start, and
* daily via `iroh-relay-v1-certsync.timer`; restarts the relay only if the cert changed.
Current cert: CN=a7.velta.cc, issuer Let's Encrypt YE1, notAfter 2027-01-06.

### Access token (optional)

iroh-relay 1.0+ supports bearer tokens without an external service:
```toml
[access]
shared_token = ["<random-token>"]   # or env IROH_RELAY_ACCESS_TOKEN=<token> (single token)
```
Clients: `RelayConfig::new(url, quic).with_auth_token(token)` (native: `Authorization: Bearer`,
wasm: `?token=` query). Other modes: `allowlist`/`denylist` of endpoint ids, `http` (POST check).

### Verification (2026-10-17)

* `systemctl is-active iroh-relay-v1` → active; nginx/postfix/dovecot still active.
* From the box: `/ping` 200, `/healthz` 200 `{"status":"ok","version":"1.3.0"}`, `/relay` 400
  "missing header: upgrade" (expected without websocket upgrade), cert verifies (ssl_verify_result=0).
* iroh 1.3 end-to-end: `experimental/iroh-relay-probe` — two endpoints, IP transports disabled,
  `RelayMode::custom([https://a7.velta.cc:3343/])`, both got the relay as home relay, bi-stream
  echo succeeded, path = `relay:https://a7.velta.cc:3343/` only (3.5 s total). Relay metrics:
  `accepts_total 2`, `unique_client_keys_total 2`, ~12 KB each way.
  (`cargo run -- https://a7.velta.cc:3343/ 138.124.24.110` — the 2nd arg pins DNS because the box's
  resolver hands out fake IPs.)
* Not verified from the box: QUIC address discovery on UDP 7842 (box egress has no plain UDP).

### Stop / remove

```sh
systemctl disable --now iroh-relay-v1.service iroh-relay-v1-certsync.timer
rm -f /etc/systemd/system/iroh-relay-v1.service \
      /etc/systemd/system/iroh-relay-v1-certsync.service \
      /etc/systemd/system/iroh-relay-v1-certsync.timer
systemctl daemon-reload
rm -rf /etc/iroh-relay-v1 /usr/local/bin/iroh-relay-v1 /usr/local/sbin/iroh-relay-v1-certsync /root/iroh-relay-v1-dl
userdel iroh-relay-v1
```
