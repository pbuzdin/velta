//! Velta Prism — stable person colors from names. Rust port of the web app's
//! `app/js/name-color.js`, bit-identical per name: avatars, sender names.
//! Parity vectors (computed from the JS) are pinned in the tests below.

use masonry::peniko::color::{AlphaColor, Srgb};

/// Soft-white initials color, #f4f4f4 (web: INK in name-color.js).
pub const INK: [u8; 3] = [244, 244, 244];

/// WCAG relative luminance of an sRGB triple.
fn lum(c: u8) -> f64 {
    let c = c as f64 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn contrast(a: [u8; 3], b: [u8; 3]) -> f64 {
    const W: [f64; 3] = [0.2126, 0.7152, 0.0722];
    let l = |x: [u8; 3]| x.iter().zip(W).map(|(c, w)| lum(*c) * w).sum::<f64>();
    let (x, y) = (l(a), l(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// hsl(h, s%, l%) → rounded sRGB. Same rounding as JS `Math.round` (half-up;
/// both agree for non-negative values).
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [u8; 3] {
    let (s, l) = (s / 100.0, l / 100.0);
    let k = |n: f64| (n + h / 30.0) % 12.0;
    let a = s * l.min(1.0 - l);
    let f = |n: f64| {
        let k = k(n);
        l - a * (-1.0f64).max((k - 3.0).min(9.0 - k).min(1.0))
    };
    [f(0.0), f(8.0), f(4.0)].map(|v| (v * 255.0).round() as u8)
}

/// Rounded sRGB → (h, s%, l%).
fn rgb_to_hsl([r, g, b]: [u8; 3]) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0.0, 0.0, l * 100.0);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
        ((g - b) / d) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    ((h * 60.0 + 360.0) % 360.0, s * 100.0, l * 100.0)
}

/// Name → hue. The web hash feeds `charCodeAt(0)` of each code point into
/// `h*31 + c` (mod 2³²); for astral code points that is the high UTF-16
/// surrogate, so mirror exactly that (🚀 must not hash as its full code point).
pub fn hue_of(name: &str) -> u32 {
    let mut h: u32 = 0;
    for ch in (if name.is_empty() { "?" } else { name }).chars() {
        let unit = if (ch as u32) < 0x10000 {
            ch as u32
        } else {
            0xD800 + ((ch as u32 - 0x10000) >> 10)
        };
        h = h.wrapping_mul(31).wrapping_add(unit);
    }
    h % 360
}

/// Avatar fill: hue from the name at s 55%, lightness dropped from 55% until
/// the soft-white initials reach 3:1 (web `nameColor`).
pub fn fill(name: &str) -> [u8; 3] {
    let h = hue_of(name) as f64;
    let mut l = 55i32;
    while l > 20 && contrast(INK, hsl_to_rgb(h, 55.0, l as f64)) < 3.0 {
        l -= 1;
    }
    hsl_to_rgb(h, 55.0, l as f64)
}

/// Same hue, lightness moved (`dir` +1 lighter / −1 darker) in 1% steps until
/// ≥ `ratio` on `bg`; falls off to ink/near-black at the range ends (web
/// `readableOn`). Used for sender-name text on the bubble surface (4.6:1).
pub fn readable_on(color: [u8; 3], bg: [u8; 3], ratio: f64, dir: i32) -> [u8; 3] {
    if contrast(color, bg) >= ratio {
        return color;
    }
    let (h, s, mut l) = rgb_to_hsl(color);
    while (0.0..=100.0).contains(&l) {
        l += dir as f64;
        if !(0.0..=100.0).contains(&l) {
            break;
        }
        let c = hsl_to_rgb(h, s, l);
        if contrast(c, bg) >= ratio {
            return c;
        }
    }
    if dir > 0 {
        [244, 244, 244]
    } else {
        [16, 19, 26]
    }
}

/// Sender-name color: the person's fill nudged until it reads on `bg`.
pub fn sender(name: &str, bg: [u8; 3]) -> [u8; 3] {
    readable_on(fill(name), bg, 4.6, 1)
}

/// Up to two initials (Unicode letters/digits only), "?" when the name has
/// none (web `components.js #initials`, #151: Cyrillic/CJK must not fall
/// through).
pub fn initials(name: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for w in name.trim().split_whitespace() {
        let Some(first) = w.chars().next() else {
            continue;
        };
        if first.is_alphabetic() || first.is_numeric() {
            parts.push(first.to_uppercase().to_string());
            if parts.len() >= 2 {
                break;
            }
        }
    }
    let out = parts.concat();
    if out.is_empty() { "?".to_string() } else { out }
}

/// `[u8; 3]` → a masonry paint color.
pub fn to_color(c: [u8; 3]) -> AlphaColor<Srgb> {
    AlphaColor::from_rgb8(c[0], c[1], c[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Parity vectors: `nameColor(name)` from app/js/name-color.js (node),
    // parsed to RGB. Each also pins the name→hue hash through the contrast
    // loop (several dropped from l=55 to 39/40/41 to reach 3:1 on ink).
    #[test]
    fn fill_matches_web() {
        let v: &[(&str, [u8; 3])] = &[
            ("Alice", [103, 154, 45]),
            ("bob", [46, 158, 115]),
            ("Владимир", [47, 152, 162]),
            ("Zoë", [46, 158, 132]),
            ("群组", [203, 77, 144]),
            ("Relay User", [203, 77, 90]),
            ("chatmail.uk", [46, 158, 100]),
            // Astral code point: JS hashes only the high surrogate.
            ("🚀rocket", [79, 77, 203]),
            ("Alice Bob", [77, 100, 203]),
            ("", [141, 146, 42]), // JS `String(name || "?")` → hashes "?"
        ];
        for (name, rgb) in v {
            assert_eq!(&fill(name), rgb, "fill({name:?})");
        }
    }

    // `readableOn(nameColor(name), bg, 4.6, dir)` from the web module.
    #[test]
    fn readable_on_matches_web() {
        let dark = [0x1c, 0x1f, 0x26];
        let white = [244, 244, 244];
        // Already ≥ 4.6:1 on the dark bubble: unchanged.
        assert_eq!(readable_on(fill("Alice"), dark, 4.6, 1), [103, 154, 45]);
        assert_eq!(
            readable_on(fill("bob"), [0x10, 0x13, 0x1a], 4.6, -1),
            [46, 158, 115]
        );
        // Lightness walked up 1% at a time until it reads.
        assert_eq!(readable_on(fill("群组"), dark, 4.6, 1), [209, 97, 156]);
        assert_eq!(
            readable_on(fill("Relay User"), dark, 4.6, 1),
            [211, 105, 116]
        );
        // Falls off the light end → ink.
        assert_eq!(readable_on(fill("Alice"), white, 4.6, 1), [244, 244, 244]);
    }

    #[test]
    fn hue_is_stable() {
        assert_eq!(hue_of("Alice"), hue_of("Alice"));
        assert_ne!(hue_of("Alice"), hue_of("Bob"));
        assert_eq!(hue_of(""), hue_of("?"));
    }

    // components.js #initials semantics, incl. the #151 non-Latin cases.
    #[test]
    fn initials_match_web() {
        assert_eq!(initials("Alice"), "A");
        assert_eq!(initials("alice"), "A");
        assert_eq!(initials("Alice Bob"), "AB");
        assert_eq!(initials("  carol   anne "), "CA");
        assert_eq!(initials("Алиса Петрова"), "АП");
        assert_eq!(initials("群组"), "群");
        // Two words → first letters ("12" is one word).
        assert_eq!(initials("123 go"), "1G");
        assert_eq!(initials("Zoë Chùchò"), "ZC");
        assert_eq!(initials("🚀"), "?");
        assert_eq!(initials(""), "?");
        assert_eq!(initials("   "), "?");
        assert_eq!(initials("--- ??"), "?");
    }
}
