package org.velta.kmp.ui

/*
 * Velta Prism — stable person colors from names. Kotlin port of the web
 * app's app/js/name-color.js (and rust-ui/preview/src/prism.rs, which pins
 * the same parity vectors). Bit-identical per name across the web UI and
 * this client: avatar fills, sender names.
 */

/** Soft-white initials color, #f4f4f4 (web: INK in name-color.js). */
val PRISM_INK: IntArray = intArrayOf(244, 244, 244)

/** WCAG relative luminance of one sRGB channel. */
private fun lum(c: Int): Double {
    val v = c / 255.0
    return if (v <= 0.04045) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)
}

/** WCAG contrast ratio between two sRGB triples. */
fun prismContrast(a: IntArray, b: IntArray): Double {
    val w = doubleArrayOf(0.2126, 0.7152, 0.0722)
    val l = fun(x: IntArray) = x.indices.sumOf { lum(x[it]) * w[it] }
    val (x, y) = l(a) to l(b)
    return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
}

/** hsl(h, s%, l%) → rounded sRGB triple. Matches JS Math.round (half-up). */
fun prismHslToRgb(h: Double, s: Double, l: Double): IntArray {
    val s2 = s / 100.0
    val l2 = l / 100.0
    val k: (Double) -> Double = { n -> (n + h / 30.0) % 12.0 }
    val a = s2 * minOf(l2, 1.0 - l2)
    val f: (Double) -> Int = { n ->
        val kk = k(n)
        val v = l2 - a * maxOf(-1.0, minOf(kk - 3.0, 9.0 - kk, 1.0))
        kotlin.math.round(v * 255.0).toInt()
    }
    return intArrayOf(f(0.0), f(8.0), f(4.0))
}

/** Rounded sRGB triple → (h, s%, l%). */
fun prismRgbToHsl(r: Int, g: Int, b: Int): Triple<Double, Double, Double> {
    val rf = r / 255.0; val gf = g / 255.0; val bf = b / 255.0
    val max = maxOf(rf, gf, bf); val min = minOf(rf, gf, bf)
    val l = (max + min) / 2.0
    val d = max - min
    if (d == 0.0) return Triple(0.0, 0.0, l * 100.0)
    val s = d / (1.0 - Math.abs(2.0 * l - 1.0))
    val h = when (max) {
        rf -> ((gf - bf) / d) % 6.0
        gf -> (bf - rf) / d + 2.0
        else -> (rf - gf) / d + 4.0
    }
    return Triple((h * 60.0 + 360.0) % 360.0, s * 100.0, l * 100.0)
}

/**
 * Name → hue. The web hash feeds `charCodeAt(0)` of each code point into
 * `h*31 + c` (mod 2³²); for astral code points that is the high UTF-16
 * surrogate — so iterate UTF-16 units and skip low surrogates, which is
 * exactly the first unit of every code point (🚀 must not hash as its
 * full code point). An empty/blank-ish name hashes as "?".
 */
fun prismHueOf(name: String): Int {
    var h = 0L
    val s = if (name.isEmpty()) "?" else name
    for (ch in s) {
        val u = ch.code
        if (u in 0xDC00..0xDFFF) continue // low surrogate: not a code-point head
        h = (h * 31 + u) and 0xFFFFFFFFL
    }
    return ((h % 360).toInt())
}

/**
 * Avatar fill: hue from the name at s 55%, lightness dropped from 55% until
 * the soft-white initials reach 3:1 (web `nameColor`).
 */
fun prismFill(name: String): IntArray {
    val h = prismHueOf(name).toDouble()
    var l = 55
    while (l > 20 && prismContrast(PRISM_INK, prismHslToRgb(h, 55.0, l.toDouble())) < 3.0) {
        l--
    }
    return prismHslToRgb(h, 55.0, l.toDouble())
}

/**
 * Same hue, lightness moved (`dir` +1 lighter / −1 darker) in 1% steps until
 * ≥ [ratio] on [bg]; falls off to ink/near-black at the range ends (web
 * `readableOn`). Used for sender-name text on the bubble surface (4.6:1).
 */
fun prismReadableOn(color: IntArray, bg: IntArray, ratio: Double, dir: Int): IntArray {
    if (prismContrast(color, bg) >= ratio) return color
    val (h, s, l0) = prismRgbToHsl(color[0], color[1], color[2])
    var l = l0
    while (l in 0.0..100.0) {
        l += dir
        if (l < 0.0 || l > 100.0) break
        val c = prismHslToRgb(h, s, l)
        if (prismContrast(c, bg) >= ratio) return c
    }
    return if (dir > 0) intArrayOf(244, 244, 244) else intArrayOf(16, 19, 26)
}

/** Sender-name color: the person's fill nudged until it reads on [bg]. */
fun prismSender(name: String, bg: IntArray): IntArray =
    prismReadableOn(prismFill(name), bg, 4.6, 1)

/**
 * Up to two initials (Unicode letters/digits only), "?" when the name has
 * none (web components.js #initials, #151: Cyrillic/CJK must not fall
 * through). Words are joined in order — "ß bc" gives "SSB" like the web.
 */
fun prismInitials(name: String): String {
    val parts = ArrayList<String>(2)
    for (w in name.trim().split(Regex("\\s+"))) {
        val first = w.firstOrNull() ?: continue
        if (first.isLetter() || first.isDigit()) {
            parts.add(first.uppercase())
            if (parts.size >= 2) break
        }
    }
    val out = parts.joinToString("")
    return if (out.isEmpty()) "?" else out
}
