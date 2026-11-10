# Velta vello_cpu bench

Paints a phone-sized Velta chat with vello_cpu 0.3 (Aquilum's CPU renderer)
and writes frame timings. No window, no winit, no Android surface.

```
cargo run --release
```

Writes `results.json` in the current directory.

Needs Liberation Sans at
`/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf`
(Debian/Ubuntu package `fonts-liberation`).

The `results.json` already in this zip is the run that was measured:
Xeon Platinum 8481C, 2 cores, AVX-512, 1080×2400.
The only change from that run is the output path (`results.json` instead of a sandbox path).
