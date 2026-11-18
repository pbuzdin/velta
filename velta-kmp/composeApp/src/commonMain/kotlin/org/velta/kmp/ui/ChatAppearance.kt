package org.velta.kmp.ui

import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** Web `chat-appearance.js` / `text-lang.js`. Absent font = 15.5, absent radius = the theme's, hyphens off only when the key is "0". */
internal const val MSG_FONT_DEFAULT = 15.5f

internal fun clampMsgFont(px: Float): Float {
    if (!px.isFinite()) return MSG_FONT_DEFAULT
    val snapped = kotlin.math.round(px * 2f).toFloat() / 2f
    return snapped.coerceIn(10f, 22f)
}

internal fun clampMsgFont(raw: String?): Float =
    raw?.toFloatOrNull()?.let(::clampMsgFont) ?: MSG_FONT_DEFAULT

/** Default removes the key (`write()`). "16.0" would not match the web's "16". */
internal fun fontPrefValue(px: Float): String? {
    val v = clampMsgFont(px)
    if (v == MSG_FONT_DEFAULT) return null
    return if (v == v.toInt().toFloat()) v.toInt().toString() else v.toString()
}

/** null = key absent = theme radius. A present non-number clamps to 14 (`clampRadius`). */
internal fun storedBubbleRadius(raw: String?): Int? {
    if (raw == null) return null
    val n = raw.toFloatOrNull() ?: return 14
    return n.roundToInt().coerceIn(0, 14)
}

/** Back on the theme's own radius stores null, so a later theme switch keeps each theme's corners. */
internal fun bubbleRadiusPref(px: Int, themeRadiusPx: Int): Int? {
    val v = px.coerceIn(0, 14)
    return if (v == themeRadiusPx) null else v
}

internal fun withBubbleRadius(tokens: VeltaTokens, overridePx: Int?): VeltaTokens {
    val r = overridePx?.coerceIn(0, 14) ?: return tokens
    return tokens.copy(
        radiusBubble = r.dp,
        radiusTail = minOf(6, r).dp,
        radiusQuote = minOf(6, r).dp,
        radiusMedia = maxOf(0, r - 4).dp,
    )
}

internal fun pxLabel(px: Float): String {
    val n = if (px == px.toInt().toFloat()) px.toInt().toString() else px.toString()
    return "$n px"
}

// text-lang.js MACHINE: links, emails, and bare domains are not language evidence.
private val MACHINE = Regex(
    """\b[a-z][a-z0-9+.-]*://\S+|\S+@\S+\.\S+|\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[a-z]{2,}(?:/\S*)?""",
    RegexOption.IGNORE_CASE,
)

internal fun detectTextLang(text: String?, fallback: String): String {
    if (text.isNullOrEmpty()) return fallback
    val stripped = MACHINE.replace(text.take(2000), " ")
    var cyr = 0
    var lat = 0
    val n = minOf(stripped.length, 400)
    for (i in 0 until n) {
        val ch = stripped[i]
        when {
            ch in '\u0400'..'\u04FF' -> cyr++
            ch in 'A'..'Z' || ch in 'a'..'z' || ch in '\u00C0'..'\u024F' -> lat++
        }
    }
    if (cyr == 0 && lat == 0 || cyr == lat) return fallback
    return if (cyr > lat) "ru" else "en"
}

internal fun hyphenFallback(uiLang: String): String = if (uiLang.startsWith("ru")) "ru" else "en"

/** Web `velta-stickers-in-attach`. Absent is off. Only `"1"` turns it on. */
internal fun stickersInAttachPref(raw: String?): Boolean = raw == "1"

/** Empty composer, and the attach-menu switch is off. P2P groups offer no stickers. */
internal fun showStickerButton(inAttach: Boolean, hasText: Boolean, p2pGroup: Boolean): Boolean =
    !p2pGroup && !inAttach && !hasText

/** Attach-menu row. Same P2P refusal as the button. */
internal fun showStickersInMenu(inAttach: Boolean, p2pGroup: Boolean): Boolean =
    inAttach && !p2pGroup
