package org.velta.kmp.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.graphics.Color

/**
 * Compose port of the web's markdown pipeline (app/js/markdown.js +
 * bare-links.js + mentions.js + invites.js): **bold**, __underline__,
 * *italic* / _italic_, `code` spans (annotation CODE — click-to-copy),
 * [label](https://…) links + bare scheme-less addresses (bare-links tiers),
 * @mentions of chat members, #hashtags, velta invite links (annotation
 * INVITE — the bubble renders the join card), and "- "/"* " / "1." list
 * lines. Escape-first on the web = build spans over the RAW string here;
 * only https URLs become links.
 */
internal const val ANN_URL = "URL"
internal const val ANN_CODE = "CODE"
internal const val ANN_MENTION = "MENTION"
internal const val ANN_INVITE = "INVITE"

internal fun markdownAnnotated(
    text: String,
    accent: Color,
    codeBackground: Color,
    textColor: Color,
    members: List<MentionMember> = emptyList(),
): AnnotatedString {
    if (text.isBlank()) return AnnotatedString(text)
    val builder = AnnotatedString.Builder()
    val lines = text.split("\n")
    lines.forEachIndexed { index, rawLine ->
        if (index > 0) builder.append("\n")
        val trimmed = rawLine.trimStart()
        when {
            trimmed.startsWith("- ") || trimmed.startsWith("* ") -> {
                builder.append(rawLine.take(rawLine.length - trimmed.length))
                builder.append("•  ")
                appendInline(builder, trimmed.drop(2), accent, codeBackground, textColor, members)
            }
            Regex("^\\d+[.)] ").containsMatchIn(trimmed) -> {
                builder.append(rawLine.take(rawLine.length - trimmed.length))
                appendInline(builder, trimmed, accent, codeBackground, textColor, members)
            }
            else -> appendInline(builder, rawLine, accent, codeBackground, textColor, members)
        }
    }
    return builder.toAnnotatedString()
}

private const val URL_RE = "https://[\\p{L}\\p{N}._~:/?#\\[\\]@!$&'()*+,;=%-]+"
private const val EM_RE = "(\\*\\*([^*\\n]+)\\*\\*)|(__([^_\\n]+)__)|(\\*([^*\\n]+)\\*)|(_([^_\\n]+)_)"

private fun appendInline(
    builder: AnnotatedString.Builder,
    content: String,
    accent: Color,
    codeBackground: Color,
    textColor: Color,
    members: List<MentionMember>,
) {
    var i = 0
    val urlRe = Regex(URL_RE)
    val emRe = Regex(EM_RE)
    while (i < content.length) {
        val code = content.indexOf("`", i).takeIf { it >= 0 && content.indexOf("`", it + 1) >= 0 }
        val link = content.indexOf("[", i).takeIf { it >= 0 }
        val em = emRe.find(content, i)
        val url = urlRe.find(content, i)
        val hash = content.indexOf("#", i).takeIf {
            it != null && it >= 0 && it + 1 < content.length && content[it + 1].isLetterOrDigit()
        }
        val bare = findBareLinks(content.substring(i)).firstOrNull()?.let { it.copy(start = it.start + i, end = it.end + i) }
        val mention = findMentions(content.substring(i), members).firstOrNull()?.let { it.copy(start = it.start + i, end = it.end + i) }
        val first = buildList {
            code?.let { add(it to "code") }
            link?.let { add(it to "link") }
            em?.let { add(it.range.first to "em") }
            url?.let { add(it.range.first to "url") }
            bare?.let { add(it.start to "bare") }
            mention?.let { add(it.start to "mention") }
            hash?.let { add(it to "hash") }
        }.minByOrNull { it.first }
        when (first?.second) {
            "code" -> {
                val open = code!!
                val end = content.indexOf("`", open + 1)
                appendEmphasis(builder, content.substring(i, open), accent, textColor)
                builder.pushStringAnnotation(ANN_CODE, content.substring(open + 1, end))
                builder.pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground))
                builder.append(content.substring(open + 1, end))
                builder.pop()
                builder.pop()
                i = end + 1
            }
            "link" -> {
                val open = link!!
                val close = content.indexOf("]", open + 1)
                val openParen = if (close >= 0 && close + 1 < content.length && content[close + 1] == '(') close + 1 else -1
                val endParen = if (openParen >= 0) content.indexOf(")", openParen + 1) else -1
                val urlText = if (endParen > 0) content.substring(openParen + 1, endParen) else ""
                if (close >= 0 && urlText.startsWith("https://", ignoreCase = true)) {
                    appendEmphasis(builder, content.substring(i, open), accent, textColor)
                    // Web markdown.js renders [label](invite) as a plain
                    // anchor — invite CARDS are bare-URL-only; the bubble's
                    // tap handler intercepts invite hrefs for the join flow.
                    builder.pushStringAnnotation(ANN_URL, urlText)
                    builder.pushStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
                    builder.append(content.substring(open + 1, close))
                    builder.pop()
                    builder.pop()
                    i = endParen + 1
                } else {
                    appendEmphasis(builder, content.substring(i, open + 1), accent, textColor)
                    i = open + 1
                }
            }
            "url" -> {
                val u = url!!
                appendEmphasis(builder, content.substring(i, u.range.first), accent, textColor)
                // Bare https invites get the card (inviteCardHtml), carrying
                // the CANONICAL link so the join works from mirror hosts.
                val canonical = parseInviteLink(u.value)
                if (canonical != null) {
                    builder.pushStringAnnotation(ANN_INVITE, canonical)
                } else {
                    builder.pushStringAnnotation(ANN_URL, u.value)
                }
                builder.pushStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
                builder.append(u.value)
                builder.pop()
                builder.pop()
                i = u.range.last + 1
            }
            "bare" -> {
                val b = bare!!
                appendEmphasis(builder, content.substring(i, b.start), accent, textColor)
                // Scheme-less invites (i.delta.chat/#fp typed bare) ride the
                // same card path as their https:// spelled-out form.
                val canonical = parseInviteLink(b.url)
                if (canonical != null) {
                    builder.pushStringAnnotation(ANN_INVITE, canonical)
                } else {
                    builder.pushStringAnnotation(ANN_URL, b.url)
                }
                builder.pushStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
                builder.append(b.text)
                builder.pop()
                builder.pop()
                i = b.end
            }
            "mention" -> {
                val m = mention!!
                appendEmphasis(builder, content.substring(i, m.start), accent, textColor)
                builder.pushStringAnnotation(ANN_MENTION, m.member.id.toString())
                builder.pushStyle(SpanStyle(color = accent, background = codeBackground, fontWeight = FontWeight.Medium))
                builder.append(content.substring(m.start, m.end))
                builder.pop()
                builder.pop()
                i = m.end
            }
            "hash" -> {
                val h = hash!!
                var end = h + 1
                while (end < content.length && (content[end].isLetterOrDigit() || content[end] == '_')) end++
                appendEmphasis(builder, content.substring(i, h), accent, textColor)
                builder.pushStyle(SpanStyle(color = accent))
                builder.append(content.substring(h, end))
                builder.pop()
                i = end
            }
            "em" -> {
                val e = em!!
                appendEmphasis(builder, content.substring(i, e.range.first), accent, textColor)
                val inner = when {
                    e.groups[2] != null -> e.groups[2]!!.value
                    e.groups[4] != null -> e.groups[4]!!.value
                    e.groups[6] != null -> e.groups[6]!!.value
                    else -> e.groups[8]!!.value
                }
                val style = when {
                    e.groups[2] != null -> SpanStyle(fontWeight = FontWeight.Bold)
                    e.groups[4] != null -> SpanStyle(textDecoration = TextDecoration.Underline)
                    e.groups[6] != null -> SpanStyle(fontStyle = FontStyle.Italic)
                    else -> SpanStyle(fontStyle = FontStyle.Italic)
                }
                builder.pushStyle(style)
                builder.append(inner)
                builder.pop()
                i = e.range.last + 1
            }
            else -> {
                builder.appendPlain(content.substring(i))
                return
            }
        }
    }
}

/** The text between markers still carries emphasis pairs — process until a
 * marker-free remainder. */
private fun appendEmphasis(
    builder: AnnotatedString.Builder,
    content: String,
    accent: Color,
    textColor: Color,
) {
    if (content.isEmpty()) return
    val emRe = Regex(EM_RE)
    var i = 0
    while (i < content.length) {
        val e = emRe.find(content, i) ?: break
        if (e.range.first > i) builder.appendPlain(content.substring(i, e.range.first))
        val inner = when {
            e.groups[2] != null -> e.groups[2]!!.value
            e.groups[4] != null -> e.groups[4]!!.value
            e.groups[6] != null -> e.groups[6]!!.value
            else -> e.groups[8]!!.value
        }
        val style = when {
            e.groups[2] != null -> SpanStyle(fontWeight = FontWeight.Bold)
            e.groups[4] != null -> SpanStyle(textDecoration = TextDecoration.Underline)
            e.groups[6] != null -> SpanStyle(fontStyle = FontStyle.Italic)
            else -> SpanStyle(fontStyle = FontStyle.Italic)
        }
        builder.pushStyle(style)
        builder.append(inner)
        builder.pop()
        i = e.range.last + 1
    }
    builder.appendPlain(content.substring(i))
}

private fun AnnotatedString.Builder.appendPlain(part: String) {
    if (part.isEmpty()) return
    append(part)
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
 * scheme"). The user-registered "Invite link domains" registry is not
 * ported yet; the four builtins are.
 */
private val INVITE_HOSTS = setOf("velta.cc", "i.delta.chat", "i.deltachat.id", "i.gluek.info")
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
    if (host !in INVITE_HOSTS) return null
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
private fun decodeUriComponent(s: String): String {
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
