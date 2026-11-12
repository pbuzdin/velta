package org.velta.kmp.ui

/**
 * Port of app/js/bare-links.js (#85): find web addresses typed WITHOUT a
 * scheme ("t.me/x/1", "github.com/u/r", "example.com:8080/a?b=c#d") so they
 * render like https links. Deliberately conservative — a bare "word.word" is
 * ambiguous against file names, code, versions and abbreviations, so a
 * candidate links only when every rule in the JS file holds (boundaries,
 * lowercase known TLD, tier requirement, valid host labels). The resulting
 * url is always "https://" + the typed text.
 */

private val TIER1 = setOf(
    "com", "org", "net", "edu", "gov", "mil", "int", "io",
    "ru", "su", "ua", "by", "kz", "uz", "ge", "de", "uk", "fr", "nl", "es", "pt", "se", "fi", "dk", "cz", "hu",
    "ro", "bg", "gr", "tr", "cn", "jp", "kr", "au", "nz", "ca", "br", "eu", "ch", "lv", "lt", "ee", "xn--p1ai", "рф",
)

private val TIER2 = setOf(
    "info", "biz", "co", "me", "tv", "fm", "gg", "ly", "ai", "xyz", "dev", "app", "online", "site", "tech",
    "store", "shop", "blog", "cloud", "wiki", "space", "pro", "mobi",
)

private val TIER3 = setOf(
    "ac", "ad", "ae", "af", "ag", "al", "am", "ao", "aq", "ar", "as", "at", "aw", "ax", "az", "ba", "bb", "bd",
    "be", "bf", "bh", "bi", "bj", "bm", "bn", "bo", "bs", "bt", "bw", "bz", "cc", "cd", "cf", "cg", "ci", "ck",
    "cl", "cm", "cr", "cu", "cv", "cw", "cx", "cy", "dj", "dm", "do", "dz", "ec", "eg", "er", "et", "fj", "fk",
    "fo", "ga", "gd", "gf", "gh", "gi", "gl", "gm", "gn", "gp", "gq", "gs", "gt", "gu", "gw", "gy", "hk", "hm",
    "hn", "hr", "ht", "id", "ie", "il", "im", "in", "iq", "ir", "is", "it", "je", "jm", "jo", "ke", "kg", "kh",
    "ki", "km", "kn", "kp", "kw", "ky", "la", "lb", "lc", "li", "lk", "lr", "ls", "lu", "ma", "mc", "md", "mg",
    "mh", "mk", "ml", "mm", "mn", "mo", "mp", "mq", "mr", "ms", "mt", "mu", "mv", "mw", "mx", "my", "mz", "na",
    "nc", "ne", "nf", "ng", "ni", "no", "np", "nr", "nu", "om", "pa", "pe", "pf", "pg", "ph", "pk", "pl", "pm",
    "pn", "pr", "ps", "pw", "py", "qa", "re", "rs", "rw", "sa", "sb", "sc", "sd", "sg", "sh", "si", "sk", "sl",
    "sm", "sn", "so", "sr", "ss", "st", "sv", "sx", "sy", "sz", "tc", "td", "tf", "tg", "th", "tj", "tk", "tl",
    "tm", "tn", "to", "tt", "tw", "tz", "ug", "us", "uy", "va", "vc", "ve", "vg", "vi", "vn", "vu", "wf", "ws",
    "ye", "yt", "za", "zm", "zw",
)

private val RUN = Regex("[\\p{L}\\p{N}\\p{M}_-]+")
private val HOST = Regex("[\\p{L}\\p{N}][\\p{L}\\p{N}-]*(?:\\.[\\p{L}\\p{N}][\\p{L}\\p{N}-]*)+")
private val BAD_BEFORE = Regex("[\\p{L}\\p{N}\\p{M}_@./:%+~#=&?\\\\$-]")
private val BAD_AFTER = Regex("[\\p{L}\\p{N}\\p{M}_@-]")
private val TRAIL_PUNCT = ".,;:!?'\"*>»”’…"
private val PORT_OK = Regex("^:\\d{1,5}(?![\\p{L}\\p{N}_])")
private val TLD_OK = Regex("^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59}|рф)$")

/** Openers minus closers still inside; trailing punctuation and unmatched
 * closers are trimmed off the link end. */
internal fun trimLinkEnd(s: String): String {
    val bal = mutableMapOf("(" to 0, "[" to 0, "{" to 0)
    val closers = mapOf(")" to "(", "]" to "[", "}" to "{")
    for (ch in s) {
        val c = ch.toString()
        if (bal.containsKey(c)) bal[c] = bal[c]!! + 1
        else if (c == ")") bal["("] = bal["("]!! - 1
        else if (c == "]") bal["["] = bal["["]!! - 1
        else if (c == "}") bal["{"] = bal["{"]!! - 1
    }
    var end = s.length
    while (end > 0) {
        val c = s[end - 1]
        if (c in TRAIL_PUNCT) { end--; continue }
        val open = closers[c.toString()]
        if (open != null && bal[open]!! < 0) { bal[open] = bal[open]!! + 1; end--; continue }
        break
    }
    return s.substring(0, end)
}

private fun validHost(host: String): Boolean {
    if (host.length > 253) return false
    return host.split(".").all { it.length in 1..63 && !it.startsWith("-") && !it.endsWith("-") }
}

private fun accepts(host: String, rest: String): Boolean {
    if (!validHost(host)) return false
    val labels = host.split(".")
    val tld = labels.last()
    if (!TLD_OK.matches(tld)) return false
    val hasPort = rest.startsWith(":")
    val afterPort = if (hasPort) rest.replace(Regex("^:\\d{1,5}"), "") else rest
    val hasSlash = afterPort.startsWith("/")
    val hasTail = hasSlash || Regex("^[?#]").containsMatchIn(afterPort)
    if (tld in TIER1) return true
    // "www." is an explicit web marker: any known suffix is fine on its own.
    if (labels[0].lowercase() == "www" && labels.size >= 3 && (tld in TIER2 || tld in TIER3)) return true
    if (tld in TIER2) return hasPort || hasTail
    if (tld in TIER3) return hasSlash && !hasPort
    return false
}

data class BareLink(val start: Int, val end: Int, val text: String, val url: String)

/** Scan one plain-text segment; returns non-overlapping links in order. */
internal fun findBareLinks(seg: String): List<BareLink> {
    val out = mutableListOf<BareLink>()
    var skipTo = 0
    for (run in RUN.findAll(seg)) {
        val i = run.range.first
        if (i < skipTo) continue
        if (!Regex("^[\\p{L}\\p{N}]").containsMatchIn(run.value)) continue
        val host = HOST.find(seg, i)?.value ?: continue
        if (HOST.find(seg, i)!!.range.first != i) continue
        val hostEnd = i + host.length
        skipTo = hostEnd
        if (i > 0 && BAD_BEFORE.containsMatchIn(seg[i - 1].toString())) continue
        if (hostEnd < seg.length && BAD_AFTER.containsMatchIn(seg[hostEnd].toString())) continue
        var p = hostEnd
        val port = PORT_OK.find(seg.substring(p, minOf(p + 8, seg.length)))
        if (port != null) {
            p += port.value.length
        } else if (p < seg.length && seg[p] == ':' && p + 1 < seg.length && !seg[p + 1].isWhitespace()) {
            continue // "foo.com:bar"
        }
        var end = p
        if (p < seg.length && seg[p] in "/?#") {
            while (end < seg.length && !seg[end].isWhitespace() && seg[end] != '<') end++
        } else if (p < seg.length && Regex("[\\p{L}\\p{N}\\p{M}_@-]").containsMatchIn(seg[p].toString())) {
            continue // "foo.com" glued to more word characters
        }
        val cand = trimLinkEnd(seg.substring(i, end))
        if (cand.length < host.length || cand.contains('\\')) continue
        val rest = cand.substring(host.length)
        if (!accepts(host, rest)) continue
        out.add(BareLink(i, i + cand.length, cand, "https://" + cand))
        skipTo = i + cand.length
    }
    return out
}
