# velta-wasm (MPL-2.0)

Minimal wasm-bindgen JSON-RPC entry for Velta’s **opt-in** wasm core port.

**Do not** build this against master `core/` (unpatched). Use
`tools/apply-wasm-core-patches.py apply-on-copy` first — the applicator copies
this package into the destination workspace next to the patched core.

```sh
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
cd /tmp/velta-wasm-copy/packages/velta-wasm/rust
CC=clang wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist -- --locked
```

`apply-on-copy` installs the pinned `Cargo.lock` for this crate from
`docs/research/wasm-patches/support/locks/velta-wasm.Cargo.lock`.

**wasm-bindgen version:** the pinned `wasm-bindgen` crate (0.2.129, see
`wasm_bindgen_version` in `docs/research/wasm-patches/support/locks/PROVENANCE`)
must match the `wasm-bindgen-cli` that generates the glue. CI installs
`wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"` from that pin; for local
builds use a wasm-pack release whose bundled wasm-bindgen matches, otherwise
the build fails with a version-mismatch error. Check with
`wasm-pack --version` and `cargo install --list | grep wasm-bindgen-cli`.

**Exports used by the PWA worker** (`app/js/worker-wasm.js`): `init`, the
memfs `vfs_*` functions, and `sqlite_list` / `sqlite_export` /
`sqlite_import`. SQLite runs in sqlite-wasm-rs's in-memory VFS, not the
memfs, so the account databases are only saved through the `sqlite_*`
calls (#123). Changing `Cargo.toml` makes the pinned locks stale: run
`python3 tools/apply-wasm-core-patches.py refresh-lock --dest /tmp/velta-wasm-lock`
and commit the refreshed locks. Local builds need
`rustup toolchain install nightly-2026-08-01 --target wasm32-unknown-unknown`
and clang, then
`CC=clang rustup run nightly-2026-08-01 wasm-pack build ...` as above.

Networking e2e (alice→bob through a local `ws-tcp-proxy`):

```sh
cd scripts && npm install
PACKAGE_ROOT=/tmp/velta-wasm-copy/packages/velta-wasm \
  WS_TCP_PROXY=/path/to/ws-tcp-proxy.mjs node e2e-velta-wasm-network.mjs
```

Relay-native e2e against a deployed C3 relay (no local proxy):

```sh
cd scripts && npm install
PACKAGE_ROOT=/tmp/velta-wasm-copy/packages/velta-wasm \
  RELAY_WS_URL=wss://<relay> CHATMAIL_NEW=https://<relay>/new \
  node e2e-velta-wasm-network.mjs
```

See `docs/research/wasm-patches/README.md`.
