//! Paint a phone-sized Velta chat with vello_cpu (the Aquilum raster path)
//! and write frame timings. Windowing is intentionally absent: this is the
//! paint cost, not winit / Android Surface.

use std::fs;
use std::time::Instant;

use ttf_parser::Face;
use vello_cpu::color::palette::css;
use vello_cpu::kurbo::{Rect, RoundedRect, Shape};
use vello_cpu::peniko::{Blob, FontData};
use vello_cpu::{Glyph, Level, Pixmap, RenderContext, RenderSettings, Resources};

const FONT_PATH: &str = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";
const SENTENCES: [&str; 4] = [
    "Beam finished. The file never touched a relay.",
    "Three of us are on the circle tonight.",
    "Proxy is up. The hop stayed quiet.",
    "Send the cut as a beam, not a link.",
];

struct Bubble {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    mine: bool,
    text: &'static str,
}

struct Scene {
    id: &'static str,
    label: &'static str,
    detail: &'static str,
    w: u16,
    h: u16,
    chrome: bool,
    rounded: bool,
    with_text: bool,
    atlas: bool,
    bubbles: Vec<Bubble>,
}

fn cpu_model() -> String {
    fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split(':').nth(1))
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn bubbles(count: usize, width: f64, bottom: f64) -> Vec<Bubble> {
    let mut out = Vec::with_capacity(count);
    let mut y = bottom;
    for i in 0..count {
        let mine = i % 2 == 0;
        let w = if mine { width * 0.72 } else { width * 0.78 };
        let h = 132.0;
        let x = if mine { 48.0 + (width - 96.0 - w) } else { 48.0 };
        y -= h;
        out.push(Bubble {
            x,
            y,
            w,
            h,
            mine,
            text: SENTENCES[i % SENTENCES.len()],
        });
        y -= 28.0;
    }
    out
}

fn scenes() -> Vec<Scene> {
    let phone_w = 1080.0;
    let content_bottom = 2400.0 - 200.0;
    vec![
        Scene {
            id: "screen-shapes",
            label: "One screen, bubbles only",
            detail: "8 rounded bubbles, no glyphs. Header and composer included.",
            w: 1080,
            h: 2400,
            chrome: true,
            rounded: true,
            with_text: false,
            atlas: false,
            bubbles: bubbles(8, phone_w, content_bottom),
        },
        Scene {
            id: "screen-sharp",
            label: "One screen, sharp rectangles",
            detail: "Same 8 bubbles as plain rects, to isolate corner-curve cost.",
            w: 1080,
            h: 2400,
            chrome: true,
            rounded: false,
            with_text: false,
            atlas: false,
            bubbles: bubbles(8, phone_w, content_bottom),
        },
        Scene {
            id: "screen-text",
            label: "One screen, bubbles and text",
            detail: "What a visible Velta thread paints. Glyphs via cmap, not HarfRust.",
            w: 1080,
            h: 2400,
            chrome: true,
            rounded: true,
            with_text: true,
            atlas: false,
            bubbles: bubbles(8, phone_w, content_bottom),
        },
        Scene {
            id: "screen-atlas",
            label: "One screen, glyph atlas on",
            detail: "Same thread with vello_cpu's experimental glyph atlas enabled.",
            w: 1080,
            h: 2400,
            chrome: true,
            rounded: true,
            with_text: true,
            atlas: true,
            bubbles: bubbles(8, phone_w, content_bottom),
        },
        Scene {
            id: "history",
            label: "Unwindowed history",
            detail: "40 bubbles encoded into one 1080×2400 frame, most of them above the glass.",
            w: 1080,
            h: 2400,
            chrome: true,
            rounded: true,
            with_text: true,
            atlas: false,
            bubbles: bubbles(40, phone_w, content_bottom),
        },
        Scene {
            id: "dirty",
            label: "Dirty strip, one new message",
            detail: "Only the bottom 420px, one bubble and its line of text.",
            w: 1080,
            h: 420,
            chrome: false,
            rounded: true,
            with_text: true,
            atlas: false,
            bubbles: bubbles(1, phone_w, 380.0),
        },
    ]
}

fn fill_bubble(ctx: &mut RenderContext, b: &Bubble, rounded: bool) {
    let rect = Rect::new(b.x, b.y, b.x + b.w, b.y + b.h);
    if b.mine {
        ctx.set_paint(css::STEEL_BLUE);
    } else {
        ctx.set_paint(css::DIM_GRAY);
    }
    if rounded {
        let path = RoundedRect::from_rect(rect, 36.0).to_path(0.3);
        ctx.fill_path(&path);
    } else {
        ctx.fill_rect(&rect);
    }
}

fn paint_line(
    ctx: &mut RenderContext,
    resources: &mut Resources,
    font: &FontData,
    face: &Face<'_>,
    text: &str,
    x: f32,
    baseline: f32,
    size: f32,
    atlas: bool,
) -> usize {
    let scale = size / face.units_per_em() as f32;
    let mut pen = 0.0_f32;
    let mut glyphs = Vec::new();
    for ch in text.chars() {
        let Some(gid) = face.glyph_index(ch) else {
            pen += size * 0.45;
            continue;
        };
        let adv = face.glyph_hor_advance(gid).unwrap_or(500) as f32 * scale;
        glyphs.push(Glyph {
            id: gid.0 as u32,
            x: pen,
            y: 0.0,
        });
        pen += adv;
    }
    let n = glyphs.len();
    if n == 0 {
        return 0;
    }
    ctx.set_paint(css::WHITE);
    ctx.set_transform(vello_cpu::kurbo::Affine::translate((
        x as f64,
        baseline as f64,
    )));
    let drawn = ctx
        .glyph_run(resources, font)
        .font_size(size)
        .atlas_cache(atlas)
        .fill_glyphs(glyphs.into_iter());
    ctx.reset_transform();
    match drawn {
        Ok(()) => n,
        Err(_) => n,
    }
}

struct Pass {
    glyphs: usize,
    encode_ms: f64,
    raster_ms: f64,
    ink: usize,
}

fn draw_scene(
    ctx: &mut RenderContext,
    resources: &mut Resources,
    font: &FontData,
    face: &Face<'_>,
    scene: &Scene,
) -> (usize, f64) {
    let t0 = Instant::now();
    ctx.reset();
    ctx.set_paint(css::BLACK);
    ctx.fill_rect(&Rect::new(0.0, 0.0, scene.w as f64, scene.h as f64));
    if scene.chrome {
        ctx.set_paint(css::DARK_SLATE_GRAY);
        ctx.fill_rect(&Rect::new(0.0, 0.0, scene.w as f64, 150.0));
        ctx.fill_rect(&Rect::new(
            0.0,
            scene.h as f64 - 170.0,
            scene.w as f64,
            scene.h as f64,
        ));
    }
    for b in &scene.bubbles {
        fill_bubble(ctx, b, scene.rounded);
    }
    let mut glyphs = 0;
    if scene.with_text {
        for b in &scene.bubbles {
            glyphs += paint_line(
                ctx,
                resources,
                font,
                face,
                b.text,
                (b.x + 28.0) as f32,
                (b.y + 78.0) as f32,
                42.0,
                scene.atlas,
            );
        }
    }
    ctx.flush();
    let encode_ms = t0.elapsed().as_secs_f64() * 1000.0;
    (glyphs, encode_ms)
}

fn pass(
    ctx: &mut RenderContext,
    pixmap: &mut Pixmap,
    resources: &mut Resources,
    font: &FontData,
    face: &Face<'_>,
    scene: &Scene,
) -> Pass {
    let (glyphs, encode_ms) = draw_scene(ctx, resources, font, face, scene);
    let t1 = Instant::now();
    ctx.render(&mut *pixmap, resources);
    let raster_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let ink = pixmap.data().iter().filter(|p| p.a != 0).count();
    Pass {
        glyphs,
        encode_ms,
        raster_ms,
        ink,
    }
}

fn bench_scene(
    scene: &Scene,
    threads: u16,
    font: &FontData,
    face: &Face<'_>,
) -> serde_json::Value {
    let settings = RenderSettings {
        level: Level::new(),
        num_threads: threads,
    };
    let mut ctx = RenderContext::new_with(scene.w, scene.h, settings);
    let mut pixmap = Pixmap::new(scene.w, scene.h);
    let mut resources = Resources::new();

    let cold = pass(&mut ctx, &mut pixmap, &mut resources, font, face, scene);
    let mut warm = Vec::with_capacity(5);
    for _ in 0..5 {
        warm.push(pass(
            &mut ctx,
            &mut pixmap,
            &mut resources,
            font,
            face,
            scene,
        ));
    }
    let mut totals: Vec<f64> = warm.iter().map(|p| p.encode_ms + p.raster_ms).collect();
    let mut encodes: Vec<f64> = warm.iter().map(|p| p.encode_ms).collect();
    let mut rasters: Vec<f64> = warm.iter().map(|p| p.raster_ms).collect();
    let glyphs = warm.last().map(|p| p.glyphs).unwrap_or(0);

    serde_json::json!({
        "id": format!("{}-t{}", scene.id, threads),
        "scene": scene.id,
        "label": scene.label,
        "detail": scene.detail,
        "width": scene.w,
        "height": scene.h,
        "bubbles": scene.bubbles.len(),
        "glyphs": glyphs,
        "threads": threads,
        "coldMs": round(cold.encode_ms + cold.raster_ms),
        "encodeMs": round(median(&mut encodes)),
        "rasterMs": round(median(&mut rasters)),
        "totalMs": round(median(&mut totals)),
        "inkPixels": cold.ink,
    })
}

fn median(xs: &mut [f64]) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    xs[xs.len() / 2]
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn main() {
    let font_bytes = fs::read(FONT_PATH).expect("liberation sans");
    let face = Face::parse(&font_bytes, 0).expect("face");
    let font = FontData::new(Blob::from(font_bytes.clone()), 0);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let extra_threads: u16 = (cores.saturating_sub(1)).clamp(1, 4) as u16;

    let mut runs = Vec::new();
    for scene in scenes() {
        runs.push(bench_scene(&scene, 0, &font, &face));
        if scene.id == "screen-text" || scene.id == "history" || scene.id == "dirty" {
            runs.push(bench_scene(&scene, extra_threads, &font, &face));
        }
    }

    let framebuffer = 1080u64 * 2400 * 4;
    let out = serde_json::json!({
        "ready": true,
        "renderer": "vello_cpu 0.3.0",
        "simd": format!("{:?}", Level::new()),
        "cpu": cpu_model(),
        "logicalCores": cores,
        "extraThreads": extra_threads,
        "font": "Liberation Sans",
        "shaping": "cmap only — HarfRust / Parley not in this pass",
        "surface": "1080×2400 phone framebuffer, premultiplied RGBA8",
        "framebufferBytes": framebuffer,
        "windowing": "not included — paint only, no winit and no Android surface",
        "runs": runs,
    });

    let path = "results.json";
    fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("{out}");
}
