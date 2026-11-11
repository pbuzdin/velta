# Rust UI: liquid glass with real refraction (#315 Phase B)

Goal: the composer plate (and later any surface) renders as liquid glass —
a real, distorted view of the content behind it (refraction + frost +
specular), like the web app's opt-in glass-composer (Chromium SVG
displacement), but native.

Status: design agreed 2026-11-11. Renderer spike (`--features skia`) in
flight; the fork work below starts only after skia renders the UI on a
real phone.

## Why Skia

The frame model at pin `dc49687` is flat: `RenderRoot::redraw()` produces a
`VisualLayerPlan` (root scene + overlays), `masonry_winit` flattens it into
`masonry_imaging::PreparedFrame`, and a backend `PaintSink` replays it.
Nothing in this pipeline has a backdrop-filter concept:

- vello/vello_hybrid: no refraction/displacement primitive; no custom
  shaders from widget code; GPU flavor also deadlocks on Adreno (desktop
  only).
- imaging_skia: Skia has the full image-filter suite, including
  `DisplacementMapEffect` (true refraction driven by a displacement image),
  blur, and color filters — the same machinery behind Flutter's
  `BackdropFilter`.

The vello backends keep a translucent-tint fallback ("faux glass", Phase A);
the skia backend implements the real effect.

## The effect (skia filter chain, per glass rect)

1. **Backdrop capture**: snapshot the canvas region behind the glass rect
   (device-space rounded rect) into an image.
2. **Refraction**: `DisplacementMapEffect` with a generated lens map —
   rounded-rect normal map: center displacement ≈ 0, edges bend inward
   with a smooth falloff (the "liquid" edge). Scale = refraction strength.
3. **Frost**: `BlurEffect` (sigma as a theme token, default ~8px logical).
4. **Chromatic aberration** (optional, subtle): draw the displaced image
   three times with per-channel scales slightly above 1.0, composite
   plus/lighter at low alpha.
5. **Plate**: tint fill (theme token, ~8% white or accent), 1px inner
   specular stroke (gradient along the top edge), inner shadow at the
   bottom; rounded rect clip throughout.

All glass params (radius, tint, frost sigma, refraction scale) become
Masonry theme properties so the effect follows the design system.

## Fork surface (three crates, one `[patch]` guard)

| Crate | Change |
|---|---|
| `masonry_core` | `VisualLayerKind::Glass { rect, params }` in the layer plan; painted by a `GlassRect` widget (any widget can emit it via the paint pass). |
| `masonry_winit` | Frame builder passes glass layers through to `PreparedFrame` (new field, not an overlay: glass must see the layers painted *before* it). |
| `imaging_skia` | In the `PaintSink` impl: when a glass layer is reached, snapshot the already-drawn canvas region, run the filter chain, then replay the glass scene content. CPU renderer (`SkiaCpuRenderer`) uses the same chain on the raster surface. |

Guarded by a `glass` cargo feature in the preview; the forks live in a
`velta` branch of our xilem/imaging clones at rev `dc49687` + commits, wired
via `[patch.crates-io]` (git). Rev bumps rebase the branch; keep the diff
small and upstream-shaped so it can be proposed upstream later.

## Spike gates (in order)

1. **Skia renders at all** (`--features skia` APK boots and draws on the
   vivo; Skia's GPU path needs no compute, unlike the vello path that
   deadlocks on Adreno — but that's exactly what the boot test answers).
2. **Skia holds up as a renderer**: scroll/type feel, frame time vs hybrid,
   emoji/font rendering parity.
3. **Sink access**: confirm `imaging_skia`'s sink can snapshot its own canvas
   (or patch it to expose the `SkCanvas`).
4. **Prototype the chain offline**: render the app frame to a PNG, apply the
   filter chain in a small skia test binary, eyeball the result — before any
   widget plumbing.
5. Then the fork.

## Fallbacks

- If skia fails gate 1 on Android: Phase A faux glass ships on vello_hybrid,
  skia stays the desktop glass path; revisit when upstream skia/wgpu evolve.
- If gate 3 needs a deep imaging-crate patch: do the offline prototype first
  to validate the visual, then decide whether the patch is worth carrying.
