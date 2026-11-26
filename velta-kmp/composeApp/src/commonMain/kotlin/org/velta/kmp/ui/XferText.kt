package org.velta.kmp.ui

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Velta Dash offer text (#470). The wire message carries a Delta Chat
 * explainer plus a `VXFER1:` ticket. Velta never shows the explainer or
 * the ticket: the web draws a file card, and KMP (no card yet) shows a
 * short "📎 name · size" line. Same rules as app/js/iroh-xfer.js.
 */

internal const val XFER_TICKET_PREFIX = "VXFER1:"
internal const val XFER_RESEND_PREFIX = "VXFER-RESEND:"

private val NAME_SIZE_PATTERNS = listOf(
    Regex("""📎\s+(.+?)\s+·\s+(\d+(?:\.\d+)?\s*(?:MB|KB))\b"""),
    Regex("""📦\s+(.+?)\s+\((\d+(?:\.\d+)?\s*(?:MB|KB))\)"""),
    Regex("""Offering\s+(.+?)\s+\((\d+(?:\.\d+)?\s*(?:KB|MB))\)""", RegexOption.IGNORE_CASE),
)

internal data class XferCard(val name: String, val size: Long, val ticket: String)

internal fun parseFileCard(text: String): XferCard? {
    val line = text.lineSequence().map { it.trim() }.firstOrNull { it.startsWith(XFER_TICKET_PREFIX) }
        ?: return null
    val parsed = ticketNameSize(line) ?: return null
    return XferCard(parsed.first, parsed.second, line)
}

@OptIn(ExperimentalEncodingApi::class)
private fun ticketNameSize(line: String): Pair<String, Long>? {
    val raw = line.trim().removePrefix(XFER_TICKET_PREFIX)
    if (raw == line.trim()) return null
    return try {
        val padded = raw.replace('-', '+').replace('_', '/')
        val pad = (4 - padded.length % 4) % 4
        val json = Base64.Default.decode(padded + "=".repeat(pad)).decodeToString()
        val obj = Json.parseToJsonElement(json).jsonObject
        val name = obj["name"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() } ?: return null
        val size = obj["size"]?.jsonPrimitive?.longOrNull ?: return null
        name to size
    } catch (_: Exception) {
        null
    }
}

internal fun looksLikeXferExplainer(text: String): Boolean {
    if (text.isEmpty()) return false
    if (text.contains(XFER_TICKET_PREFIX) || text.contains(XFER_RESEND_PREFIX) ||
        text.contains("velta.cc/dash", ignoreCase = true)
    ) return true
    if (Regex("sent with Velta Dash|envoyé avec Velta Dash|отправлено через Velta Dash", RegexOption.IGNORE_CASE)
            .containsMatchIn(text)
    ) return true
    if (text.contains("If your app can't open this, the file follows by email", ignoreCase = true)) return true
    if (text.contains("Si votre application ne peut pas l'ouvrir")) return true
    if (text.contains("Если ваше приложение не открывает это")) return true
    if (Regex("""open ["“']Velta Beam["”'] to receive""", RegexOption.IGNORE_CASE).containsMatchIn(text)) return true
    return false
}

internal fun fmtXferSize(n: Long): String {
    if (n >= 1_048_576L) {
        val tenth = (n * 10 + 524_288) / 1_048_576
        return "${tenth / 10}.${tenth % 10} MB"
    }
    return "${maxOf(1L, (n + 512) / 1024)} KB"
}

private fun extractNameSize(text: String): Pair<String, String>? {
    for (line in text.lineSequence()) {
        for (p in NAME_SIZE_PATTERNS) {
            val m = p.find(line) ?: continue
            return m.groupValues[1].trim() to m.groupValues[2]
        }
    }
    return null
}

/**
 * Short Velta-facing line for a Dash offer or resend request, or null if
 * [text] is an ordinary message. [t] localizes "Asked for the email copy".
 */
internal fun xferDisplayText(text: String, t: (String) -> String = { it }): String? {
    val card = parseFileCard(text)
    if (card != null) return "📎 ${card.name} · ${fmtXferSize(card.size)}"
    if (text.contains(XFER_RESEND_PREFIX)) return t("Asked for the email copy")
    if (looksLikeXferExplainer(text)) {
        val ex = extractNameSize(text)
        if (ex != null) return "📎 ${ex.first} · ${ex.second}"
        return "Velta Dash"
    }
    return null
}

/** Like [xferDisplayText], but leaves ordinary messages unchanged. */
internal fun xferVisibleText(text: String, t: (String) -> String = { it }): String =
    xferDisplayText(text, t) ?: text
