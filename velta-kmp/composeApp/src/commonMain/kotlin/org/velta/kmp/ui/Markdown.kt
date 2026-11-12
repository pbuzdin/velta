package org.velta.kmp.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.graphics.Color

/**
 * Compose port of the web's markdown subset (app/js/markdown.js):
 * **bold**, __underline__, *italic* / _italic_, `code` spans,
 * [label](https://…) links + bare https URLs, #hashtags, and
 * "- "/"* " / "1." list lines. Escape-first on the web = build spans over
 * the RAW string here; only https URLs are treated as links.
 */
internal fun markdownAnnotated(
    text: String,
    accent: Color,
    codeBackground: Color,
    textColor: Color,
): AnnotatedString {
    if (text.isBlank()) return AnnotatedString(text)
    val builder = AnnotatedString.Builder()
    // Line model: bullets and numbered items get a marker prefix; everything
    // else keeps its line break (pre-wrap like the web's msg-text).
    val lines = text.split("\n")
    lines.forEachIndexed { index, rawLine ->
        if (index > 0) builder.append("\n")
        val trimmed = rawLine.trimStart()
        when {
            trimmed.startsWith("- ") || trimmed.startsWith("* ") -> {
                builder.append(rawLine.take(rawLine.length - trimmed.length))
                builder.append("•  ")
                appendInline(builder, trimmed.drop(2), accent, codeBackground, textColor)
            }
            Regex("^\\d+[.)] ").containsMatchIn(trimmed) -> {
                builder.append(rawLine.take(rawLine.length - trimmed.length))
                appendInline(builder, trimmed, accent, codeBackground, textColor)
            }
            else -> appendInline(builder, rawLine, accent, codeBackground, textColor)
        }
    }
    return builder.toAnnotatedString()
}

private const val URL_RE = "https://[\\p{L}\\p{N}._~:/?#\\[\\]@!$&'()*+,;=%-]+"
private const val EM_RE = "(\\*\\*([^*\\n]+)\\*\\*)|(__([^_\\n]+)__)|(\\*([^*\\n]+)\\*)|(_([^_\\n]+)_)"

/** Inline pass: nearest-marker dispatch — whichever construct starts first
 * wins, so the text before it still runs through the other passes. */
private fun appendInline(
    builder: AnnotatedString.Builder,
    content: String,
    accent: Color,
    codeBackground: Color,
    textColor: Color,
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
        val first = buildList {
            code?.let { add(it to "code") }
            link?.let { add(it to "link") }
            em?.let { add(it.range.first to "em") }
            url?.let { add(it.range.first to "url") }
            hash?.let { add(it to "hash") }
        }.minByOrNull { it.first }
        when (first?.second) {
            "code" -> {
                val open = code!!
                val end = content.indexOf("`", open + 1)
                appendEmphasis(builder, content.substring(i, open), accent, textColor)
                builder.pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground))
                builder.append(content.substring(open + 1, end))
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
                    builder.pushStringAnnotation("URL", urlText)
                    builder.pushStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
                    builder.append(content.substring(open + 1, close))
                    builder.pop()
                    builder.pop()
                    i = endParen + 1
                } else {
                    // Not a link — keep the bracket literal and move on.
                    appendEmphasis(builder, content.substring(i, open + 1), accent, textColor)
                    i = open + 1
                }
            }
            "url" -> {
                val u = url!!
                appendEmphasis(builder, content.substring(i, u.range.first), accent, textColor)
                builder.pushStringAnnotation("URL", u.value)
                builder.pushStyle(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
                builder.append(u.value)
                builder.pop()
                builder.pop()
                i = u.range.last + 1
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
