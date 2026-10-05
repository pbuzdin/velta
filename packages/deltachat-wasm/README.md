# deltachat-wasm (MPL-2.0)

Minimal wasm-bindgen JSON-RPC entry for Velta’s **opt-in** wasm core port.

**Do not** build this against master `core/` (unpatched). Use
`tools/apply-wasm-core-patches.py apply-on-copy` first — the applicator copies
this package into the destination workspace next to the patched core.

```sh
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
cd /tmp/velta-wasm-copy/packages/deltachat-wasm/rust
CC=clang wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist -- --locked
```

`apply-on-copy` installs the pinned `Cargo.lock` for this crate from
`docs/research/wasm-patches/support/locks/deltachat-wasm.Cargo.lock`.

Networking e2e (alice→bob through a local `ws-tcp-proxy`):

```sh
cd scripts && npm install
PACKAGE_ROOT=/tmp/velta-wasm-copy/packages/deltachat-wasm \
  WS_TCP_PROXY=/path/to/ws-tcp-proxy.mjs node e2e-deltachat-wasm-network.mjs
```

See `docs/research/wasm-patches/README.md`.
