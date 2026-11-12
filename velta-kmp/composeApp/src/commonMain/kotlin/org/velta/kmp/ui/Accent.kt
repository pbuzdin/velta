package org.velta.kmp.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb

/**
 * Port of app/js/chat-appearance.js (#321 step 5): a custom accent color is
 * normalized, then pushed through WCAG 2.x sRGB contrast math to derive the
 * token set it drives — accent fills, on-accent ink, the own-bubble
 * composite, meta/link/tick tints, quote names — so every text/background
 * pair stays >= 4.5:1 (3:1 for ticks) exactly like the web.
 */
object Accent {

    /** Preset swatches (chat-appearance.js:20-23); null = stock accent. */
    val PRESETS: List<String?> = listOf(
        null, "#8774e1", "#3fa34d", "#1fa69a", "#ee8a1f", "#e0516e", "#c79a0f", "#7a8496",
    )

    private const val INK_LIGHT = "#f4f4f4"
    private const val INK_DARK = "#10131a"
    private const val L_MIN = 0.04
    private const val L_MAX = 0.955

    /** normHex: '#rgb'/'#rrggbb' only, lowercased, 3-digit expanded. */
    fun normHex(v: String?): String? {
        if (v == null) return null
        var s = v.trim().lowercase()
        if (Regex("^#[0-9a-f]{3}$").containsMatchIn(s)) {
            s = "#" + s.drop(1).map { c -> "$c$c" }.joinToString("")
        }
        return if (Regex("^#[0-9a-f]{6}$").containsMatchIn(s)) s else null
    }

    fun toColor(hex: String): Color {
        val n = hex.substring(1).toInt(16)
        return Color((n shr 16) and 255, (n shr 8) and 255, n and 255)
    }

    private fun hexToRgb(h: String): List<Int> {
        val n = h.substring(1).toInt(16)
        return listOf((n shr 16) and 255, (n shr 8) and 255, n and 255)
    }

    private fun rgbToHex(rgb: List<Double>): String =
        "#" + rgb.joinToString("") {
            (Math.round(it.coerceIn(0.0, 255.0)).toInt().toString(16)).padStart(2, '0')
        }

    private fun luminance(hex: String): Double {
        val (r, g, b) = hexToRgb(hex).map { c ->
            val v = c / 255.0
            if (v <= 0.04045) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    fun contrast(a: String, b: String): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }

    private fun rgbToHsl(rgb: List<Int>): List<Double> {
        val (r0, g0, b0) = rgb.map { it / 255.0 }
        val max = maxOf(r0, g0, b0)
        val min = minOf(r0, g0, b0)
        val l = (max + min) / 2.0
        if (max == min) return listOf(0.0, 0.0, l)
        val d = max - min
        val s = if (l > 0.5) d / (2 - max - min) else d / (max + min)
        val h = when (max) {
            r0 -> (g0 - b0) / d + (if (g0 < b0) 6.0 else 0.0)
            g0 -> (b0 - r0) / d + 2.0
            else -> (r0 - g0) / d + 4.0
        }
        return listOf(h * 60.0, s, l)
    }

    private fun hslToRgb(hsl: List<Double>): List<Double> {
        val (h, s, l) = hsl
        fun k(n: Double) = (n + h / 30.0) % 12.0
        val a = s * minOf(l, 1 - l)
        fun f(n: Double): Double {
            val k = k(n)
            return l - a * maxOf(-1.0, minOf(k - 3.0, 9.0 - k, 1.0))
        }
        return listOf(f(0.0) * 255.0, f(8.0) * 255.0, f(4.0) * 255.0)
    }

    private fun mix(a: String, b: String, t: Double): String {
        val x = hexToRgb(a)
        val y = hexToRgb(b)
        return rgbToHex(x.mapIndexed { i, c -> c + (y[i] - c) * t })
    }

    private fun soften(hex: String): String {
        val hsl = rgbToHsl(hexToRgb(hex)).toMutableList()
        if (hsl[2] >= L_MIN && hsl[2] <= L_MAX) return hex
        hsl[2] = hsl[2].coerceIn(L_MIN, L_MAX)
        return rgbToHex(hslToRgb(hsl))
    }

    /** Move fg's HSL lightness toward white (dir 1) / black (dir -1) until it
     * reaches [ratio] against bg; soft-range search, soft-ink fallback. */
    private fun ensureContrast(fg: String, bg: String, ratio: Double, dir: Int): String {
        val start = soften(normHex(fg) ?: fg)
        if (contrast(start, bg) >= ratio) return start
        val hsl = rgbToHsl(hexToRgb(start)).toMutableList()
        repeat(100) {
            hsl[2] = (hsl[2] + dir * 0.01).coerceIn(L_MIN, L_MAX)
            val c = rgbToHex(hslToRgb(hsl))
            if (contrast(c, bg) >= ratio) return c
            if (hsl[2] == L_MIN || hsl[2] == L_MAX) return if (dir > 0) INK_LIGHT else INK_DARK
        }
        return if (dir > 0) INK_LIGHT else INK_DARK
    }

    private fun shift(hex: String, dl: Double): String {
        val hsl = rgbToHsl(hexToRgb(hex)).toMutableList()
        hsl[2] = (hsl[2] + dl).coerceIn(0.04, 0.955)
        return rgbToHex(hslToRgb(hsl))
    }

    /** Text color for a fill: soft white or soft black, whichever reads better. */
    private fun onColor(bg: String): String =
        if (contrast(INK_LIGHT, bg) >= contrast(INK_DARK, bg)) INK_LIGHT else INK_DARK

    /** Iterate until the color clears 4.5 against its own tinted composite
     * (the web's tintStable — mention chips lay a tint of the text color
     * OVER the bubble, so the background darkens WITH the text). */
    private fun tintStable(start: String, tintRatio: Double, bgBase: String): String {
        var color = start
        repeat(24) {
            val next = ensureContrast(color, mix(bgBase, color, tintRatio), 4.5, -1)
            if (next == color) return color
            color = next
        }
        return color
    }

    private class Surf(
        val text: String,
        val bubbleIn: String,
        val chat: String,
        val quote: String,
        val sidebar: String,
        val raised: String,
    )

    /** Alpha-carrying tokens (bgReply/bgHover are % whites) composite over
     * their real backdrop before contrast math — the web's SURF constants
     * ARE those composites (quote = bg-reply over the incoming bubble,
     * raised = --bg-hover over --bg). */
    internal fun opaque(c: Color, over: Color): Color {
        val f = ((c.toArgb() ushr 24) and 0xFF) / 255f
        if (f >= 1f) return c
        return Color(
            red = c.red * f + over.red * (1 - f),
            green = c.green * f + over.green * (1 - f),
            blue = c.blue * f + over.blue * (1 - f),
            alpha = 1f,
        )
    }

    private fun surfOf(t: VeltaTokens) = Surf(
        text = hexOf(t.text),
        bubbleIn = hexOf(t.bgBubbleIn),
        chat = hexOf(t.bgChat),
        quote = hexOf(opaque(t.bgReply, t.bgBubbleIn)),
        sidebar = hexOf(t.bgSidebar),
        raised = hexOf(opaque(t.bgHover, t.bg)),
    )

    private fun hexOf(c: Color): String {
        val argb = c.toArgb()
        return "#%06x".format(argb and 0xFFFFFF)
    }

    /**
     * The accent-derived tokens ([deriveAccent] in chat-appearance.js).
     * [brutal] keeps its own yellow own-bubble/selection palette — the
     * custom accent drives only the accent fills and accent text there
     * (BRUTAL_KEYS on the web).
     */
    fun derive(base: VeltaTokens, rawHex: String?, brutal: Boolean = false): VeltaTokens {
        val c = normHex(rawHex) ?: return base
        val s = surfOf(base)
        val dark = base.isDark
        val dir = if (dark) 1 else -1
        var accent = ensureContrast(c, s.bubbleIn, 4.5, dir)
        accent = ensureContrast(accent, s.chat, 4.5, dir)
        val onAccent = onColor(accent)
        // Accent-colored UI text (.btn-text, status, send icon) on the app
        // surfaces: sidebar, incoming bubble, quote, raised — all >= 4.6:1.
        val accentText = listOf(s.sidebar, s.bubbleIn, s.quote, s.raised)
            .fold(c) { acc, bg -> ensureContrast(acc, bg, 4.6, dir) }

        // Hexes stay strings through the derivation (the math needs them);
        // conversion to Color happens once at the copy() below.
        var bubbleOut = ""
        var bgActive = ""
        var selectionBg = ""
        var metaOut = ""
        var outLink = ""
        var ticksRead = ""
        var accentTextIn = ""
        var quoteName = ""

        if (dark) {
            // Own bubble: the accent pushed down into the chat's dark, then
            // darkened until the body text clears 7:1 so meta/link tints
            // still fit above 4.5.
            val bubble = ensureContrast(mix(c, s.chat, 0.5), s.text, 7.0, -1)
            bubbleOut = bubble
            bgActive = bubble
            selectionBg = bubble
            metaOut = ensureContrast(mix(c, INK_LIGHT, 0.55), bubble, 4.5, 1)
            outLink = ensureContrast(mix(c, INK_LIGHT, 0.82), bubble, 4.5, 1)
            ticksRead = ensureContrast(mix(c, INK_LIGHT, 0.35), bubble, 3.0, 1)
            accentTextIn = accent
            quoteName = ensureContrast(accent, s.quote, 4.6, dir)
        } else {
            // Own bubble: a light tint of the accent (default #e1f0fb ~ 14%).
            val bubble = ensureContrast(mix(c, s.bubbleIn, 0.86), s.text, 7.0, 1)
            bubbleOut = bubble
            bgActive = accent
            selectionBg = accent
            metaOut = ensureContrast(mix(c, s.text, 0.25), bubble, 4.5, -1)
            outLink = tintStable(ensureContrast(mix(c, s.text, 0.55), bubble, 4.5, -1), 0.14, bubble)
            ticksRead = ensureContrast(c, bubble, 3.0, -1)
            accentTextIn = tintStable(accent, 0.08, s.bubbleIn)
            quoteName = ensureContrast(outLink, s.quote, 4.6, dir)
        }

        return if (brutal) {
            // Brutal: accent fills + accent text only (BRUTAL_KEYS — the
            // yellow own-bubble/selection/ink palette stays stock).
            base.copy(
                accent = toColor(accent),
                onAccent = toColor(onAccent),
                onBadge = toColor(onAccent),
                accentText = toColor(accentText),
            )
        } else {
            base.copy(
                accent = toColor(accent),
                onAccent = toColor(onAccent),
                onBadge = toColor(onAccent),
                bgBubbleOut = toColor(bubbleOut),
                bgActive = toColor(bgActive),
                selectionBg = toColor(selectionBg),
                textMetaOut = toColor(metaOut),
                outLink = toColor(outLink),
                ticksRead = toColor(ticksRead),
                accentTextIn = toColor(accentTextIn),
                quoteName = toColor(quoteName),
                accentText = toColor(accentText),
            )
        }
    }
}