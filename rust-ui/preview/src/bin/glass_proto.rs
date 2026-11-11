//! Liquid-glass filter-chain prototype (glass spike gate 4, docs/agents/rust-ui-glass.md).
//!
//! Draws a synthetic chat frame with skia, then renders a glass plate over one
//! region using the real chain: backdrop snapshot -> displacement-map lens ->
//! frost blur -> chromatic aberration -> tint + specular. Writes before.png and
//! after.png so the visual can be judged before any Masonry fork.
//!
//!     cargo run --release --bin glass_proto --features skia -- [out_dir]

use sk::{
    BlendMode, ClipOp, Color, ColorChannel, IRect, Image, ImageInfo, Paint, Point, RRect, Rect,
    canvas::SaveLayerRec, image_filters,
};
use skia_safe as sk;

const W: i32 = 540; // half a phone width keeps CI fast; effects scale
const H: i32 = 1170;
/// The glass plate sits PAD px inside the snapshot; the pad gives the
/// displacement map room to sample beyond the plate edge.
const PAD: f32 = 48.0;

fn main() -> anyhow::Result<()> {
    let out = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    std::fs::create_dir_all(&out)?;

    // --- 1. Synthetic chat backdrop (dark Velta-ish theme).
    let mut surface = sk::surfaces::raster_n32_premul((W, H)).unwrap();
    draw_chat(surface.canvas());
    surface
        .image_snapshot()
        .save_to_path(format!("{out}/before.png"))?;

    // --- 2. The glass plate region.
    let glass = Rect::from_xywh(20.0, H as f32 - 260.0, W as f32 - 40.0, 150.0);
    let radius = 28.0;
    let rrect = RRect::new_rect_radii(glass, &[Point::new(radius, radius); 4]);

    // --- 3. Snapshot the backdrop and run the chain on a padded copy.
    let snap = IRect::from_xywh(
        (glass.left() - PAD) as i32,
        (glass.top() - PAD) as i32,
        (glass.width() + PAD * 2.0) as i32,
        (glass.height() + PAD * 2.0) as i32,
    );
    let backdrop = surface.make_image_snapshot(Some(snap)).unwrap();

    // Refraction: displacement through the generated lens map, then frost blur.
    let lens = lens_map(snap.width(), snap.height(), radius);
    let lens_filter = image_filters::image(lens, None, None, None);
    let disp = image_filters::displacement_map(
        ColorChannel::R,
        ColorChannel::G,
        40.0,
        lens_filter,
        None,
        None,
    );
    let blurred = image_filters::blur((6.0, 6.0), None, disp, None);

    let mut plate = sk::surfaces::raster_n32_premul((snap.width(), snap.height())).unwrap();
    let mut gp = Paint::default();
    gp.set_image_filter(blurred.as_ref());
    plate
        .canvas()
        .draw_image(backdrop.clone(), (0, 0), Some(&gp));
    let glass_image = plate.image_snapshot().unwrap();

    // --- 4. Composite onto the frame: filtered backdrop clipped to the plate,
    // then chromatic-aberration ghost + tint + specular highlight on top.
    let c = surface.canvas();
    c.save_layer(&SaveLayerRec::default());
    c.clip_rrect(rrect, ClipOp::Intersect, true);
    c.save();
    c.translate((glass.left() - PAD, glass.top() - PAD));
    c.draw_image(glass_image.clone(), (0, 0), None);
    let ghost = image_filters::offset(
        (2.0, 0.5),
        None,
        image_filters::image(glass_image.clone(), None, None, None),
        None,
    );
    let mut ab = Paint::default();
    ab.set_blend_mode(BlendMode::Plus);
    ab.set_alpha_float(0.14);
    ab.set_image_filter(ghost.as_ref());
    c.draw_image(glass_image.clone(), (0, 0), Some(&ab));
    c.restore();

    let mut tint = Paint::default();
    tint.set_color(Color::from_argb(22, 255, 255, 255));
    c.draw_rrect(rrect, &tint);

    let mut spec = Paint::default();
    spec.set_style(sk::paint::Style::Stroke);
    spec.set_stroke_width(1.4);
    spec.set_color(Color::from_argb(120, 255, 255, 255));
    c.draw_rrect(rrect, &spec);
    c.restore();

    surface
        .image_snapshot()
        .save_to_path(format!("{out}/after.png"))?;
    println!("wrote {out}/before.png + {out}/after.png (glass at {glass:?})");
    Ok(())
}

/// Lens displacement map, generated pixel-by-pixel for full control:
/// every channel starts at 128 (= zero shift for DisplacementMapEffect);
/// within `ZONE` px of the plate edge, R/G encode a sample offset toward
/// that edge so the backdrop bends inward at the rim, flat in the center.
fn lens_map(w: i32, h: i32, _radius: f32) -> Image {
    let info = ImageInfo::new_n32_premul((w, h));
    let mut px = vec![128u8; (w * h * 4) as usize];
    let zone = 34.0;
    let inner_l = PAD;
    let inner_t = PAD;
    let inner_r = w as f32 - PAD;
    let inner_b = h as f32 - PAD;

    for y in 0..h {
        for x in 0..w {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let dl = fx - inner_l;
            let dr = inner_r - fx;
            let dt = fy - inner_t;
            let db = inner_b - fy;
            let d = dl.min(dr).min(dt).min(db);
            if d < zone {
                let f = 1.0 - (d / zone).clamp(0.0, 1.0);
                let (dir_x, dir_y) = if d == dl {
                    (-1.0, 0.0)
                } else if d == dr {
                    (1.0, 0.0)
                } else if d == dt {
                    (0.0, -1.0)
                } else {
                    (0.0, 1.0)
                };
                let i = ((y * w + x) * 4) as usize;
                px[i] = (128.0 + dir_x * f * 120.0).clamp(0.0, 255.0) as u8;
                px[i + 1] = (128.0 + dir_y * f * 120.0).clamp(0.0, 255.0) as u8;
            }
        }
    }
    Image::from_pixel(&info, &px).unwrap()
}

/// A stand-in chat screen: header, bubbles with text bars, bottom bar.
fn draw_chat(c: &sk::Canvas) {
    c.clear(Color::from_argb(255, 16, 18, 23)); // BG #101217

    let mut p = Paint::default();
    p.set_color(Color::from_argb(255, 28, 31, 38)); // SURFACE
    c.draw_rect(Rect::from_xywh(0.0, 0.0, W as f32, 64.0), &p);

    let bubble_w = W as f32 * 0.62;
    let mut y = 90.0;
    for i in 0..9 {
        let outgoing = i % 2 == 0;
        let x = if outgoing {
            W as f32 - bubble_w - 16.0
        } else {
            16.0
        };
        let h = 56.0 + (i % 3) as f32 * 14.0;
        let mut bp = Paint::default();
        bp.set_color(if outgoing {
            Color::from_argb(255, 47, 74, 158)
        } else {
            Color::from_argb(255, 44, 47, 56)
        });
        let rr = RRect::new_rect_radii(
            Rect::from_xywh(x, y, bubble_w, h),
            &[Point::new(18.0, 18.0); 4],
        );
        c.draw_rrect(rr, &bp);
        let mut tp = Paint::default();
        tp.set_color(Color::from_argb(255, 242, 244, 248));
        for line in 0..(i % 3 + 1) {
            let lw = bubble_w - 40.0 - (line as f32 * 34.0).min(120.0);
            c.draw_rect(
                Rect::from_xywh(x + 20.0, y + 14.0 + line as f32 * 16.0, lw, 4.0),
                &tp,
            );
        }
        y += h + 14.0;
    }

    // Bottom bar, so the glass plate overlaps content on all sides.
    let mut bar = Paint::default();
    bar.set_color(Color::from_argb(255, 28, 31, 38));
    c.draw_rect(Rect::from_xywh(0.0, H as f32 - 80.0, W as f32, 80.0), &bar);
}
