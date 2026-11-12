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
                if (close >= 0 && urlText.startsWith("https://")) {
                    appendEmphasis(builder, content.substring(i, open), accent, textColor)
                    val ann = if (parseInviteLink(urlText) != null) ANN_INVITE else ANN_URL
                    builder.pushStringAnnotation(ann, urlText)
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
                val ann = if (parseInviteLink(u.value) != null) ANN_INVITE else ANN_URL
                builder.pushStringAnnotation(ann, u.value)
                builder.pushStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
                builder.append(u.value)
                builder.pop()
                builder.pop()
                i = u.range.last + 1
            }
            "bare" -> {
                val b = bare!!
                appendEmphasis(builder, content.substring(i, b.start), accent, textColor)
                builder.pushStringAnnotation(ANN_URL, b.url)
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
 * Port of invites.js parseInviteLink (host-list check relaxed to the
 * fingerprint payload, which is the real validator): `openpgp4fpr:` passes
 * through; an https URL with a 40-hex fingerprint in the fragment or query
 * (or `?invite=<urlencoded>`) is a velta invite.
 */
internal fun parseInviteLink(raw: String): String? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    if (Regex("^openpgp4fpr:", RegexOption.IGNORE_CASE).containsMatchIn(s)) return s
    if (!s.startsWith("https://")) return null
    val form = run {
        val fragment = s.substringAfter("#", "").removePrefix("/")
        if (Regex("^([0-9A-Fa-f]{40})(?:[&#]|$)").containsMatchIn(fragment)) return@run fragment
        val query = s.substringAfter("?", "").substringBefore("#")
        if (query.startsWith("invite=")) {
            val decoded = java.net.URLDecoder.decode(query.removePrefix("invite="), "UTF-8")
                .replace(Regex("^https?://[^#\\s]*?[#?]", RegexOption.IGNORE_CASE), "")
            decoded
        } else query
    }
    val m = Regex("^([0-9A-Fa-f]{40})(?:[&#]([\\s\\S]*))?$").find(form) ?: return null
    return s
}
