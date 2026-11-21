package org.velta.kmp.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.em

/**
 * Compose port of the web's markdown pipeline (app/js/markdown.js +
 * bare-links.js + hashtags.js + mentions.js + invites.js): **bold**,
 * __underline__, *italic* / _italic_, `code` spans (annotation CODE —
 * click-to-copy), [label](http(s)://…) links + bare scheme-less addresses,
 * @mentions, #hashtags, invite links (annotation INVITE), "> " quote lines,
 * and "- "/"* "/"+" / "1." list lines. Code, links, mentions and hashtags
 * are held out of the emphasis pass so `**@Name**` and `` *`code`* `` nest.
 */
internal const val ANN_URL = "URL"
internal const val ANN_CODE = "CODE"
internal const val ANN_MENTION = "MENTION"
internal const val ANN_INVITE = "INVITE"
/** #134: a #hashtag; a tap opens "Search in chat" prefilled with it. */
internal const val ANN_HASHTAG = "HASHTAG"

private val QUOTE_LINE = Regex("^>{1,3} ?(.*)$")
private val NUMBERED_LINE = Regex("^\\d{1,9}[.)] ")
private val MD_LINK = Regex("\\[([^\\]\\n]+)]\\((https?://[^)\\s]*)\\)", RegexOption.IGNORE_CASE)
private val SCHEME_URL = Regex("https?://[^\\s<]+", RegexOption.IGNORE_CASE)
private val VELTA_PROXY = Regex("\\bvelta://proxy\\b[^\\s<]*", RegexOption.IGNORE_CASE)
private val BOLD = Regex("\\*\\*([^*\\n]+)\\*\\*")
private val UNDER = Regex("(?<![\\w_])__([^_\\n]+)__(?![\\w_])")
private val IT_STAR = Regex("(?<![\\w*])\\*([^*\\n]+)\\*(?![\\w*])")
private val IT_UNDER = Regex("(?<![\\w_])_([^_\\n]+)_(?![\\w_])")
private val PLACEHOLDER = Regex("\u0000(\\d+)\u0000")
private val TAG = Regex("#([\\p{L}\\p{M}\\p{N}_]+)")
private val HASH_BAD_BEFORE = Regex("[\\p{L}\\p{M}\\p{N}_&#/:.@-]")
private val HAS_LETTER = Regex("\\p{L}")

/** Visual lines a bubble shows before Read more. Layout overflow decides, not raw newlines. */
internal const val READ_MORE_LINES = 12

internal fun markdownAnnotated(
    text: String,
    accent: Color,
    codeBackground: Color,
    textColor: Color,
    members: List<MentionMember> = emptyList(),
): AnnotatedString {
    // textColor is the bubble ink; emphasis uses the default span color.
    if (text.isBlank()) return AnnotatedString(text)
    val builder = AnnotatedString.Builder()
    val lines = text.split("\n")
    lines.forEachIndexed { index, rawLine ->
        if (index > 0) builder.append("\n")
        val quoted = QUOTE_LINE.find(rawLine)
        if (quoted != null) {
            builder.pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
            builder.append("│ ")
            appendInline(builder, quoted.groupValues[1], accent, codeBackground, members)
            builder.pop()
            return@forEachIndexed
        }
        val trimmed = rawLine.trimStart()
        val indent = rawLine.take(rawLine.length - trimmed.length)
        when {
            trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ ") -> {
                builder.append(indent)
                builder.append("•  ")
                appendInline(builder, trimmed.drop(2), accent, codeBackground, members)
            }
            NUMBERED_LINE.containsMatchIn(trimmed) -> {
                builder.append(indent)
                appendInline(builder, trimmed, accent, codeBackground, members)
            }
            else -> appendInline(builder, rawLine, accent, codeBackground, members)
        }
    }
    return builder.toAnnotatedString()
}

/** hashtags.js: a #word with at least one letter, not glued to the left, max 64. */
internal fun findHashtags(seg: String): List<IntRange> {
    val out = mutableListOf<IntRange>()
    for (m in TAG.findAll(seg)) {
        val i = m.range.first
        val tag = m.groupValues[1]
        if (i > 0 && HASH_BAD_BEFORE.containsMatchIn(seg[i - 1].toString())) continue
        if (!HAS_LETTER.containsMatchIn(tag) || Regex("^\\p{M}").containsMatchIn(tag)) continue
        if (tag.codePointCount(0, tag.length) > 64) continue
        out += m.range
    }
    return out
}

private data class Hold(
    val text: String,
    val ann: String?,
    val value: String?,
    val style: SpanStyle,
    val extra: SpanStyle? = null,
)

private data class Piece(val start: Int, val end: Int, val hold: Hold)

private fun appendInline(
    builder: AnnotatedString.Builder,
    content0: String,
    accent: Color,
    codeBackground: Color,
    members: List<MentionMember>,
) {
    val content = content0.replace("\u0000", "")
    if (content.isEmpty()) return
    val pieces = collectPieces(content, accent, codeBackground, members)
    val holds = mutableListOf<Hold>()
    val work = StringBuilder()
    var at = 0
    for (p in pieces) {
        if (p.start > at) work.append(content.substring(at, p.start))
        holds += p.hold
        work.append("\u0000${holds.lastIndex}\u0000")
        at = p.end
    }
    if (at < content.length) work.append(content.substring(at))
    emitFormatted(builder, work.toString(), holds)
}

private fun collectPieces(
    content: String,
    accent: Color,
    codeBackground: Color,
    members: List<MentionMember>,
): List<Piece> {
    val pieces = mutableListOf<Piece>()
    var i = 0
    while (i < content.length) {
        val open = content.indexOf('`', i)
        if (open < 0) break
        val close = content.indexOf('`', open + 1)
        if (close < 0) break
        val inner = content.substring(open + 1, close)
        if (inner.isNotEmpty()) {
            pieces += Piece(
                open,
                close + 1,
                Hold(inner, ANN_CODE, inner, SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)),
            )
        }
        i = close + 1
    }
    val linkStyle = SpanStyle(color = accent, textDecoration = TextDecoration.Underline)
    for (gap in gaps(content.length, pieces)) {
        pieces += linkHits(content, gap, linkStyle)
    }
    for (gap in gaps(content.length, pieces)) {
        val seg = content.substring(gap.first, gap.last + 1)
        for (b in findBareLinks(seg)) {
            val canonical = parseInviteLink(b.url)
            pieces += Piece(
                gap.first + b.start,
                gap.first + b.end,
                Hold(b.text, if (canonical != null) ANN_INVITE else ANN_URL, canonical ?: b.url, linkStyle),
            )
        }
    }
    for (gap in gaps(content.length, pieces)) {
        val seg = content.substring(gap.first, gap.last + 1)
        for (m in findMentions(seg, members)) {
            // Web chip (markdown.js mentionsOf): the canonical member name,
            // the parens visually hidden, the code as a small mono span; a
            // self-mention is bold + underlined. Compose has no
            // visually-hidden span, so the parens are dropped and the code
            // rides a leading space (bubble copy uses the raw message text).
            val name = m.member.name.trim()
            val code = m.code // Web shows the code span only when the text typed one (x.code); member.code feeds the title tooltip alone.
            val chip = SpanStyle(
                color = accent,
                background = codeBackground,
                fontWeight = if (m.me) FontWeight.Bold else FontWeight.Medium,
                textDecoration = if (m.me) TextDecoration.Underline else null,
            )
            val id = m.member.id.toString()
            pieces += Piece(
                gap.first + m.start,
                gap.first + m.end,
                Hold("@$name", ANN_MENTION, id, chip),
            )
            if (code.isNotEmpty()) {
                pieces += Piece(
                    gap.first + m.start,
                    gap.first + m.end,
                    Hold(
                        " $code",
                        ANN_MENTION,
                        id,
                        chip.copy(
                            fontWeight = FontWeight.Normal,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 0.72.em,
                        ),
                    ),
                )
            }
        }
    }
    for (gap in gaps(content.length, pieces)) {
        val seg = content.substring(gap.first, gap.last + 1)
        for (range in findHashtags(seg)) {
            val text = seg.substring(range.first, range.last + 1)
            pieces += Piece(
                gap.first + range.first,
                gap.first + range.last + 1,
                Hold(text, ANN_HASHTAG, text, SpanStyle(color = accent)),
            )
        }
    }
    return pieces.sortedBy { it.start }
}

private fun linkHits(content: String, gap: IntRange, linkStyle: SpanStyle): List<Piece> {
    val seg = content.substring(gap.first, gap.last + 1)
    val out = mutableListOf<Piece>()
    var at = 0
    while (at < seg.length) {
        val rest = seg.substring(at)
        val md = MD_LINK.find(rest)
        val url = SCHEME_URL.find(rest)
        val velta = VELTA_PROXY.find(rest)
        val pick = listOfNotNull(md?.range?.first?.let { it to 0 }, url?.range?.first?.let { it to 1 }, velta?.range?.first?.let { it to 2 })
            .minWithOrNull(compareBy({ it.first }, { it.second }))
        if (pick == null) break
        when (pick.second) {
            0 -> {
                val href = md!!.groupValues[2]
                val abs = gap.first + at + md.range.first
                val chip = inviteChipLabel(href)
                if (chip != null) {
                    out += Piece(abs, gap.first + at + md.range.last + 1, Hold(chip, null, null, SpanStyle()))
                } else {
                    val (label, extra) = emphasisLabel(md.groupValues[1])
                    out += Piece(abs, gap.first + at + md.range.last + 1, Hold(label, ANN_URL, href, linkStyle, extra))
                }
                at += md.range.last + 1
            }
            2 -> {
                val m = velta!!
                val trimmed = trimLinkEnd(m.value)
                val chip = inviteChipLabel(trimmed)
                if (chip == null) {
                    at += m.range.first + 1
                    continue
                }
                val abs = gap.first + at + m.range.first
                out += Piece(abs, abs + trimmed.length, Hold(chip, null, null, SpanStyle()))
                at += m.range.first + trimmed.length
            }
            else -> {
                val m = url!!
                val trimmed = trimLinkEnd(m.value)
                if (!trimmed.startsWith("http://", true) && !trimmed.startsWith("https://", true)) {
                    at += m.range.first + 1
                    continue
                }
                val abs = gap.first + at + m.range.first
                val chip = inviteChipLabel(trimmed)
                if (chip != null) {
                    out += Piece(abs, abs + trimmed.length, Hold(chip, null, null, SpanStyle()))
                } else {
                    val canonical = parseInviteLink(trimmed)
                    out += Piece(
                        abs,
                        abs + trimmed.length,
                        Hold(trimmed, if (canonical != null) ANN_INVITE else ANN_URL, canonical ?: trimmed, linkStyle),
                    )
                }
                at += m.range.first + trimmed.length
            }
        }
    }
    return out
}

private fun emphasisLabel(label: String): Pair<String, SpanStyle?> {
    fun whole(re: Regex, style: SpanStyle): Pair<String, SpanStyle>? {
        val m = re.find(label) ?: return null
        if (m.range.first != 0 || m.range.last != label.lastIndex) return null
        return m.groupValues[1] to style
    }
    whole(BOLD, SpanStyle(fontWeight = FontWeight.Bold))?.let { return it }
    whole(UNDER, SpanStyle(textDecoration = TextDecoration.Underline))?.let { return it }
    whole(IT_STAR, SpanStyle(fontStyle = FontStyle.Italic))?.let { return it }
    whole(IT_UNDER, SpanStyle(fontStyle = FontStyle.Italic))?.let { return it }
    return label to null
}

private fun gaps(len: Int, pieces: List<Piece>): List<IntRange> {
    var at = 0
    val out = mutableListOf<IntRange>()
    for (p in pieces.sortedBy { it.start }) {
        if (p.start > at) out += at until p.start
        at = maxOf(at, p.end)
    }
    if (at < len) out += at until len
    return out
}

private data class StyleBit(val start: Int, val end: Int, val style: SpanStyle)

private fun emitFormatted(builder: AnnotatedString.Builder, work: String, holds: List<Hold>) {
    val skip = BooleanArray(work.length)
    val bits = mutableListOf<StyleBit>()
    fun take(re: Regex, style: SpanStyle) {
        for (m in re.findAll(work)) {
            if (m.range.any { skip[it] || bits.any { b -> it in b.start until b.end } }) continue
            val inner = m.groups[1]!!.range
            bits += StyleBit(inner.first, inner.last + 1, style)
            for (i in m.range) if (i < inner.first || i > inner.last) skip[i] = true
        }
    }
    take(BOLD, SpanStyle(fontWeight = FontWeight.Bold))
    take(UNDER, SpanStyle(textDecoration = TextDecoration.Underline))
    take(IT_STAR, SpanStyle(fontStyle = FontStyle.Italic))
    take(IT_UNDER, SpanStyle(fontStyle = FontStyle.Italic))
    fun covering(at: Int) = bits.filter { at in it.start until it.end }
    var i = 0
    while (i < work.length) {
        if (skip[i]) {
            i++
            continue
        }
        val ph = if (work[i] == '\u0000') PLACEHOLDER.find(work, i)?.takeIf { it.range.first == i } else null
        if (ph != null) {
            val hold = holds[ph.groupValues[1].toInt()]
            val outer = covering(ph.range.first)
            outer.forEach { builder.pushStyle(it.style) }
            hold.extra?.let { builder.pushStyle(it) }
            if (hold.ann != null) builder.pushStringAnnotation(hold.ann, hold.value ?: hold.text)
            builder.pushStyle(hold.style)
            builder.append(hold.text)
            builder.pop()
            if (hold.ann != null) builder.pop()
            if (hold.extra != null) builder.pop()
            repeat(outer.size) { builder.pop() }
            i = ph.range.last + 1
            continue
        }
        val here = covering(i)
        var end = i + 1
        while (end < work.length && !skip[end] && work[end] != '\u0000' && covering(end) == here) end++
        here.forEach { builder.pushStyle(it.style) }
        builder.append(work.substring(i, end))
        repeat(here.size) { builder.pop() }
        i = end
    }
}

/**
 * Port of invites.js parseInviteLink: `openpgp4fpr:` passes through (the
 * core parses that scheme natively); an https URL on a known invite host
 * with a 40-hex fingerprint in the fragment or query (or
 * `?invite=<urlencoded>`) is a velta invite. Both forms require the final
 * 40-hex fingerprint check. Returns the CANONICAL link the core accepts —
 * `https://i.delta.chat/#<fp><payload>` for https forms, the raw scheme URL
 * for openpgp4fpr — because the core only parses that scheme and mirror
 * hosts are irrelevant to the join (app.js: "the core only parses that
 * scheme"). Extra hosts live in [recognizedExtraHosts] (settings registry).
 */
private val FP_40 = Regex("^[0-9A-Fa-f]{40}$")
private val FP_40_FORM = Regex("^([0-9A-Fa-f]{40})(?:[&#]([\\s\\S]*))?$")

internal fun parseInviteLink(raw: String): String? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    val scheme = Regex("^openpgp4fpr:", RegexOption.IGNORE_CASE).find(s)
    if (scheme != null) {
        val fp = s.substring(scheme.value.length).substringBefore("#")
        if (!FP_40.matches(fp)) return null
        return s
    }
    if (!s.startsWith("https://", ignoreCase = true)) return null
    val host = s.substring("https://".length)
        .substringBefore('/').substringBefore('?').substringBefore('#')
        .lowercase()
    if (host !in inviteHostSet()) return null
    // The payload rides the fragment ("#fp") or the query string; an
    // ?invite=<urlencoded> value is unwrapped first. The fragment wins when
    // both would match.
    val form = run {
        val fragment = s.substringAfter("#", "").removePrefix("/")
        if (Regex("^([0-9A-Fa-f]{40})(?:[&#]|$)").containsMatchIn(fragment)) return@run fragment
        val query = s.substringAfter("?", "").substringBefore("#")
        if (query.startsWith("invite=")) {
            decodeUriComponent(query.removePrefix("invite="))
                .replace(Regex("^https?://[^#\\s]*?[#?]", RegexOption.IGNORE_CASE), "")
        } else query
    }
    val m = FP_40_FORM.find(form) ?: return null
    val payload = m.groupValues[2]
    return "https://i.delta.chat/#${m.groupValues[1]}${if (payload.isEmpty()) "" else "&$payload"}"
}

/**
 * decodeURIComponent port (invites.js:92): %XX escapes decode, everything
 * else — including '+' — stays literal (invites.js's own doc: '+' means
 * space at the fragment-PARAM level, and the core's qr.rs handles that).
 * Invalid escapes are kept raw, matching the web's try/catch that keeps the
 * undecoded value; java.net.URLDecoder was both crashy (`%zz`) and wrong
 * ('+' → space).
 */
internal fun decodeUriComponent(s: String): String {
    if ('%' !in s) return s
    val out = StringBuilder()
    val bytes = ArrayList<Byte>(s.length)
    var i = 0
    fun flush() {
        if (bytes.isNotEmpty()) {
            out.append(bytes.toByteArray().decodeToString())
            bytes.clear()
        }
    }
    while (i < s.length) {
        val c = s[i]
        val hex = if (c == '%' && i + 2 < s.length) s.substring(i + 1, i + 3).toIntOrNull(16) else null
        if (hex != null) {
            bytes.add(hex.toByte())
            i += 3
        } else {
            flush()
            out.append(c)
            i += 1
        }
    }
    flush()
    return out.toString()
}
