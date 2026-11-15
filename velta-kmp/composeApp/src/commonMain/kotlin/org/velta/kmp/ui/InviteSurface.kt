package org.velta.kmp.ui

/**
 * invites.js surface that the canonical-link parser did not cover:
 * extra hosts (`velta-invite-hosts`), card labels, and deltachat.id
 * short links. The process-wide [recognizedExtraHosts] is what
 * [parseInviteLink] consults; [AppModel] writes it when the registry changes.
 */
internal val BUILTIN_INVITE_HOSTS = listOf(
    "velta.cc",
    "i.delta.chat",
    "i.deltachat.id",
    "i.gluek.info",
)

internal var recognizedExtraHosts: Set<String> = emptySet()

private val HOST_RE = Regex(
    "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
)
private val SHORT_PATH = Regex("^/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/?$")
private val HTML_URL = Regex("https://[^\\s\"'<>)]+", RegexOption.IGNORE_CASE)

internal fun inviteHostSet(): Set<String> = BUILTIN_INVITE_HOSTS.toSet() + recognizedExtraHosts

/** invites.js normalizeHost. A hostname with a dot, or null. */
internal fun normalizeInviteHost(raw: String): String? {
    val s = raw.trim().lowercase()
        .replace(Regex("^https?://"), "")
        .substringBefore('/')
        .substringBefore('?')
        .substringBefore('#')
    return s.takeIf { HOST_RE.matches(it) }
}

/** Web stores a JSON array. Empty stores nothing (the key is removed). */
internal fun encodeExtraHosts(hosts: List<String>): String? {
    if (hosts.isEmpty()) return null
    return hosts.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }
}

internal fun decodeExtraHosts(stored: String?): List<String> {
    val s = stored?.trim().orEmpty()
    if (!s.startsWith("[") || !s.endsWith("]")) return emptyList()
    val body = s.removePrefix("[").removeSuffix("]").trim()
    if (body.isEmpty()) return emptyList()
    return body.split(',')
        .map { it.trim().removeSurrounding("\"") }
        .mapNotNull { normalizeInviteHost(it) }
        .distinct()
}

internal data class InviteLabel(val title: String, val sub: String)

/** invites.js inviteLabel. [canonical] is what parseInviteLink returns. */
internal fun inviteLabel(canonical: String): InviteLabel {
    val payload = when {
        canonical.startsWith("https://", ignoreCase = true) ->
            canonical.substringAfter("#", "").substringAfter("&", "")
        else -> canonical.substringAfter("#", "")
    }
    val params = HashMap<String, String>()
    for (part in payload.split('&')) {
        if (part.isEmpty()) continue
        val eq = part.indexOf('=')
        val key = (if (eq < 0) part else part.substring(0, eq)).lowercase()
        val value = if (eq < 0) "" else decodeUriComponent(part.substring(eq + 1).replace("+", "%20"))
        params[key] = value
    }
    val addr = params["a"].orEmpty()
    val actor = params["n"]?.takeIf { it.isNotBlank() }
        ?: addr.substringBefore('@').takeIf { it.isNotBlank() }
        ?: L.t("Someone")
    val channel = params["b"]?.takeIf { it.isNotBlank() }
    val group = params["g"]?.takeIf { it.isNotBlank() }
    val title = when {
        channel != null -> L.t("Subscribe to {group}").replace("{group}", channel)
        group != null -> L.t("{actor} invited you to a {group} group")
            .replace("{actor}", actor)
            .replace("{group}", group)
        else -> L.t("Chat with {name}").replace("{name}", actor)
    }
    val sub = if (addr.isNotBlank() && addr != actor) addr else ""
    return InviteLabel(title, sub)
}

/** deltachat.id/<name>. The page redirects to a real invite; KMP fetches it. */
internal fun isShortInviteLink(raw: String): Boolean {
    val s = raw.trim()
    if (!s.startsWith("https://", ignoreCase = true)) return false
    val rest = s.substring("https://".length)
    val slash = rest.indexOf('/')
    if (slash < 0) return false
    val host = rest.substring(0, slash).substringBefore('?').substringBefore('#').lowercase()
    if (host != "deltachat.id") return false
    val path = "/" + rest.substring(slash + 1).substringBefore('?').substringBefore('#')
    return SHORT_PATH.matches(path)
}

internal fun findShortInviteLinks(text: String): List<String> {
    val stripped = text.replace(Regex("`[^`\\n]+`"), " ")
    val out = mutableListOf<String>()
    for (m in Regex("https://deltachat\\.id/[^\\s<]+", RegexOption.IGNORE_CASE).findAll(stripped)) {
        val u = trimLinkEnd(m.value)
        if (isShortInviteLink(u) && u !in out) out += u
    }
    return out
}

/** HTTPS URLs in a short-link page. `&amp;` is the only entity the web undoes. */
internal fun inviteCandidates(html: String): List<String> =
    HTML_URL.findAll(html).map { it.value.replace("&amp;", "&") }.toList()

internal fun firstInviteIn(candidates: List<String>): String? =
    candidates.firstNotNullOfOrNull { parseInviteLink(it) }
