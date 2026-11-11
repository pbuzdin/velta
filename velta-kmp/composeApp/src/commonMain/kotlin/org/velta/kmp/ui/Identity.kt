package org.velta.kmp.ui

/*
 * Fingerprint identity tiles — the 10-cell color matrix stable renders for
 * photo-less 1:1 contacts. Kotlin port of app/js/avatar.js (COLOR_POOL,
 * colorForCell pool-stepping, edge-neighbor clash rules, captions contrast;
 * same vectors rust-ui/preview/src/identity.rs pins). Bit-identical per
 * fingerprint: the same key produces the same ten colors on web, lab, and
 * this client.
 */

/**
 * Single-word CSS color keywords with sRGB triples for contrast math.
 * Pure black/white and near-white keywords are excluded on purpose.
 */
val IDENTITY_COLOR_POOL: List<Pair<String, IntArray>> = listOf(
    "Crimson" to intArrayOf(220, 20, 60),
    "Tomato" to intArrayOf(255, 99, 71),
    "Salmon" to intArrayOf(250, 128, 114),
    "Coral" to intArrayOf(255, 127, 80),
    "DarkOrange" to intArrayOf(255, 140, 0),
    "Orange" to intArrayOf(255, 165, 0),
    "Gold" to intArrayOf(255, 215, 0),
    "Yellow" to intArrayOf(255, 255, 0),
    "Khaki" to intArrayOf(240, 230, 140),
    "Lavender" to intArrayOf(230, 230, 250),
    "Thistle" to intArrayOf(216, 191, 216),
    "Plum" to intArrayOf(221, 160, 221),
    "Magenta" to intArrayOf(255, 0, 255),
    "Violet" to intArrayOf(238, 130, 238),
    "Orchid" to intArrayOf(218, 112, 214),
    "Fuchsia" to intArrayOf(255, 0, 255),
    "Lime" to intArrayOf(0, 255, 0),
    "Olive" to intArrayOf(128, 128, 0),
    "Green" to intArrayOf(0, 128, 0),
    "Teal" to intArrayOf(0, 128, 128),
    "Cyan" to intArrayOf(0, 255, 255),
    "Turquoise" to intArrayOf(64, 224, 208),
    "Aquamarine" to intArrayOf(127, 255, 212),
    "SkyBlue" to intArrayOf(135, 206, 235),
    "CadetBlue" to intArrayOf(95, 158, 160),
    "SteelBlue" to intArrayOf(70, 130, 180),
    "RoyalBlue" to intArrayOf(65, 105, 225),
    "Blue" to intArrayOf(0, 0, 255),
    "Indigo" to intArrayOf(75, 0, 130),
    "Purple" to intArrayOf(128, 0, 128),
    "Navy" to intArrayOf(0, 0, 128),
    "Maroon" to intArrayOf(128, 0, 0),
    "Chocolate" to intArrayOf(210, 105, 30),
    "Sienna" to intArrayOf(160, 82, 45),
    "Wheat" to intArrayOf(245, 222, 179),
    "Beige" to intArrayOf(245, 245, 220),
    "Gainsboro" to intArrayOf(220, 220, 220),
    "Silver" to intArrayOf(192, 192, 192),
    "Peru" to intArrayOf(205, 133, 63),
    "Goldenrod" to intArrayOf(218, 165, 32),
)

/**
 * Fingerprint hex (≥40 hex chars, junk stripped) → 10 groups as 16-bit ints
 * (web `fingerprintGroups`: 40 hex chars → ten 4-char groups). `null` when
 * there is no usable key behind the contact.
 */
fun identityGroups(fpr: String?): IntArray? {
    if (fpr == null) return null
    val hex = fpr.filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
    if (hex.length < 40) return null
    val out = IntArray(10)
    for (i in 0 until 10) {
        out[i] = hex.substring(i * 4, i * 4 + 4).toInt(16)
    }
    return out
}

/** Which cells sit visually above cell i in the 3/2/2/3 layout — ALL cells
 * sharing an edge, not just the max-overlap one (guarding only the primary
 * neighbor let two Tomatoes touch). */
private val IDENTITY_ABOVE: Map<Int, List<Int>> = mapOf(
    3 to listOf(1, 0),
    4 to listOf(2, 1),
    5 to listOf(3),
    6 to listOf(4),
    7 to listOf(5),
    8 to listOf(6, 5),
    9 to listOf(6),
)

private fun identityHueDist(a: Double, b: Double): Double {
    val d = Math.abs(a - b) % 360.0
    return if (d > 180.0) 360.0 - d else d
}

private fun identityColorsClash(a: IntArray, b: IntArray): Boolean {
    val (h1, s1, l1) = identityRgbToHsl(a)
    val (h2, s2, l2) = identityRgbToHsl(b)
    val achromatic = s1 < 0.15 && s2 < 0.15
    if (achromatic) return Math.abs(l1 - l2) < 0.3
    if (s1 < 0.15 || s2 < 0.15) return Math.abs(l1 - l2) < 0.35 // grey vs color: needs a real lightness gap
    return identityHueDist(h1, h2) < 30.0 && Math.abs(s1 - s2) < 0.35 && Math.abs(l1 - l2) < 0.3
}

/** hsl with l/s in 0..1 (avatar.js's own variant, thresholds differ from Prism's). */
private fun identityRgbToHsl(c: IntArray): Triple<Double, Double, Double> {
    val r = c[0] / 255.0; val g = c[1] / 255.0; val b = c[2] / 255.0
    val max = maxOf(r, g, b); val min = minOf(r, g, b)
    val l = (max + min) / 2.0
    if (max == min) return Triple(0.0, 0.0, l)
    val d = max - min
    val s = if (l > 0.5) d / (2.0 - max - min) else d / (max + min)
    val h = when (max) {
        r -> (g - b) / d + if (g < b) 6.0 else 0.0
        g -> (b - r) / d + 2.0
        else -> (r - g) / d + 4.0
    }
    return Triple(h * 60.0, s, l)
}

/**
 * Cell color = raw group color, stepped 7 places through the pool. Two
 * constraints, in priority order: never similar to an edge-sharing neighbor
 * (hard), and never a color already used elsewhere in the tile (strong
 * preference; if the tile paints itself into a corner, the first
 * non-clashing repeat is taken rather than risking a neighbor clash).
 */
private fun identityColorForCell(
    groups: IntArray,
    i: Int,
    chosen: List<Boolean>,
    chosenNames: List<String>,
    chosenColors: List<IntArray>,
): Int {
    val idx = groups[i] % IDENTITY_COLOR_POOL.size
    val neighbors = buildList {
        if (i > 0) add(i - 1)
        IDENTITY_ABOVE[i]?.let { addAll(it) }
    }.filter { chosen[it] }
    val used: (String) -> Boolean = { name -> chosenNames.contains(name) }
    var fallback: Int? = null
    for (step in 0 until IDENTITY_COLOR_POOL.size) {
        val cand = (idx + step * 7) % IDENTITY_COLOR_POOL.size
        val rgb = IDENTITY_COLOR_POOL[cand].second
        if (neighbors.any { identityColorsClash(rgb, chosenColors[it]) }) continue
        if (!used(IDENTITY_COLOR_POOL[cand].first)) return cand
        if (fallback == null) fallback = cand
    }
    return fallback ?: idx
}

/**
 * The peer's fingerprint from `get_contact_encryption_info` text (the
 * "Profile key" blocks — core writes the key as ten 4-hex groups per line).
 * Web `blockFpr`: collect ALL non-overlapping 5-group windows (a 10-group
 * line = exactly 2), join, strip to hex, need ≥40, cut at 40, uppercase.
 */
fun identityFingerprintFromEncrInfo(text: String): String? {
    val joined = Regex("(?:[0-9A-Fa-f]{4} ){4}[0-9A-Fa-f]{4}")
        .findAll(text)
        .joinToString("") { it.value }
    if (joined.isEmpty()) return null
    val hex = joined.filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
    return if (hex.length >= 40) hex.take(40).uppercase() else null
}

/**
 * The tile: 10 (name, rgb) cells in draw order (row-major 3/2/2/3), `null`
 * when the key is missing or too short.
 */
fun identityCells(fpr: String?): List<Pair<String, IntArray>>? {
    val groups = identityGroups(fpr) ?: return null
    val chosen = MutableList(10) { false }
    val chosenNames = MutableList(10) { "" }
    val chosenColors = MutableList(10) { IntArray(3) }
    val out = ArrayList<Pair<String, IntArray>>(10)
    for (i in 0 until 10) {
        val cand = identityColorForCell(groups, i, chosen, chosenNames, chosenColors)
        chosen[i] = true
        chosenNames[i] = IDENTITY_COLOR_POOL[cand].first
        chosenColors[i] = IDENTITY_COLOR_POOL[cand].second
        out.add(IDENTITY_COLOR_POOL[cand])
    }
    return out
}

/** Grayscale of the same lightness: the tile keeps its pattern but carries
 * no identity colors (no key behind it yet) (web `monoFill`). */
fun identityMonoFill(c: IntArray): IntArray {
    val y = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]).toInt()
    return intArrayOf(y, y, y)
}

/**
 * Caption text color per cell: better WCAG contrast between softened
 * near-white (#f4f4f4) and near-black (#1c1c1c) — never pure #000/#fff.
 */
fun identityContrastText(rgb: IntArray): IntArray {
    fun luminance(c: Int): Double {
        val v = c / 255.0
        return if (v <= 0.03928) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)
    }
    val l = 0.2126 * luminance(rgb[0]) + 0.7152 * luminance(rgb[1]) + 0.0722 * luminance(rgb[2])
    val light = (luminance(244) + 0.05) / (l + 0.05)
    val dark = (l + 0.05) / (luminance(28) + 0.05)
    return if (light >= dark) intArrayOf(244, 244, 244) else intArrayOf(28, 28, 28)
}
