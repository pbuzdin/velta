# Spike log — wasm core + WebSocket mail proxy

**Status:** day 11 — astral-tokio-tar rebased onto stock 0.6.4 (native downgrade removed), SQLCipher 4.6.1↔4.14.0 upgrade + rollback PASS on a real-schema DB, vendored code register ([`VENDORED.md`](wasm-patches/VENDORED.md)), CI e2e run 3. Day 10 complete (CI e2e PASS on `d777ab0`). [Landing checklist](wasm-core-landing-checklist.md) **25 open** — master `core/` stays stock.
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

## Day 6 (2026-10-05) — extract patches, apply-on-copy, nextest, CI sketch

### Extracted into-repo
| Path | Contents |
|---|---|
| `docs/research/wasm-patches/series/*.patch` | **8** discrete patches (`git format-patch` from side-tree baseline `0a10087` → HEAD; `Cargo.lock` hunks stripped) |
| `docs/research/wasm-patches/SERIES` | Apply order |
| `docs/research/wasm-patches/support/` | `tokio-wasm-shim` + async-imap / astral-tokio-tar / mail-builder (~1 MB) |

Baseline `0a10087` matched Velta master `core/` at extract (diff empty).

### apply-on-copy
`tools/apply-wasm-core-patches.py`:
- `apply-on-copy --dest …` copies master `core/` + support, applies 8/8 patches
- bare `apply` **REFUSED**; writing master `core/` **REFUSED** without dangerous flag
- `.wasm-core-apply/` gitignored

**Verified:** apply-on-copy → `cargo check -p deltachat --lib --target wasm32-unknown-unknown --no-default-features` **PASS** (~3m 30s on copy).

### nextest (side tree host)
Installed `cargo-nextest` 0.9.146. `OPENSSL_NO_VENDOR=1`.

| Run | Result |
|---|---|
| `-p deltachat-time -p format-flowed -p ratelimit --lib` | **PASS** 5/5 |
| `-p deltachat --lib` (filtered tools/blob/contact) | **FAIL compile** — `blob_tests` still call old `image_metadata` signature after Day-4 0007 BufReadSeek change (6× E0308). Lib `--lib` check without tests remains green (Day 5). |

Full deltachat nextest **not** green until blob_tests updated (Day 7).

### CI sketch (does not touch Release)
Added `.github/workflows/wasm-core-opt-in.yml`:
- triggers: `workflow_dispatch`, branches `wasm-core/**`, PRs touching wasm-patches / apply script
- job: apply-on-copy + wasm `cargo check` (`continue-on-error: true`)
- **not** referenced from `release.yml` / platform build workflows
- wasm-pack + Playwright smoke still side-tree until MPL wrapper is in-repo

### Master
Docs + tools + patches + support + opt-in workflow only. **No** wasm merge into production `core/`. `apply-core-patches.py verify` **13/13**.

---

## Day 7 (2026-10-05→06) — blob_tests fix, nextest, in-repo MPL wrapper

### blob_tests / `image_metadata`
Day-4 port changed `image_metadata` to `fn(&mut R) -> Result<Option<Exif>>`
(`BufRead + Seek`) for wasm memfs. Tests still used the old
`(u64, Option<Exif>)` + `&File` API → libtest compile fail.

**Fix (side tree + series 0009):** call sites use `BufReader` + separate
`metadata().len()` where size was needed; update selfavatar golden hash to
`b8c55604d4134d368ae128387a23720.png` (reencode output on this toolchain).

> **Superseded Day 8:** the golden change was wrong — caused by side-tree
> `Cargo.lock` drift to `png` 0.18.1, not by the port. 0009 now keeps the
> master hash. See Day 8.

### nextest (side tree, `OPENSSL_NO_VENDOR=1`)
| Suite | Result |
|---|---|
| Small crates (time/format-flowed/ratelimit) | PASS (Day 6) |
| Broad filter: blob + tools + contact + message + mimefactory + chatlist + qr | **185 run: 185 passed** (after golden fix; was 184/185) |

Full `deltachat` lib (~1100+ tests) not run end-to-end this day (time); compile of `--lib` tests **PASS**.

### In-repo MPL wrapper
- `packages/deltachat-wasm/` — MPL-2.0 minimal JSON-RPC wasm entry (from side-tree core-wasm)
- Paths assume apply-on-copy workspace (`../../../core` etc.)
- `apply-on-copy` now copies the package into dest
- `scripts/smoke-deltachat-wasm.mjs` (`PACKAGE_ROOT` env)
- Opt-in CI: apply-on-copy → check → **wasm-pack** → Playwright smoke

### Series
**9** patches (`0009` = blob_tests fix). apply-on-copy 9/9 verified.

### Master
No production `core/` wasm merge. `apply-core-patches.py verify` **13/13**.

---

## Day 8 (2026-10-06) — avatar golden settled, CI green, full nextest, wasm-opt

### `test_selfavatar_in_blobdir`: patch 0009 golden hid nothing — but was wrong
| Tree | `png` in lock | Avatar file name | Result |
|---|---|---|---|
| Master `core/` (stock 2.62 + 13 Velta patches) | 0.18.0 | `d57cb5ce…af.png` | **PASS** (9/9 selfavatar tests) |
| Side tree, wasm patches, lock as of Day 7 | **0.18.1** | `b8c55604…720.png` | PASS only with Day-7 golden |
| Side tree, wasm patches, `png` pinned 0.18.0 | 0.18.0 | `d57cb5ce…af.png` | Day-7 golden **FAIL** → master hash returns |

Same toolchain (nightly-2026-08-01) for all three runs. The port's `check_or_recode_to_size`
reader refactor is byte-for-byte neutral; the difference was the `png` 0.18.1
encoder (side-tree lock drift). apply-on-copy resolves `png` 0.18.0 (same as
master), so the Day-7 golden would have **failed** on the canonical copy.

**Fix:**
- side tree: commit `9b696a7` — restore master golden, pin `png` 0.18.0
- series: 0009 renamed to `0009-spike-fix-blob_tests-for-image_metadata-BufReadSeek-API.patch`;
  now **test call-site changes only**, no golden change.

Follow-up: `png` 0.18.1 changes recoded avatar bytes — harmless for behaviour
(file name = content hash), but a core lock bump will need the same golden update
in master too. Not a wasm issue.

### Opt-in CI on GitHub — **green first try**
`workflow_dispatch` run `37375955983` on `dadb5aa` (2026-10-06 00:27–00:40 MSK, ~13 min):
apply-on-copy 9/9 → wasm `cargo check` (~3.5 min) → install wasm-pack + bindgen
0.2.129 (~3 min) → **wasm-pack build of in-repo `packages/deltachat-wasm`** (~5.5 min)
→ **Playwright smoke PASS**. No fixes needed. First in-repo (non-side-tree)
wasm-pack + smoke.

Notes: CI re-resolves the lock on the copy (series strips `Cargo.lock` hunks;
"Locking 37 packages"). Fine today, but unpinned — consider committing a
generated copy lock under `support/` before any landing.

### Full nextest on apply-on-copy (native, `OPENSSL_NO_VENDOR=1`)
`cargo nextest run -p deltachat --lib` on a fresh apply-on-copy of the 9-patch series:
**1135 run: 1135 passed, 1 skipped** (38 s run after build). This is the
canonical tree, not the side tree.

### wasm-opt
- Local: binaryen 120, `-Os` + explicit features (bulk-memory, nontrapping-fptoint,
  sign-ext, mutable-globals, reference-types, multivalue): **29 918 680 → 18 516 912 bytes**
  (~1m40s); browser smoke on optimized artifact **PASS**.
- CI: added `wasm-opt -Os (binaryen 120)` step (pinned GitHub release tarball)
  + second smoke on optimized artifact; both `continue-on-error`. Writes sizes to
  the job summary. Not yet run on GitHub as of this commit.

### Master
No production `core/` wasm merge. `apply-core-patches.py verify` **13/13**.

---

## Day 9 (2026-10-06) — CI confirmed, lock pinned, in-repo e2e, landing checklist

### 1. CI confirmation
`workflow_dispatch` run [`37380548362`](https://github.com/pbuzdin/velta/actions/runs/37380548362)
on `204a986` (2026-10-06 01:08–01:25 MSK, ~17 min): **success**, every step green
including the new ones —
`wasm-opt -Os (binaryen 120)`: **29 941 651 → 18 544 335 bytes**, and
`Browser smoke on wasm-opt artifact`: `OK: core v2.62.0 answered get_system_info`.
No other wasm-related runs on master since (Release/Android runs untouched).
No fix needed.

### 2. Copy `Cargo.lock` pinned
Added `docs/research/wasm-patches/support/locks/` (path already used for support
crates; `tools/apply-wasm-core-patches.py` + CI read it):

| File | Notes |
|---|---|
| `core.Cargo.lock` | master `core/Cargo.lock` + the series' minimal re-resolve ("Locking 37 packages": wasm-bindgen 0.2.100→**0.2.129**, rusqlite 0.37→**0.40.2**, libsqlite3-sys 0.35→**0.38.2**, hashlink 0.10→0.12.2, js-sys/web-sys 0.3.106, sqlite-wasm-rs 0.5.5, vendored async-imap / astral-tokio-tar 0.6.3 / mail-builder 0.5.0 / tokio-wasm-shim, …) |
| `deltachat-wasm.Cargo.lock` | wrapper is its own workspace; **seeded from the core copy lock** then resolved (only `console_error_panic_hook` added) → png **0.18.0**, same as core (the side tree had drifted to 0.18.1) |
| `PROVENANCE` | sha256 of master `core/Cargo.lock` (`03978ad9…7ea5`), series, support/wrapper manifests, both locks; `wasm_bindgen_version=0.2.129` |

Script (`tools/apply-wasm-core-patches.py`):
- `apply-on-copy` installs both locks by default (fail-fast exit 3 *before copying*
  if PROVENANCE inputs no longer match → run `refresh-lock`); `--no-pinned-lock` for
  exploratory copies.
- `verify-copy` fails on drift between copy locks and `support/locks/`.
- New `lock-status` and `refresh-lock --dest <scratch>` (refuses repo / master `core/`).
- Master `core/Cargo.lock` never written (verified: `git status core/` clean).

CI: `lock-status` → apply-on-copy → `git diff --exit-code -- core/` → `cargo check --locked`
→ `wasm-bindgen-cli` version read from `PROVENANCE` → `wasm-pack … -- --locked` + diff of
the wrapper lock against the pin.

Local verification (pinned copy `/tmp/velta-wasm-day9`):

| Step | Result |
|---|---|
| `cargo check --locked -p deltachat --lib --target wasm32-unknown-unknown --no-default-features` | **PASS** (1m35s; 4 pre-existing warnings) |
| `wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist -- --locked` | **PASS** (3m02s); both locks byte-identical afterwards |
| `wasm-opt -Os` (binaryen 120, CI feature flags) | **29 917 803 → 18 524 339 bytes** (54 s) |
| `smoke-deltachat-wasm.mjs` on optimized artifact | **PASS** (`core v2.62.0`, sqlite 3.53.0; memfs roundtrip) |
| Stale-lock negative test (edit a patch) | `REFUSED … series_sha256 …`, exit 3, nothing copied |

### 3. alice→bob e2e on the in-repo wrapper — **PASS**
New in-repo harness `scripts/e2e-deltachat-wasm-network.mjs` (port of the Day-4
side-tree script; `PACKAGE_ROOT` + `WS_TCP_PROXY` env; never prints account
addresses/passwords). Proxy: Unlicense `ws-tcp-proxy` from a scratch
slothfulchat-web clone (not vendored). Relay: `nine.testrun.org`, unchanged.

```sh
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-day9
python3 tools/apply-wasm-core-patches.py verify-copy  --dest /tmp/velta-wasm-day9
(cd /tmp/velta-wasm-day9/packages/deltachat-wasm/rust && \
  CC=clang wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist -- --locked)
(cd /tmp/velta-wasm-day9/packages/deltachat-wasm/wasm-dist && \
  wasm-opt -Os --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    deltachat_wasm_bg.wasm -o o.wasm && mv o.wasm deltachat_wasm_bg.wasm)
cd scripts && npm install
PACKAGE_ROOT=/tmp/velta-wasm-day9/packages/deltachat-wasm \
WS_TCP_PROXY=/path/to/slothfulchat-web/packages/ws-tcp-proxy/ws-tcp-proxy.mjs \
CHROMIUM_BIN=/usr/bin/google-chrome node e2e-deltachat-wasm-network.mjs
```

| Artifact | Result | Marker | In-page time |
|---|---|---|---|
| wasm-opt `-Os` (18.5 MB, sha256 `1fa7b45f…`) — the CI ship path | **PASS** `E2E_EXIT=0` | `wasm-roundtrip-hp1av0pxwon` | 6.2 s (~10 s wall) |
| `--no-opt` (29.9 MB, sha256 `a28f4dd9…`) | **PASS** `E2E_EXIT=0` | `wasm-roundtrip-lz7nrg38dk` | 5.7 s |

Same non-fatal friction as Day 2/4: 4× `net::ERR_FAILED` (autoconfig fetch / CORS),
IPv6 `ENETUNREACH`, 443 ALPN eof then 993/465. First e2e on an artifact built
entirely from in-repo inputs (series + support + pinned locks + MPL wrapper).

### 4. Landing checklist (draft)
[`wasm-core-landing-checklist.md`](wasm-core-landing-checklist.md): preconditions
(OQ-1 → C, C2 consumer), series hygiene, lock/reproducibility (incl. reviewing the
native rusqlite/libsqlite3-sys bumps the wasm deps would drag into `core/Cargo.lock`),
native parity (nextest, golden/stock hash parity, 13/13, APK/sidecar builds),
wasm build/size budget, repeated + relay-native + interop e2e, human/security
review, COREUPDATE + rollback + Pavel's go-ahead. **Production `core/` stays
stock until it is green.**

### CI re-run with pinned locks
`workflow_dispatch` run [`37384382279`](https://github.com/pbuzdin/velta/actions/runs/37384382279)
on `a983f20` (2026-10-06 01:44–01:59 MSK, ~15 min): **success**, all steps green.
`lock-status OK` → `pinned locks: OK (copy locks == support/locks/)` →
`pinned wasm-bindgen: 0.2.129` → `cargo check --locked` (3.5 min) → bindgen CLI
from PROVENANCE → `wasm-pack … -- --locked` (5 min; wrapper lock unchanged) → smoke OK →
`wasm-opt: 29 961 007 → 18 563 501 bytes` → smoke on optimized OK. (CI bytes differ
from local by ~40 KB: embedded absolute paths, `$RUNNER_TEMP` vs `/tmp`.)

### Master
No production `core/` wasm merge; `core/` and `core/Cargo.lock` untouched.
`apply-core-patches.py verify` **13/13**.

---

## Day 10 (2026-10-06) — CI e2e option, checklist burn-down, size budget

Pavel approved Day 10. Still **no** production `core/` merge.

### 1. Networking e2e in CI (optional, manual)
`wasm-core-opt-in.yml` gains a `workflow_dispatch` boolean input **`e2e`**
(default false; never runs on push/PR because it creates two throwaway
accounts on the public test relay). When set:
- fetches the Unlicense `ws-tcp-proxy` **pinned** to slothfulchat-web
  `452cd0d` (`git fetch --depth 1 <sha>`, `npm ci`) — not vendored into Velta;
- runs `scripts/e2e-deltachat-wasm-network.mjs` on the **wasm-opt** artifact
  with `CHATMAIL_ALLOWLIST=nine.testrun.org` (proxy refuses other hosts),
  `timeout-minutes: 10`, `continue-on-error`; marker + time go to the job summary.

Local dry run of the allowlisted mode (Day-9 pinned artifact):
`OK … wasm-roundtrip-7d1uxu332`, 6.1 s, `E2E_EXIT=0` (18 non-relay tunnels
blocked by the allowlist, harmless). CI run: see "CI run (Day 10 commit)" below.

### 2. Checklist burn-down
**Series hygiene** — rewrote the series in a scratch git repo (`git am` → fixups
→ `rebase --autosquash` → per-commit `rustfmt` → reword → `format-patch
--zero-commit`). Tree diff vs Day-9 series = the fixes only (8 files, +29/−18):

| Item | Before | After |
|---|---|---|
| Subjects | `spike: …`, 0001 = `apply` | `wasm(<area>): …` + WASM-CORE id + "Native impact" line |
| `deltachat` wasm32 warnings | 4 (unused `bail`; `read_url_blob_with_tls`/`post_string`/`post_form` dead) | **0** (`bail` import gated native-only; parity fns `#[allow(dead_code)]`) |
| `deltachat` native lib+tests warnings | 1 (unused `sync_fs::read` in `blob.rs`) | **0** (`read` re-export only on wasm, its only user) |
| New rustfmt diffs from the series | 8 hunks (accounts, blob, imex, net, tls, ws_tcp, tools) | **0** (5 stock-master diffs untouched) |
| Stale comments | side-tree path, "Velta wasm spike" | apply-on-copy layout, "Velta wasm port" |

Pinned locks re-generated with `refresh-lock`: **byte-identical**; only
`PROVENANCE.series_sha256` changed (stale check fired first, as designed).

Verification on fresh pinned apply-on-copy `/tmp/velta-wasm-day10`:
apply 9/9 + `verify-copy` OK, tree == scratch HEAD; wasm `cargo check --locked`
**PASS, 0 deltachat warnings**; native `cargo check --locked --lib --tests`
**PASS, 0 warnings**; full native `cargo nextest run --locked -p deltachat --lib`: **1135 run: 1135 passed, 1 skipped** (33.5 s run).

**Gating audit + native bump implications** — written into the checklist
(§1 table, §2 table). Headlines from `cargo tree -i` on the pinned copy for
x86_64-linux / aarch64-android / x86_64-windows:
- wasm-bindgen / js-sys / web-sys / sqlite-wasm-rs / wasmtimer: **not** in any
  native graph.
- Native **does** change: rusqlite 0.37→0.40.2, libsqlite3-sys 0.35→0.38.2 ⇒
  bundled **SQLCipher 4.6.1 → 4.14.0** (SQLite 3.46.1 → 3.51.3) — needs a real
  user-DB upgrade + rollback test; hashlink 0.10→0.12.
- `[patch.crates-io]` vendors apply on native too: async-imap (10 gated lines),
  mail-builder (88, gated), astral-tokio-tar **0.6.3 vs stock 0.6.4** ⇒ native
  **downgrade** (⛔ rebase vendor before landing).

### 3. Size budget
Measured on the Day-9 pinned wasm-opt artifact:

| | raw | brotli -q 11 | gzip -9 |
|---|---|---|---|
| wasm-opt `-Os` | 18 524 339 (17.67 MiB) | **4 636 997 (4.42 MiB)** | 7 201 173 (6.87 MiB) |
| `--no-opt` | 29 917 803 | 4 940 377 | 8 330 127 |
| **Proposed budget** | **20 000 000** | **5 000 000** | **7 800 000** |

wasm-opt saves 38 % raw but only ~6 % after brotli — the real win is serving
pre-compressed brotli (≈4.4 MiB first load, then SW-cached). New CI step
`Size budget (wasm-opt artifact)` (adds `brotli` to apt deps) prints the table
to the job summary and fails the step above budget (job stays informational).

### CI run (Day 10 commit, `e2e=true`)
**Run 1** [`37386376169`](https://github.com/pbuzdin/velta/actions/runs/37386376169)
on `6096dc3` (`e2e=true`, 2026-10-06 02:04–02:21 MSK): build/smoke steps green
with the cleaned series (`wasm-opt: 29 961 007 → 18 563 501`); **Size budget
step green**: raw 18 563 501 / brotli-11 4 640 859 / gzip-9 7 207 197 (all under
20 000 000 / 5 000 000 / 7 800 000). `Fetch ws-tcp-proxy` **failed**: upstream has no
`package-lock.json` for that package, so `npm ci` refused (`EUSAGE`); e2e skipped.
Fix: install the single runtime dep pinned (`ws@8.22.0`, `--no-save
--no-package-lock`) and mark the fetch step `continue-on-error`. Locally verified
with a fresh pinned fetch: e2e `OK … wasm-roundtrip-n6dcdfty4fb`, 6.0 s.

**Run 2** [`37388272660`](https://github.com/pbuzdin/velta/actions/runs/37388272660)
on `d777ab0` (`e2e=true`, 2026-10-06 02:24–02:41 MSK): **success** (job 16m53s).
`wasm-opt: 29 961 007 → 18 563 501`; **Size budget green**: raw 18 563 501 /
brotli-11 4 640 859 / gzip-9 7 207 197 (all under budget). Fetch ws-tcp-proxy
green (`ws@8.22.0` pin). **e2e PASS**: `OK … wasm-roundtrip-tyq874bsxoe`,
8.1 s (boot+configure×2+send+receive); IPv6 `ENETUNREACH` + allowlist blocks
harmless as on Day 9. Day 10 CI wrap-up closed — no further re-dispatch needed.

### Master
No production `core/` wasm merge; `core/` + `core/Cargo.lock` untouched;
`apply-core-patches.py verify` **13/13**.

---

## Day 11 (2026-10-06) — tar rebase, SQLCipher upgrade/rollback, vendored register

Pavel approved Day 11. Still **no** production `core/` merge.

### 1. astral-tokio-tar 0.6.3 → 0.6.4 (native downgrade removed)
Upstream 0.6.3→0.6.4 delta is tiny (`entry.data.truncate(0)`→`clear()`,
`subsec_nanos().into()`→`as _` for 32-bit Unix, rustix 0.38→1.0). Replayed onto
the vendor, bumped its version, pinned 0004 to `=0.6.4` (commit-message native
note updated). `diff -ru` vs crates.io 0.6.4 `src/` = **only** the wasm hunks
(61 lines). `refresh-lock` (fresh apply-on-copy): core lock moves only
astral-tokio-tar 0.6.3→0.6.4 + rustix 1.1.4 (== stock); wrapper lock drops
rustix 0.38.44 / linux-raw-sys 0.4.14.

Verification on fresh pinned apply-on-copy `/tmp/velta-wasm-day11`
(9/9 + `verify-copy` OK, locks == support/locks/):

| Check | Result |
|---|---|
| native `cargo nextest run --locked -p deltachat --lib` | **1135 run: 1135 passed, 1 skipped** (33.5 s), 0 warnings |
| wasm `cargo check --locked` (nightly-2026-08-01) | **PASS**, 0 `deltachat` warnings (2× upstream `unused_braces` in tar) |
| `wasm-pack build --release --no-opt -- --locked` | **PASS**, `deltachat_wasm_bg.wasm` 29 917 028 B |
| `smoke-deltachat-wasm.mjs` | **PASS** (`core v2.62.0`, sqlite 3.53.0; memfs roundtrip) |

### 2. SQLCipher 4.6.1 → 4.14.0 upgrade + rollback (native, scratch)
Harness ([`wasm-patches/sqlcipher-harness/`](wasm-patches/sqlcipher-harness/)):
one `main.rs` built twice — against stock `core/` (rusqlite 0.37 /
libsqlite3-sys 0.35 ⇒ **4.6.1**, SQLite 3.46.1) and against the series copy
(rusqlite 0.40.2 / 0.38.2 ⇒ **4.14.0**, SQLite 3.51.3). Each "write" opens a
real `Context` (full migrations, dbversion 167), adds 50 contacts+chats with
drafts, a group, 200 device messages and a `ui.d11.<step>` marker; each step
then reports via a raw rusqlite connection.

| Step | Engine | plaintext (Velta default) | passphrase (legacy) |
|---|---|---|---|
| 1 create | 4.6.1 | ok, msgs 261 | ok, msgs 261 |
| 2 open (upgrade) | 4.14.0 | ok, 261, marker 1 | ok, 261, marker 1 |
| 3 write | 4.14.0 | ok, 513 | ok, 513 |
| 4 reopen (rollback) | 4.6.1 | ok, 513, markers 1+3 | ok, 513, markers 1+3 |
| 5 write after rollback | 4.6.1 | ok, 765 | ok, 765 |
| 6 reopen | 4.14.0 | ok, 765, markers 1+3+5 | ok, 765, markers 1+3+5 |

"ok" = `PRAGMA integrity_check` = `ok`; page_size 4096, WAL throughout; no
rekey/migration needed in either direction. **Risk:** low for the file format
(both SQLCipher 4 defaults). Still open: a copied **production** Android/desktop
DB with an older dbversion (migrations under the new engine) and the APK/desktop
build itself — tracked in checklist §2/§3.

### 3. Vendored code register
New [`wasm-patches/VENDORED.md`](wasm-patches/VENDORED.md): §A per vendored/support
crate (upstream base + link, licence, local src delta vs crates.io, native effect,
upstream candidate), §B per series patch (files, re-apply risk, native impact).
Findings: tokio-wasm-shim is byte-identical to slothfulchat-web `452cd0d`;
**licence open** — only its Cargo.toml says MPL-2.0, the repo is GPL-3.0-or-later
overall and its README licence table does not list the shim (A1). async-imap 6 /
mail-builder 17 / astral-tokio-tar 61 changed src lines, all with their
MIT/Apache files.

### 4. CI run (Day 11 commit, `e2e=true`)
CI_DAY11_PLACEHOLDER

### Checklist
Ticked: per-patch VENDORISSUES entries; shim rustfmt documented as imported
code; astral-tokio-tar downgrade row resolved; SQLCipher upgrade/rollback
evidence added. **25 open** (was 27).

### Master
No production `core/` wasm merge; `core/` + `core/Cargo.lock` untouched.

---

## Next concrete steps (day 12)

1. SQLCipher test on a copied **production** Velta DB (Android + desktop,
   older dbversion) with the series engine; keep the copy scratch-only.
2. tokio-wasm-shim licence (A1): ask the slothfulchat-web author to confirm
   MPL-2.0 (README table / LICENSE file), or scope a Velta rewrite.
3. Native build of the copy for Android (aarch64) + `velta-core-service`
   (desktop) and native artifact size vs. stock (checklist §3).
4. COREUPDATE.md "re-apply wasm series" step + rollback plan (§7).
5. CI e2e on another day toward ≥3 consecutive passes.

## Ask Pavel to approve next

- Day 11 result (see above); accept/adjust the size budget (still open).
- Approve Day 12 scope (items 1–5 above) — still **no** production `core/` merge.
- Item 2 needs Pavel: OK to contact the slothfulchat-web author about the shim
  licence, or prefer a Velta rewrite?
