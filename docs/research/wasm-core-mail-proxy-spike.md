# Spike log — wasm core + WebSocket mail proxy

**Status:** day 3 — Velta **2.62.0** side-tree `cargo check` for `wasm32-unknown-unknown` **PASS** (lib, `--no-default-features`). Day 2 alice→bob still stands on prototype 2.54. Inventory: [`wasm-core-port-inventory.md`](wasm-core-port-inventory.md). **Master `core/` unchanged.**
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

## Next concrete steps (day 4)

1. Continue side-tree: port **0005–0007 + 0010**; keep `cargo check` wasm green.
2. Add minimal MPL `deltachat-wasm` wrapper; `wasm-pack` + `get_system_info` smoke.
3. Re-run networking e2e on 2.62 via local `ws-tcp-proxy` → nine.testrun.org.
4. Draft how wasm patches will live long-term (separate apply script vs upstreamable cfgs) without touching production APK/desktop builds.

## Ask Pavel to approve next

- Day 3 achieved **wasm lib check on Velta 2.62 in a side tree** without
  touching master core. Approve **Day 4** continuing in the side tree toward
  `wasm-pack` + smoke (still docs-only / side-tree until native+wasm are both
  proven).
- Confirm still **no** merge of wasm patches into `master` `core/` until a
  full native check on a machine with OpenSSL/pkg-config passes.
