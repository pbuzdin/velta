# deltachat-wasm (MPL-2.0)

Minimal wasm-bindgen JSON-RPC entry for Velta’s **opt-in** wasm core port.

**Do not** build this against master `core/` (unpatched). Use
`tools/apply-wasm-core-patches.py apply-on-copy` first — the applicator copies
this package into the destination workspace next to the patched core.

```sh
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
cd /tmp/velta-wasm-copy/packages/deltachat-wasm/rust
CC=clang wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist
```

See `docs/research/wasm-patches/README.md`.
