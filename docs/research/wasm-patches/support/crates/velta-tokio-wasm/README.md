# velta-tokio-wasm

SPDX-License-Identifier: MPL-2.0 — Velta-original, written clean-room on
2026-10-06 (method and inputs: [`../../../velta-tokio-wasm-requirements.md`](../../../velta-tokio-wasm-requirements.md)).

`tokio` stand-in used by Velta's **opt-in** wasm build of chatmail core. The
wasm patch series renames core's `tokio` dependency to this crate on every
target (Cargo cannot vary a dependency's source by target):

- native: `pub use tokio::*` (feature `full`) — identical to tokio;
- `wasm32-unknown-unknown`: tokio's `io`/`sync`/macros plus browser-backed
  `time` (wasmtimer), `task` (wasm-bindgen-futures), an in-memory `fs`
  (+ `sync_*` helpers for the JS side channel) and `net` stubs that return
  `Unsupported`.

No persistence: the in-memory filesystem vanishes with the page (OPFS is a
separate, open checklist item).
