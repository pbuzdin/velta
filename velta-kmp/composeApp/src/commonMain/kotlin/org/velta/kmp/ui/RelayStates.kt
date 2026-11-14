package org.velta.kmp.ui

/**
 * Per-relay strip logic — port of web app.js:1074-1180 (parseConnectivityHtml,
 * relaySegmentDisplayState, #76 probe downgrade, #79 SMTP attribution).
 * Pure functions, vector-tested in RelayStatesTest.
 */

/** One relay segment of the chat-list strip (web .relay-seg). */
data class RelaySeg(
    val domain: String,
    val text: String,
    val state: String, // ok | connecting | down | unreachable | offline (delayed/local ride elsewhere)
    val quota: String,
)

/** parseConnectivityHtml's result — segments + the account-wide SMTP dot. */
data class ConnectivityParse(
    val segs: List<RelaySeg>,
    val smtpState: String?, // ok | connecting | down | null = old core
    /** #79: the transport the SMTP loop is actually bound to (failover-aware). */
    val smtpVia: String?,
)

private val DOT_WEIGHT = mapOf("red" to 3, "yellow" to 2, "grey" to 1, "green" to 0)
private val DOT_STATE = mapOf("green" to "ok", "yellow" to "connecting", "grey" to "connecting", "red" to "down")

/**
 * Web parseConnectivityHtml (app.js:1141-1176): one `<li class="transport">`
 * per relay; worst dot color wins; unpublished relays skipped; quota text
 * from the nested quota-list; the SMTP dot is the LAST span-dot in the
 * document (it lives outside the transport list).
 */
fun parseConnectivityHtml(html: String): ConnectivityParse {
    val segs = mutableListOf<RelaySeg>()
    val start = html.indexOf("<li class=\"transport")
    if (start < 0) return ConnectivityParse(emptyList(), null, null)
    var end = html.indexOf("<h3>", start + 1)
    if (end < 0) end = html.indexOf("</body>", start)
    val block = html.substring(start, if (end < 0) html.length else end)

    // Match each transport li from its opening tag to the next one (the quota
    // <ul> nests <li>s, so a first-</li> match would truncate the block).
    val liRegex = Regex("<li class=\"transport( unpublished)?\">([\\s\\S]*?)(?=<li class=\"transport|$)")
    for (m in liRegex.findAll(block)) {
        if (m.groupValues[1].isNotEmpty()) continue // unpublished — phasing out
        val body = m.groupValues[2]
        val colors = Regex("class=\"(red|green|yellow|grey) dot\"").findAll(body).map { it.groupValues[1] }.toList()
        if (colors.isEmpty()) continue
        val domain = (Regex("<b>([^<]+)</b>").find(body)?.groupValues?.get(1) ?: "relay").removeSuffix(":").trim()
        val text = body.split("</b>", ignoreCase = true).getOrNull(1)
            ?.split("<br", ignoreCase = true)?.firstOrNull()
            ?.replace(Regex("<[^>]*>"), "")?.trim() ?: ""
        val quota = Regex("<ul class=\"quota-list\">([\\s\\S]*?)</ul>").find(body)?.let {
            it.groupValues[1].replace(Regex("<[^>]*>"), " ").replace(Regex("\\s+"), " ").trim()
        } ?: ""
        val worst = colors.sortedByDescending { DOT_WEIGHT[it] ?: 0 }.first()
        segs.add(RelaySeg(domain, text, DOT_STATE[worst] ?: "connecting", quota))
    }
    val dots = Regex("<span class=\"(red|green|yellow|grey) dot\"").findAll(html).map { it.groupValues[1] }.toList()
    val smtpState = dots.lastOrNull()?.let { DOT_STATE[it] }
    val smtpVia = Regex("<span class=\"smtp-via\">([^<]+)</span>").find(html)?.groupValues?.get(1)
    return ConnectivityParse(segs, smtpState, smtpVia)
}

/** Web SEVERITY (app.js:1305): higher wins when composing states. */
fun relaySeverity(state: String?): Int = when (state) {
    "ok" -> 0
    "connecting" -> 1
    "unreachable", "offline" -> 2
    "down" -> 3
    else -> 0
}

/** #76 probe downgrade (app.js:1124-1133). `probeOk` null = no probe data. */
fun relaySegmentDisplayState(state: String, probeOk: Boolean?, failedSinceMs: Long?, nowMs: Long): String {
    if (probeOk != false) return state
    val since = failedSinceMs ?: nowMs
    if (nowMs - since >= RELAY_OFFLINE_AFTER_MS) return "offline"
    return if (state == "ok") "unreachable" else state
}

const val RELAY_DOWN_AFTER_MS = 45_000L
const val RELAY_OFFLINE_AFTER_MS = 10 * 60 * 1000L
const val RELAY_PROBE_MIN_GAP_MS = 60_000L
