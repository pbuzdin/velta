# Spike log — wasm core + WebSocket mail proxy

**Status:** day 1 green on build + browser smoke; networking e2e still open.
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

### Not done yet
- Encrypted alice→bob round-trip (`scripts/test-networking.mjs`)
- Deploy / hit relay-native `/imap` + `/smtp`
- Forward-port wasm patch subset onto Velta core 2.62.0
- Any production Velta app code (intentionally untouched)

---

## Build outcome

**Built and smoke-tested.** `wasm-pack` exit 0; headless Chromium
`get_system_info` / typed client / memfs roundtrip all OK on core
`v2.54.0-dev` (sqlite 3.53.0). Unoptimized wasm ~28 MB; expect ~17 MB after
`wasm-opt` if that binary is available.

---

## Next concrete steps (day 2–3)

1. **Networking e2e:** run `ws-tcp-proxy` + `scripts/test-networking.mjs` (or
   the example page with `?proxy=ws://localhost:8641`) against a chatmail
   (nine.testrun.org or Pavel’s relay). Record success / TLS / allowlist issues.
2. **Relay path:** if approved, deploy `link2xt/websockify` on a test relay and
   add CORS/`Origin` for the PWA origin; compare against the generic bridge.
   Verify Dovecot loopback / STARTTLS behaviour behind `/imap`.
3. **Optional:** install `make` + finish native jsonrpc client generation, or
   keep using published `@slothfulchat/core-wasm` glue; run `wasm-opt` for size.
4. **Port plan:** list MPL wasm patches to forward-port (roughly 0001–0007,
   0010, plus persistence ones if needed) vs Velta’s existing 13 core patches;
   estimate rebase onto 2.62.0. Still no GPL web-app copy into Velta.
5. **Stop criterion:** one encrypted round-trip through a bridge; numbers for
   bundle size / cold boot / memory if easy.

## Ask Pavel to approve next

- Whether to **deploy `pbuzdin/relay` branch `link2xt/websockify` on a test
  relay** (with CORS for a chosen PWA origin), vs continuing day 2 only against
  the generic `ws-tcp-proxy` + a public chatmail (e.g. nine.testrun.org).
- Confirmation that **no Velta app/code changes** land until the networking
  slice is green (docs-only is already fine).
