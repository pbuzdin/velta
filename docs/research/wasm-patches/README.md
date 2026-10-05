# Velta wasm core patches — home and ownership

**Answer (Pavel / Day 5):** yes — Velta will have its **own fresh wasm core**,
meaning a **Velta-owned forward-port of chatmail/core 2.62+** targeting
`wasm32-unknown-unknown`, not a fork or submodule of
`experintellia/slothfulchat-web`.

| We do | We do not |
|---|---|
| Port MPL-2.0 (or dual MPL/GPL) **ideas** from the prototype’s WASM-CORE patches | Copy the GPL web app / desktop frontend into Velta |
| Keep a Velta-built `deltachat-wasm` wrapper (MPL) + Unlicense-style WS→TCP bridge pattern | Depend on slothfulchat-web as the long-term source tree |
| Gate Android/desktop so they stay on the native path | Apply wasm patches in production CI by default |

## Where the code lives today

| Location | Role |
|---|---|
| Spike side tree `/workspace/velta-wasm-port` | **Source of truth** for the experimental 2.62 port (Day 3–5) |
| `packages/core-wasm` inside that side tree | Fresh Velta MPL wasm artifact path (`wasm-dist/deltachat_wasm_bg.wasm`) |
| This directory | Landing pad for **extracted** patch files + this policy doc |
| `tools/apply-wasm-core-patches.py` | **Opt-in** applicator (refuses `apply` until patches are extracted) |

Master `core/` stays on Velta’s existing 13 patches only
(`tools/apply-core-patches.py`). No wasm merge until native + wasm gates are
both green on a reviewed landing.

## Long-term patch home — **decision (Day 5)**

**Near-term (chosen): opt-in second apply layer**, separate from the 13
production patches.

1. Extract discrete patch units (or a documented replay script) from the side
   tree into `docs/research/wasm-patches/` (or `patches/wasm-core/` later).
2. `tools/apply-wasm-core-patches.py` applies them only when explicitly invoked
   (wasm CI / developer machines building the PWA core). Android/desktop and
   default `cargo check` on master never run it.
3. Prefer `cfg(target_arch = "wasm32")` inside those patches so a single tree
   can serve native + wasm once merged.

**Longer-term aspiration:** collapse as much as possible into upstreamable
`cfg(target_arch = "wasm32")` gates and contribute upstream to chatmail/core
where they will take it. That reduces the Velta-only apply surface over time —
it does **not** replace the “Velta-owned port” ownership story.

**Rejected for now:** dumping raw prototype patches into
`apply-core-patches.py` (would risk Android/desktop), or treating
slothfulchat-web as the canonical tree.

## Artifact path (“fresh” Velta wasm core)

On the spike host after Day 4:

```text
/workspace/velta-wasm-port/packages/core-wasm/wasm-dist/deltachat_wasm_bg.wasm
```

Built with Velta’s 2.62 side-tree core + MPL `deltachat-wasm` wrapper. That is
the fresh Velta artifact; the Day-1 ~28 MB file from slothfulchat was only the
prototype proof.

Sizes (Day 5): **~29 MB** `--no-opt`; **~18 MB** after `wasm-opt -Os`
(binaryen 120). Prefer shipping the optimized build when `wasm-opt` is on PATH.

## See also

- Spike log: [`../wasm-core-mail-proxy-spike.md`](../wasm-core-mail-proxy-spike.md)
- Inventory: [`../wasm-core-port-inventory.md`](../wasm-core-port-inventory.md)
- Research: [`../wasm-core-mail-proxy.md`](../wasm-core-mail-proxy.md)
