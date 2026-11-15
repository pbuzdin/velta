package org.velta.kmp.ui

/**
 * velta://proxy links (app/js/proxy.js) and the socks5 URL the core stores
 * (velta-app proxy_store.rs `url_of`). Pure — desktop tests pin it.
 *
 * ponytail: labels are not NFC-normalized. Add java.text.Normalizer if a
 * decomposed label ever fails a round trip.
 */

const val PROXY_LINK_MAX = 2048
const val PROXY_LABEL_MAX = 64
const val PROXY_CRED_MAX = 128

data class ProxyLink(
    val version: Int,
    val host: String,
    val port: Int,
    val user: String,
    val pass: String,
    val label: String,
)

class ProxyLinkError(
    val key: String,
    val name: String? = null,
    val version: String? = null,
    val max: String? = null,
) : IllegalArgumentException(key)

fun proxyErrorLine(translated: String, e: ProxyLinkError): String =
    translated
        .replace("{name}", e.name ?: "")
        .replace("{version}", e.version ?: "")
        .replace("{max}", e.max ?: "")

private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
private val PROXY_PARAMS = setOf("v", "h", "p", "u", "w", "n")
private val V2_RE = Regex(
    "^velta://proxy/2/([^/?#]+)/([0-9]{1,5})((?:/[UWN]/[^/?#]+)*)$",
    RegexOption.IGNORE_CASE,
)

private fun bad(key: String, name: String? = null, version: String? = null, max: String? = null): Nothing =
    throw ProxyLinkError(key, name, version, max)

fun base32Encode(bytes: ByteArray): String {
    val out = StringBuilder()
    var acc = 0
    var n = 0
    for (b in bytes) {
        acc = (acc shl 8) or (b.toInt() and 0xff)
        n += 8
        while (n >= 5) {
            out.append(B32[(acc ushr (n - 5)) and 31])
            n -= 5
        }
        acc = acc and ((1 shl n) - 1)
    }
    if (n > 0) out.append(B32[(acc shl (5 - n)) and 31])
    return out.toString()
}

fun base32Decode(str: String): ByteArray? {
    val s = str.uppercase()
    if (!Regex("^[A-Z2-7]*$").matches(s) || s.length % 8 in listOf(1, 3, 6)) return null
    val out = ArrayList<Byte>()
    var acc = 0
    var n = 0
    for (c in s) {
        val v = B32.indexOf(c)
        if (v < 0) return null
        acc = (acc shl 5) or v
        n += 5
        if (n >= 8) {
            out.add(((acc ushr (n - 8)) and 255).toByte())
            n -= 8
        }
        acc = acc and (if (n == 0) 0 else (1 shl n) - 1)
    }
    return if (acc == 0) out.toByteArray() else null
}

private fun b32ToUtf8(s: String): String {
    val b = base32Decode(s) ?: bad("The link is not encoded correctly")
    val text = b.decodeToString()
    if (text.contains('\uFFFD')) bad("The link is not encoded correctly")
    return text
}

private fun validIPv4(s: String): Boolean {
    val p = s.split('.')
    return p.size == 4 && p.all { Regex("^(?:0|[1-9][0-9]{0,2})$").matches(it) && it.toInt() <= 255 }
}

/** One `::`, hex groups of 1–4. No IPv4-tail form. */
private fun validIPv6(s: String): Boolean {
    if (!Regex("^[0-9a-fA-F:]{2,45}$").matches(s)) return false
    val parts = s.split("::")
    if (parts.size > 2) return false
    fun groups(p: String) = if (p.isEmpty()) emptyList() else p.split(':')
    fun hex(g: String) = g.length in 1..4 && g.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
    val left = groups(parts[0])
    if (parts.size == 1) return left.size == 8 && left.all { hex(it) }
    val right = groups(parts[1])
    if (left.size + right.size > 7) return false
    return (left + right).all { hex(it) }
}

fun normalizeProxyHost(raw: String): String? {
    val h = raw.trim().trimEnd('.')
    if (h.isEmpty() || h.length > 253) return null
    if (validIPv4(h)) return h
    val bare = if (h.startsWith('[') && h.endsWith(']')) h.substring(1, h.length - 1) else h
    if (validIPv6(bare)) return bare.lowercase()
    if (':' in bare) return null
    val lower = bare.lowercase()
    val labels = lower.split('.')
    val numeric = labels.all { it.isNotEmpty() && it.all { c -> c.isDigit() } }
    if (numeric && labels.size >= 4) return null
    val labelOk = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    return if (labels.all { labelOk.matches(it) }) lower else null
}

private fun validPort(p: String) = Regex("^[1-9][0-9]{0,4}$").matches(p) && p.toInt() <= 65535

private fun cleanCreds(u: String, w: String): Pair<String, String> {
    if (u.length > PROXY_CRED_MAX || w.length > PROXY_CRED_MAX) bad("The username or password is too long")
    if (u.isEmpty() && w.isNotEmpty()) bad("A password without a username is not valid")
    return u to w
}

private fun cleanLabel(n: String): String {
    val s = n.trim()
    if (Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]").containsMatchIn(s)) {
        bad("The label has invalid characters")
    }
    if (s.length > PROXY_LABEL_MAX) bad("The label is too long (max {max})", max = PROXY_LABEL_MAX.toString())
    return s
}

private fun queryDecode(raw: String): String {
    val s = raw.replace("+", "%20")
    val bytes = ArrayList<Byte>()
    var i = 0
    while (i < s.length) {
        if (s[i] == '%') {
            if (i + 2 >= s.length) bad("The link is not encoded correctly")
            val v = s.substring(i + 1, i + 3).toIntOrNull(16) ?: bad("The link is not encoded correctly")
            bytes.add(v.toByte())
            i += 3
        } else {
            if (s[i].code > 0x7f) bad("The link is not encoded correctly")
            bytes.add(s[i].code.toByte())
            i++
        }
    }
    val text = bytes.toByteArray().decodeToString()
    if (text.contains('\uFFFD')) bad("The link is not encoded correctly")
    return text
}

private fun parseV2(hostRaw: String, portRaw: String, restRaw: String): ProxyLink {
    val host = normalizeProxyHost(hostRaw) ?: bad("The proxy server address is not valid")
    if (!validPort(portRaw)) bad("The port is not valid")
    val seen = HashMap<String, String>()
    val rest = if (restRaw.isEmpty()) emptyList() else restRaw.removePrefix("/").split('/')
    var i = 0
    while (i < rest.size) {
        val k = rest[i].uppercase()
        if (i + 1 >= rest.size) bad("The link is not valid")
        if (seen.containsKey(k)) bad("Repeated parameter: {name}", name = k)
        seen[k] = rest[i + 1]
        i += 2
    }
    val (user, pass) = cleanCreds(
        if (seen.containsKey("U")) b32ToUtf8(seen.getValue("U")) else "",
        if (seen.containsKey("W")) b32ToUtf8(seen.getValue("W")) else "",
    )
    val label = if (seen.containsKey("N")) cleanLabel(b32ToUtf8(seen.getValue("N"))) else ""
    return ProxyLink(2, host, portRaw.toInt(), user, pass, label)
}

fun parseProxyLink(raw: String?): ProxyLink {
    val s = raw?.trim() ?: ""
    if (s.isEmpty()) bad("Empty link")
    if (s.length > PROXY_LINK_MAX) bad("The link is too long")
    val m2 = V2_RE.matchEntire(s)
    if (m2 != null) return parseV2(m2.groupValues[1], m2.groupValues[2], m2.groupValues[3])
    val fut = Regex("^velta://proxy/([0-9]+)/", RegexOption.IGNORE_CASE).find(s)
    if (fut != null && fut.groupValues[1] != "2") {
        bad("Unsupported link version {version}: update Velta", version = fut.groupValues[1].take(10))
    }
    if (fut != null) bad("The link is not valid")
    val m = Regex("^velta://proxy/?(?:\\?([^#]*))?$", RegexOption.IGNORE_CASE).matchEntire(s)
        ?: bad("Not a velta://proxy link")
    val seen = HashMap<String, String>()
    for (part in (m.groupValues[1]).split('&')) {
        if (part.isEmpty()) continue
        val eq = part.indexOf('=')
        val k = if (eq < 0) part else part.substring(0, eq)
        val v = queryDecode(if (eq < 0) "" else part.substring(eq + 1))
        if (k !in PROXY_PARAMS) bad("Unknown parameter: {name}", name = k.take(20))
        if (seen.containsKey(k)) bad("Repeated parameter: {name}", name = k)
        seen[k] = v
    }
    val version = seen["v"] ?: "1"
    if (version != "1") bad("Unsupported link version {version}: update Velta", version = version.take(10))
    val host = normalizeProxyHost(seen["h"] ?: "") ?: bad("The proxy server address is not valid")
    val portRaw = (seen["p"] ?: "").trim()
    if (!validPort(portRaw)) bad("The port is not valid")
    val (user, pass) = cleanCreds(seen["u"] ?: "", seen["w"] ?: "")
    val label = if (seen.containsKey("n")) cleanLabel(seen.getValue("n")) else ""
    return ProxyLink(1, host, portRaw.toInt(), user, pass, label)
}

/** Canonical v2 link (QR / share). */
fun buildProxyLink(host: String, port: Int, user: String = "", pass: String = "", label: String = ""): String {
    val h = normalizeProxyHost(host) ?: bad("The proxy server address is not valid")
    fun b32(s: String) = base32Encode(s.encodeToByteArray())
    var out = "velta://proxy/2/${h.uppercase()}/$port"
    if (user.isNotEmpty()) out += "/U/${b32(user)}"
    if (pass.isNotEmpty()) out += "/W/${b32(pass)}"
    if (label.isNotEmpty()) out += "/N/${b32(label)}"
    return out
}

private fun pct(s: String): String = buildString {
    for (b in s.encodeToByteArray()) {
        val c = b.toInt() and 0xff
        val plain = c in '0'.code..'9'.code || c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code ||
            c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code
        if (plain) append(c.toChar()) else append("%${c.toString(16).uppercase().padStart(2, '0')}")
    }
}

/** proxy_store.rs `url_of`: socks5://[user[:pass]@]host:port */
fun socksUrl(link: ProxyLink): String {
    val host = if (':' in link.host) "[${link.host}]" else link.host
    val auth = if (link.user.isEmpty()) "" else "${pct(link.user)}:${pct(link.pass)}@"
    return "socks5://$auth$host:${link.port}"
}

/** Host:port shown when we only have the stored proxy_url. */
fun proxyHostOf(url: String): String =
    url.removePrefix("socks5://").substringAfterLast('@')
