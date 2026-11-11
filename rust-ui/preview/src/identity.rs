//! Fingerprint identity tiles — the 10-cell color matrix stable renders for
//! photo-less 1:1 contacts. Rust port of `app/js/avatar.js` (COLOR_POOL,
//! `colorForCell` pool-stepping, edge-neighbor clash rules, captions
//! contrast), bit-identical per fingerprint; vectors computed from the real
//! `buildAvatarSvg` are pinned in the tests below.

/// Single-word CSS color keywords with sRGB triples for contrast math.
/// Pure black/white and near-white keywords are excluded on purpose.
const COLOR_POOL: &[(&str, [u8; 3])] = &[
    ("Crimson", [220, 20, 60]),
    ("Tomato", [255, 99, 71]),
    ("Salmon", [250, 128, 114]),
    ("Coral", [255, 127, 80]),
    ("DarkOrange", [255, 140, 0]),
    ("Orange", [255, 165, 0]),
    ("Gold", [255, 215, 0]),
    ("Yellow", [255, 255, 0]),
    ("Khaki", [240, 230, 140]),
    ("Lavender", [230, 230, 250]),
    ("Thistle", [216, 191, 216]),
    ("Plum", [221, 160, 221]),
    ("Magenta", [255, 0, 255]),
    ("Violet", [238, 130, 238]),
    ("Orchid", [218, 112, 214]),
    ("Fuchsia", [255, 0, 255]),
    ("Lime", [0, 255, 0]),
    ("Olive", [128, 128, 0]),
    ("Green", [0, 128, 0]),
    ("Teal", [0, 128, 128]),
    ("Cyan", [0, 255, 255]),
    ("Turquoise", [64, 224, 208]),
    ("Aquamarine", [127, 255, 212]),
    ("SkyBlue", [135, 206, 235]),
    ("CadetBlue", [95, 158, 160]),
    ("SteelBlue", [70, 130, 180]),
    ("RoyalBlue", [65, 105, 225]),
    ("Blue", [0, 0, 255]),
    ("Indigo", [75, 0, 130]),
    ("Purple", [128, 0, 128]),
    ("Navy", [0, 0, 128]),
    ("Maroon", [128, 0, 0]),
    ("Chocolate", [210, 105, 30]),
    ("Sienna", [160, 82, 45]),
    ("Wheat", [245, 222, 179]),
    ("Beige", [245, 245, 220]),
    ("Gainsboro", [220, 220, 220]),
    ("Silver", [192, 192, 192]),
    ("Peru", [205, 133, 63]),
    ("Goldenrod", [218, 165, 32]),
];

/// Fingerprint hex (≥40 hex chars, junk stripped) → 10 groups as 16-bit ints
/// (web `fingerprintGroups`: 40 hex chars → ten 4-char groups). `None` when
/// there is no usable key behind the contact.
pub fn groups(fpr: &str) -> Option<[u16; 10]> {
    let hex: String = fpr.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() < 40 {
        return None;
    }
    let mut out = [0u16; 10];
    for (i, g) in out.iter_mut().enumerate() {
        *g = u16::from_str_radix(&hex[i * 4..i * 4 + 4], 16).ok()?;
    }
    Some(out)
}

/// Cells sit on a 3/2/2/3 grid in a 120×120 box: (x, y, w, h) per cell.
pub const CELL_RECTS: [(f32, f32, f32, f32); 10] = [
    (0.0, 0.0, 40.0, 30.0),
    (40.0, 0.0, 40.0, 30.0),
    (80.0, 0.0, 40.0, 30.0),
    (0.0, 30.0, 60.0, 30.0),
    (60.0, 30.0, 60.0, 30.0),
    (0.0, 60.0, 60.0, 30.0),
    (60.0, 60.0, 60.0, 30.0),
    (0.0, 90.0, 40.0, 30.0),
    (40.0, 90.0, 40.0, 30.0),
    (80.0, 90.0, 40.0, 30.0),
];

/// Which cells sit visually above cell i in the 3/2/2/3 layout — ALL cells
/// sharing an edge, not just the max-overlap one (guarding only the primary
/// neighbor let two Tomatoes touch).
const ABOVE: [(usize, &[usize]); 7] = [
    (3, &[1, 0]),
    (4, &[2, 1]),
    (5, &[3]),
    (6, &[4]),
    (7, &[5]),
    (8, &[6, 5]),
    (9, &[6]),
];

fn rgb_to_hsl([r, g, b]: [u8; 3]) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn hue_dist(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

fn colors_clash(a: [u8; 3], b: [u8; 3]) -> bool {
    let (h1, s1, l1) = rgb_to_hsl(a);
    let (h2, s2, l2) = rgb_to_hsl(b);
    let achromatic = s1 < 0.15 && s2 < 0.15;
    if achromatic {
        return (l1 - l2).abs() < 0.3;
    }
    if s1 < 0.15 || s2 < 0.15 {
        return (l1 - l2).abs() < 0.35; // grey vs color: needs a real lightness gap
    }
    hue_dist(h1, h2) < 30.0 && (s1 - s2).abs() < 0.35 && (l1 - l2).abs() < 0.3
}

/// Cell color = raw group color, stepped 7 places through the pool. Two
/// constraints, in priority order: never similar to an edge-sharing neighbor
/// (hard), and never a color already used elsewhere in the tile (strong
/// preference; if the tile paints itself into a corner, the first
/// non-clashing repeat is taken rather than risking a neighbor clash).
fn color_for_cell(
    groups: &[u16; 10],
    i: usize,
    chosen: &[(bool, &str, [u8; 3]); 10],
) -> (usize, &'static str, [u8; 3]) {
    let idx = (groups[i] as usize) % COLOR_POOL.len();
    let mut neighbors = vec![i.checked_sub(1)];
    for (cell, above) in ABOVE {
        if cell == i {
            neighbors.extend(above.iter().map(|j| Some(*j)));
        }
    }
    let neighbors: Vec<usize> = neighbors
        .into_iter()
        .flatten()
        .filter(|j| chosen[*j].0)
        .collect();
    let used = |name: &str| chosen.iter().any(|(_, n, _)| *n == name);
    let mut fallback = None;
    for step in 0..COLOR_POOL.len() {
        let cand = (idx + step * 7) % COLOR_POOL.len();
        let (name, rgb) = COLOR_POOL[cand];
        if neighbors.iter().any(|j| colors_clash(rgb, chosen[*j].2)) {
            continue;
        }
        if !used(name) {
            return (cand, name, rgb);
        }
        if fallback.is_none() {
            fallback = Some((cand, name, rgb));
        }
    }
    fallback.unwrap_or((idx, COLOR_POOL[idx].0, COLOR_POOL[idx].1))
}

/// The tile: 10 (name, rgb) cells in draw order (row-major 3/2/2/3).
pub fn cells(fpr: &str) -> Option<[(&'static str, [u8; 3]); 10]> {
    let groups = groups(fpr)?;
    let mut chosen: [(bool, &str, [u8; 3]); 10] = Default::default();
    let mut out = [COLOR_POOL[0]; 10].map(|(n, c)| (n, c));
    for i in 0..10 {
        let (_, name, rgb) = color_for_cell(&groups, i, &chosen);
        chosen[i] = (true, name, rgb);
        out[i] = (name, rgb);
    }
    Some(out)
}

/// Grayscale of the same lightness: the tile keeps its pattern but carries
/// no identity colors (no key behind it yet) (web `monoFill`).
pub fn mono_fill([r, g, b]: [u8; 3]) -> [u8; 3] {
    let y = (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64).round() as u8;
    [y, y, y]
}

/// Caption text color per cell: better WCAG contrast between softened
/// near-white (#f4f4f4) and near-black (#1c1c1c) — never pure #000/#fff.
pub fn contrast_text(rgb: [u8; 3]) -> [u8; 3] {
    fn luminance(c: u8) -> f64 {
        let c = c as f64 / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }
    let l = 0.2126 * luminance(rgb[0]) + 0.7152 * luminance(rgb[1]) + 0.0722 * luminance(rgb[2]);
    let light = (luminance(244) + 0.05) / (l + 0.05);
    let dark = (l + 0.05) / (luminance(28) + 0.05);
    if light >= dark {
        [244, 244, 244]
    } else {
        [28, 28, 28]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parity vectors: `buildAvatarSvg` cell fills (badge=false, mono=false)
    /// from the web module, in draw order. The first fingerprint is the real
    /// one shown on a live profile screen — its legend read Lavender/Khaki/
    /// Coral/Green/SteelBlue/Chocolate/Magenta/Lime/Thistle/Olive there.
    #[test]
    fn cells_match_web() {
        let v: &[(&str, [&str; 10])] = &[
            (
                "0E692C68104336C210093DD12D4021C2591ABED9",
                [
                    "Lavender",
                    "Khaki",
                    "Coral",
                    "Green",
                    "SteelBlue",
                    "Chocolate",
                    "Magenta",
                    "Lime",
                    "Thistle",
                    "Olive",
                ],
            ),
            (
                "0123456789ABCDEF0123456789ABCDEF01234567",
                [
                    "Plum",
                    "Yellow",
                    "Coral",
                    "Cyan",
                    "Green",
                    "Orchid",
                    "Olive",
                    "Blue",
                    "SteelBlue",
                    "Turquoise",
                ],
            ),
            (
                "0000000000000000000000000000000000000000",
                [
                    "Crimson",
                    "Yellow",
                    "Orchid",
                    "Turquoise",
                    "Indigo",
                    "Beige",
                    "Salmon",
                    "Lavender",
                    "Lime",
                    "SkyBlue",
                ],
            ),
            (
                "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
                [
                    "Fuchsia",
                    "Aquamarine",
                    "Purple",
                    "Coral",
                    "Thistle",
                    "Olive",
                    "CadetBlue",
                    "Gainsboro",
                    "Maroon",
                    "Peru",
                ],
            ),
        ];
        for (fpr, names) in v {
            let cells = cells(fpr).expect("groups");
            for (i, (name, _)) in cells.iter().enumerate() {
                assert_eq!(name, &names[i], "cell {i} of {fpr}");
            }
        }
    }

    #[test]
    fn groups_require_40_hex() {
        assert!(groups("0E69 2C68 1043 36C2 1009 3DD1 2D40 21C2 591A BED9").is_some());
        assert!(groups("0E692C68").is_none());
        assert!(groups("").is_none());
        let g = groups("0E69 2C68 1043 36C2 1009 3DD1 2D40 21C2 591A BED9").unwrap();
        assert_eq!(g[0], 0x0E69);
        assert_eq!(g[9], 0xBED9);
    }

    #[test]
    fn cells_reject_short_keys() {
        assert!(cells("nokey").is_none());
    }

    #[test]
    fn mono_fill_desaturates() {
        assert_eq!(mono_fill([255, 0, 0]), [76, 76, 76]);
        assert_eq!(mono_fill([0, 0, 0]), [0, 0, 0]);
        assert_eq!(mono_fill([255, 255, 255]), [255, 255, 255]);
    }

    #[test]
    fn contrast_text_flips() {
        assert_eq!(contrast_text([255, 255, 0]), [28, 28, 28]); // Yellow: dark text
        assert_eq!(contrast_text([0, 0, 128]), [244, 244, 244]); // Navy: light text
    }
}
