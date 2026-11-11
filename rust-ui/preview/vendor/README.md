# Masonry winit host fork (glass experiment)

`masonry_winit` is copied from linebender/xilem revision `dc49687`, Apache-2.0
(license included). Its workspace metadata/dependencies are expanded into the
standalone manifest; the preview patches only this crate. Masonry, imaging and
Vello remain pinned upstream, unmodified. Changes carry `velta-glass:` markers:

- `glass.rs` / `glass.wgsl`: bounded logical rectangles, cached two-texture
  compositor and rounded-rect lens shader.
- `event_loop_runner.rs`: replay root and overlays separately, composite, then
  use the existing surface blit.
- `vello_util.rs`: per-surface compositor lifetime; resize lazily recreates it.
- `lib.rs` / `Cargo.toml`: optional `glass` feature and public rectangle API.

To compare with upstream, diff `src/` against the same revision's
`masonry_winit/src/`. No core patches are involved.
