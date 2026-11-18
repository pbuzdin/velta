package org.velta.kmp.ui

/**
 * Message cards for relay signup links and velta://proxy (invite-cards.js).
 * velta://ws stays ordinary text: this client has no WebSocket transport.
 *
 * ponytail: one proxy for every account, so the card only offers Add and use.
 * A saved-proxy list is the SOCKS5-list box.
 */
internal data class RelayCard(val host: String, val token: String, val link: String)

internal data class SocksCard(
    val name: String,
    val host: String,
    val port: Int,
    val auth: Boolean,
    val link: String,
)

internal data class MessageInvites(val relay: RelayCard?, val socks: SocksCard?)

private const val SCAN_MAX = 20_000
private const val RELAY_LINK_MAX = 300
private val RELAY_TOKEN = Regex("^[A-Za-z0-9_-]{8,128}$")
private val RELAY_LINK = Regex("^https://([^/?#\\s]+)/i/([^/?#\\s]+)/?$", RegexOption.IGNORE_CASE)
private val CANDIDATE = Regex("\\bhttps://[^\\s<]+|\\bvelta://proxy\\b[^\\s<]*", RegexOption.IGNORE_CASE)

/** Strict https://host/i/token. The welcome field stays lenient. */
internal fun parseMessageRelay(raw: String): RelayCard? {
    val s = raw.trim()
    if (s.isEmpty() || s.length > RELAY_LINK_MAX) return null
    val m = RELAY_LINK.matchEntire(s) ?: return null
    val host = m.groupValues[1].lowercase().removeSuffix(".")
    val token = m.groupValues[2]
    if (!Onboarding.validRelayHost(host) || !RELAY_TOKEN.matches(token) || token == "claim") return null
    return RelayCard(host, token, "https://$host/i/$token")
}

internal fun parseMessageSocks(raw: String): SocksCard? {
    val link = try {
        parseProxyLink(raw)
    } catch (_: ProxyLinkError) {
        return null
    }
    val name = link.label.ifBlank { "${link.host}:${link.port}" }
    return SocksCard(name, link.host, link.port, link.user.isNotEmpty(), raw.trim())
}

/** First valid relay invite and first SOCKS5 link in [text]. */
internal fun messageInvites(text: String): MessageInvites {
    var relay: RelayCard? = null
    var socks: SocksCard? = null
    for (m in CANDIDATE.findAll(text.take(SCAN_MAX))) {
        val u = trimLinkEnd(m.value)
        if (u.startsWith("https:", ignoreCase = true)) {
            if (relay == null) relay = parseMessageRelay(u)
        } else if (socks == null) {
            socks = parseMessageSocks(u)
        }
        if (relay != null && socks != null) break
    }
    return MessageInvites(relay, socks)
}

/** Token-free chip label, or null when [raw] is not a card link. */
internal fun inviteChipLabel(raw: String): String? {
    parseMessageRelay(raw)?.let { return L.t("Relay invite: {host}").replace("{host}", it.host) }
    parseMessageSocks(raw)?.let { return L.t("SOCKS5 proxy: {name}").replace("{name}", it.name) }
    return null
}

internal fun relayAccountConfirm(host: String) = ConfirmSpec(
    title = "Create an account on {host}?",
    text = "A new profile is created on {host} with this invite. The invite works once. Only continue if you trust the sender.",
    ok = "Create account",
    danger = false,
    args = mapOf("host" to host),
)

/** Confirmation body for the one-proxy client (proxy.js proxyConfirmText). */
internal fun socksConfirmBody(link: ProxyLink, current: String?): String {
    val lines = mutableListOf<String>()
    if (link.label.isNotEmpty()) lines += L.t("Name: {label}").replace("{label}", link.label)
    lines += L.t("Proxy server: {server}").replace("{server}", "${link.host}:${link.port}")
    if (link.user.isNotEmpty()) {
        lines += L.t("The link includes the proxy's username and password. Anyone with the link can use the proxy.")
    }
    if (!current.isNullOrBlank()) {
        lines += L.t("“Add and use” switches from the proxy in use ({name}); it stays saved.").replace("{name}", current)
    }
    lines += L.t("All chat traffic will go through this proxy server while it is in use. Your messages stay end-to-end encrypted, but the proxy operator sees which relays you connect to and when.")
    lines += L.t("Only accept proxy links from someone you trust.")
    return lines.joinToString("\n\n")
}
