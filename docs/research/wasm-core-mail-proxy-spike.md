# Spike log — wasm core + WebSocket mail proxy

**Status:** day 5 — Velta-owned wasm core policy + opt-in patch home scaffolded; side-tree **native** `cargo check` **PASS** (system OpenSSL); `wasm-opt` ~29→~18 MB. Master `core/` unchanged.
Started **2026-10-05** (Europe/Moscow). Research baseline:
[`wasm-core-mail-proxy.md`](wasm-core-mail-proxy.md).

Goal: validate `experintellia/slothfulchat-web` + `pbuzdin/relay` branch
`link2xt/websockify` enough to decide whether to forward-port wasm patches onto
Velta’s core 2.62.0.

Licensing reminder: do **not** copy the GPL web app / desktop frontend into
Velta. MPL-2.0 core patches and the MPL `core-wasm` wrapper may be referenced
or listed; the Unlicense `ws-tcp-proxy` is fine to reuse as a pattern.

---

## Day 1 (2026-10-05) — what was tried

### Repos
| Tree | Location on spike host | Ref |
|---|---|---|
| Velta | this repo | master (research + this spike log) |
| slothfulchat-web | scratch clone outside Velta | `main` at clone time |
| pbuzdin/relay | scratch clone outside Velta | branch `link2xt/websockify` @ `02c7d3d` |
| vendor/core (slothfulchat) | submodule | `446cdabd` (2.54.0-dev) |

### Toolchain installed on the spike host
- `clang` 19.1.7 (was missing; required for `ring` + `sqlite-wasm-rs`)
- `websockify` (Debian package)
- rustup `nightly-2026-08-01` + `wasm32-unknown-unknown` (from
  `packages/core-wasm/rust/rust-toolchain.toml`)
- `wasm-pack` 0.15.0, `wasm-bindgen-cli` **0.2.126** (must match `Cargo.lock`;
  a mismatch makes wasm-pack try a blocked GitHub binary download)
- Host also had `/usr/bin/rustc` 1.85; builds used rustup’s toolchain

### slothfulchat-web build
1. `git submodule update --init vendor/core` → pin `446cdabd`.
2. Applied all **35** `patches/core/*.patch` onto a detached worktree
   (`build/core`). Desktop submodule **not** required for `build:wasm`.
3. System `pnpm` via corepack is broken on this host
   (`/usr/local/share/corepack` permissions + VM dynamic-import error).
   Workaround: call `wasm-pack` directly.
4. Build command:
   ```sh
   cd packages/core-wasm/rust
   CARGO_BUILD_JOBS=2 CC=clang \
     wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist
   ```
5. **Result: SUCCESS** in ~6m 23s. Artifact:
   - `deltachat_wasm_bg.wasm` **~28 MB** (release, LTO, **without** `wasm-opt`;
     published npm `@slothfulchat/core-wasm@0.9.1` ships ~17 MB after opt)
   - companion `deltachat_wasm.js` / `.d.ts` from wasm-bindgen 0.2.126

### Browser smoke (`get_system_info`)
Used the published package’s JS glue (`dist/`, `@slothfulchat/core-wasm@0.9.1`)
with **our** freshly built `wasm-dist/*.wasm` (+ matching bindgen JS), plus the
repo’s `example/index.html` and `scripts/smoke-core-wasm.mjs`, Playwright
Chromium.

```
OK: core v2.54.0-dev answered get_system_info in the browser (sqlite 3.53.0, arch 32)
OK: typed client works (getAllAccountIds -> [])
OK: fs side channel roundtrip (write/exists/read/remove)
```

So: **wasm core boots in a worker on this box.** Native `cargo test -p
deltachat-jsonrpc` to regenerate the TS client failed separately (`make`
missing for vendored OpenSSL on the host target) — not needed once the
published glue + our wasm were paired.

### ws-tcp-proxy (generic design-G bridge)
- `packages/ws-tcp-proxy/ws-tcp-proxy.mjs` starts on `ws://127.0.0.1:8641`.
- Health check `ws://127.0.0.1:8641/dns/localhost` → `["127.0.0.1","::1"]`.
- Endpoints: `/dns/{host}`, `/tcp/{ip}/{port}` (ports 143/465/587/993 only);
  optional `CHATMAIL_ALLOWLIST`. TLS stays in wasm.
- **Runnable locally without cmdeploy.** Ready for day-2 networking e2e.

### Relay websockify (`link2xt/websockify` / upstream PR #1030)
Always-on in cmdeploy (no `chatmail.ini` toggle):

| Piece | Detail |
|---|---|
| nginx | `location /imap` → `http://127.0.0.1:8143`; `location /smtp` → `http://127.0.0.1:8587` (WebSocket upgrade headers) |
| systemd | `websockify-imap.service`: `websockify 127.0.0.1:8143 localhost:143` |
| systemd | `websockify-submission.service`: `websockify 127.0.0.1:8587 localhost:587` |
| deployer | `WebsockifyDeployer` apt-installs `websockify`, installs units, enables services |
| CORS | **not** in the branch yet — commit message: needed for browser clients on a different origin |

**Local/minimal proxy without full cmdeploy:** yes for the *proxy process*
(`websockify 127.0.0.1:8143 localhost:143` binds). Without local
Dovecot/Postfix (or a tunnel to a real relay), it has nothing useful to talk
to. For the spike, prefer:

1. slothfulchat’s `ws-tcp-proxy` → a public chatmail (e.g. nine.testrun.org), or
2. a test deploy of `pbuzdin/relay` `link2xt/websockify` + Origin/CORS for the
   PWA origin.

Verified: `websockify 127.0.0.1:18143 localhost:143` starts and listens here.

### Blockers / friction recorded
| Item | Severity | Notes |
|---|---|---|
| `clang` missing initially | resolved | apt install |
| corepack/`pnpm` broken | workaround | call `wasm-pack` / npm-global pnpm.cjs |
| `make` missing | blocked native jsonrpc gen only | wasm path unaffected; used published JS glue |
| No full cmdeploy / mail stack on box | expected | use generic bridge or external test relay |
| Browser-only e2e networking | day 2 | needs proxy + real IMAP/SMTP + Playwright script |
| GPL web-app | do not import | only MPL core patches / Unlicense proxy |

### Not done yet (after day 1; day 2 closed the e2e)
- ~~Encrypted alice→bob round-trip~~ → **done day 2**
- Deploy / hit relay-native `/imap` + `/smtp` (deferred; generic bridge chosen)
- Forward-port wasm patch subset onto Velta core 2.62.0
- Any production Velta app code (intentionally untouched)

---


---

## Day 2 (2026-10-05) — networking e2e (Pavel: generic bridge + public chatmail)

**Path chosen:** generic design-G `ws-tcp-proxy` + public chatmail
`nine.testrun.org` (not relay-native websockify).

### Harness
- Script: slothfulchat-web `scripts/test-networking.mjs` (headless Playwright).
- Creates two throwaway accounts via `POST https://nine.testrun.org/new`
  (Node-side; not through wasm HTTP).
- Forks `packages/ws-tcp-proxy` on `ws://127.0.0.1:8641`.
- Serves `packages/core-wasm` example with `?persist=0&proxy=ws://localhost:8641`.
- In one browser core (multiaccount): configure alice + bob over IMAP/SMTP
  through the tunnel (TLS in wasm), exchange keys via vcard, alice sends a
  marker text, bob waits on `IncomingMsg`.

Artifacts reused from day 1: our ~28 MB wasm build + published
`@slothfulchat/core-wasm@0.9.1` JS glue (`dist/`). No GPL web-app copied into
Velta.

### Result: **PASS** (`E2E_EXIT=0`)

```
OK: two accounts configured over the WS tunnel; alice→bob message delivered:
"wasm-roundtrip-03kuxxfsjfj4"
```

- Wall clock for the whole script: **~10 s** (account create + boot + dual
  configure + send + IMAP IDLE receive).
- SMTP: message SMTP-sent (~2.9 KB wire size logged by core).
- Receive: bob IDLE saw `Exists(1)`, Autocrypt fingerprint saved, message
  assigned to a 1:1 chat — encrypted chatmail path as expected.

### Notes / non-fatal friction
| Observation | Impact |
|---|---|
| Autoconfig tries `nine.testrun.org:443` first; many `tls handshake eof` then fallback to **993/465** | Expected on this stack; configure still succeeded. Chatmail’s 443-ALPN mail path is not what the wasm WS tunnel negotiated here. |
| IPv6 targets `ENETUNREACH` on this host | Harmless; IPv4 993/465 worked |
| Missing `fresh_account.db.gz` template (HTTP 404 in example server) | New accounts replay migrations (~few ms logged); slowdown only |
| No credentials or account addresses recorded in-repo | Throwaways from `/new`; discarded after the run |

### Manual reproduction (if re-run needed)
```sh
# from slothfulchat-web checkout with wasm-dist + dist + example present
CHATMAIL_NEW=https://nine.testrun.org/new VERBOSE=1 \
  node scripts/test-networking.mjs
```
Needs: Playwright Chromium, `ws` npm dep, outbound HTTPS to `/new` and TCP
143/465/587/993 via the local proxy to the relay.


---

## Day 3 (2026-10-05) — forward-port onto Velta 2.62.0 (side tree)

**Approach:** inventory + side tree `/workspace/velta-wasm-port` (not merged).
Follows COREUPDATE patch discipline: do not break Android/desktop; keep
wasm work opt-in / documented until native checks are clean on a full toolchain.

### Inventory
See [`wasm-core-port-inventory.md`](wasm-core-port-inventory.md). Mechanical
`git apply` of prototype patches: only **0002** clean; 0001/0003–0007/0010 need
hand port (Cargo + tls/blob drift).

### Side-tree result
- Manual **0001-equivalent** Cargo.toml + shim/vendors + **0002** + partial **0003/0004**.
- `cargo check -p deltachat --lib --target wasm32-unknown-unknown --no-default-features` → **PASS**.
- Full `wasm-pack` / browser smoke on 2.62 **not** done (still need WS transport + clock ports + wrapper).
- Velta `master`: `python3 tools/apply-core-patches.py verify` → **13/13**; no core patch commit.

### Blockers for wasm-pack / smoke on 2.62
1. Port remaining WASM-CORE: **0005** (ws_tcp), **0006** (clocks), **0007**, **0010** (fetch).
2. mail-builder 0.5 vs prototype 0.4.4 fork (time panics may return at runtime).
3. MPL `deltachat-wasm` bindgen crate + JS glue (do not import GPL UI).
4. Native full-feature check needs pkg-config/OpenSSL on the spike host (env).

## Build outcome

**Built and smoke-tested.** `wasm-pack` exit 0; headless Chromium
`get_system_info` / typed client / memfs roundtrip all OK on core
`v2.54.0-dev` (sqlite 3.53.0). Unoptimized wasm ~28 MB; expect ~17 MB after
`wasm-opt` if that binary is available.

---

## Day 4 (2026-10-05) — finish WASM-CORE ports + wasm-pack smoke + 2.62 e2e

**Side tree:** `/workspace/velta-wasm-port` (experimental). Master `core/` still
untouched (`apply-core-patches.py verify` **13/13**).

### Ports completed
| Item | Notes |
|---|---|
| **0005** `ws_tcp` | `connect_tcp_inner` + DNS via proxy; **also** wasm `connect_tcp` for autorelay (2.62) |
| **0006** clocks | `time_now` / `SystemTimeTools` re-export; tls `JsClockTimeProvider` + ring on wasm |
| **0007** blob sync_fs | memfs BufReadSeek / `file_hash` / image helpers (Velta animated-WebP kept) |
| **0010** fetch | `http_wasm.rs` via browser `fetch` |
| **0004 leftovers** | `path_exists` / `path_is_dir` / `path_is_file` call sites (`accounts`, `context`, `imex`, `tools`) — without these `Accounts::new` / blobdir fail on memfs |
| **mail-builder 0.5.0** | Vendored with `web-time` SystemTime (prototype fork was 0.4.4; crates.io 0.5 panicked mid-configure) |

### Artifact
- Minimal MPL `packages/core-wasm` (jsonrpc `init`/`receive` + memfs side channel; no OPFS/heal/crypto-offload).
- `wasm-pack build --target web --release --no-opt` → **exit 0**
- Artifact: `deltachat_wasm_bg.wasm` **~29 MB** (unoptimized; expect ~17 MB with `wasm-opt`)
- Toolchain: nightly-2026-08-01, `wasm-bindgen-cli` **0.2.129** (match lock), clang, `getrandom_backend=wasm_js`

### Browser smoke
```
OK: core v2.62.0 answered get_system_info (sqlite 3.53.0, arch 32)
OK: memfs side channel roundtrip
```
Script: side-tree `scripts/smoke-core-wasm.mjs` (Playwright + `/usr/bin/google-chrome`).

### Networking e2e (2.62)
Path: local Unlicense `ws-tcp-proxy` → `nine.testrun.org` (same as Day 2).
```
OK: two accounts configured over the WS tunnel; alice→bob message delivered:
  wasm-roundtrip-ewf5hft74cr
```
~10 s wall clock. Same non-fatal friction as Day 2 (CORS autoconfig, IPv6
`ENETUNREACH`, 443 ALPN eof then 993/465).

Script: side-tree `scripts/test-networking.mjs` (raw JSON-RPC; no GPL UI).

### Master
Docs-only update. **No** wasm patches in `master` `core/`.

---

## Day 5 (2026-10-05) — ownership, patch home, native gate

### Fresh Velta wasm core? **Yes**
Pavel asked whether we will have our own fresh wasm core. **Yes:** a
**Velta-owned forward-port of chatmail/core 2.62+** (side tree today), **not** a
fork of `experintellia/slothfulchat-web`. Reuse **MPL-licensed patch ideas** only;
no GPL web app / desktop UI into Velta. Policy + artifact path:
[`wasm-patches/README.md`](wasm-patches/README.md).

Fresh artifact (spike host):
`/workspace/velta-wasm-port/packages/core-wasm/wasm-dist/deltachat_wasm_bg.wasm`
(Day 4 build of the Velta 2.62 side tree + MPL wrapper).

### Patch home — **decision**
**Near-term: opt-in second apply layer** (chosen), separate from the 13
production patches in `tools/apply-core-patches.py`.

| Mechanism | Role |
|---|---|
| `tools/apply-wasm-core-patches.py` | Scaffolded; `status`/`list` OK; **`apply` REFUSED** until discrete patches are extracted |
| `docs/research/wasm-patches/` | Landing pad + ownership README |
| Side tree `/workspace/velta-wasm-port` | Source of truth until extraction |

Longer-term: collapse into upstreamable `cfg(target_arch = "wasm32")` / upstream
chatmail where possible. **Not** merging raw prototype patches into the
production apply script.

### Native check (side tree host target)
Installed on spike host: `pkg-config`, `libssl-dev` (already present), `make`.

| Command | Result |
|---|---|
| `OPENSSL_NO_VENDOR=1 cargo check -p deltachat --lib` (side tree, host) | **PASS** (~2m 12s; 1 unused-import warning in `blob.rs`) |
| Default vendored OpenSSL build (first try) | Failed until `make` installed (`openssl-src` needs it) |
| `cargo nextest` | **Not run** — `cargo-nextest` not installed on spike host |

**Still no master `core/` merge** — native PASS on the *side tree* is a green
gate for the experimental port; landing still needs extracted patches + review
+ wasm CI story. Master `apply-core-patches.py verify` remains **13/13**.

### wasm-opt (optional)
| Artifact | Size |
|---|---|
| `deltachat_wasm_bg.wasm` (`--no-opt`) | **~29 MB** (29 918 680 bytes) |
| after `wasm-opt -Os` (binaryen 120) | **~18 MB** (18 516 912 bytes) |

Ship/opt path should prefer `wasm-opt` when available (~38% smaller here).

---

## Next concrete steps (day 6)

1. Extract discrete patch units from the side tree into
   `docs/research/wasm-patches/` (or `patches/wasm-core/`) and teach
   `apply-wasm-core-patches.py` a real, idempotent `apply` against a *copy*
   first — still not master `core/` until reviewed.
2. Install/run `cargo nextest` on the side tree (or CI image with OpenSSL +
   pkg-config + make) for a stronger native gate.
3. Wire wasm CI sketch: side-tree or opt-in apply → `wasm-pack` + smoke.
4. Optional: commit optimized wasm size budget / `wasm-opt` in the wrapper
   build script when that package enters the repo.

## Ask Pavel to approve next

- Day 5 locks **Velta-owned** wasm core + **opt-in** patch home (scaffold on
  master docs/tools; experimental code still side-tree only).
- Approve Day 6 **extraction** of patches into-repo (still no production merge
  until nextest + reviewed apply path).
