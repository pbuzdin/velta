package org.velta.kmp.ui

/**
 * Port of app/js/mentions.js: @mentions resolved against the chat's member
 * list. Two forms: "@Display Name (A1B2)" (rename-proof, 4-hex fingerprint
 * code) and plain "@Name". "@" must start a word — not glued to a
 * letter/digit or an e-mail/handle character.
 */
data class MentionMember(val id: Long, val name: String, val code: String)

data class MentionRange(
    val start: Int,
    val end: Int,
    val member: MentionMember,
    val code: String,
    val me: Boolean,
    val text: String = "",
)

private val MENTION_BAD_BEFORE = Regex("[\\p{L}\\p{M}\\p{N}_.@+\\-%&/:#]")
private val MENTION_CODED = Regex("^@([^\\n@()]{1,64}?) \\(([0-9A-Fa-f]{4})\\)")
private val MENTION_CODE_AFTER = Regex("^ \\(([0-9A-Fa-f]{4})\\)")
private const val MENTION_MAX_NAME = 64

private fun fold(s: String) = s.lowercase()
private fun wordBoundaryAt(s: String, i: Int) = i >= s.length || !Regex("[\\p{L}\\p{M}\\p{N}_]").containsMatchIn(s[i].toString())

private fun nameMatches(seg: String, at: Int, members: List<MentionMember>): Pair<Int, List<MentionMember>> {
    val lower = fold(seg)
    var best = 0
    val hits = mutableListOf<MentionMember>()
    for (m in members) {
        val n = fold(m.name.trim())
        if (n.isEmpty() || n.length > MENTION_MAX_NAME || n.length < best) continue
        if (lower.startsWith(n, at) && wordBoundaryAt(seg, at + n.length)) {
            if (n.length > best) { best = n.length; hits.clear(); hits.add(m) } else hits.add(m)
        }
    }
    return best to hits
}

private fun resolveAt(seg: String, i: Int, members: List<MentionMember>): MentionRange? {
    val rest = seg.substring(i)
    val coded = MENTION_CODED.find(rest)
    if (coded != null) {
        val code = coded.groupValues[2].uppercase()
        val typed = fold(coded.groupValues[1].trim())
        val end = i + coded.value.length
        if (wordBoundaryAt(seg, end) || Regex("[\\s.,!?;:)\\]]").containsMatchIn(seg.getOrNull(end)?.toString() ?: "")) {
            val byCode = members.filter { it.code == code }
            var member = if (byCode.size == 1) byCode[0] else null
            if (member == null && byCode.size > 1) member = byCode.find { fold(it.name.trim()) == typed }
            if (member == null) member = members.find { fold(it.name.trim()) == typed && (it.code.isEmpty() || byCode.size > 1) }
            if (member != null) return MentionRange(i, end, member, code, member.id == 1L)
        }
    }
    val (len, hits) = nameMatches(seg, i + 1, members)
    if (len == 0) return null
    var end = i + 1 + len
    val c = MENTION_CODE_AFTER.find(seg.substring(end))
    var member = hits.first()
    if (c != null) {
        val code = c.groupValues[1].uppercase()
        val own = hits.find { it.code == code }
        if (own != null) { member = own; end += c.value.length; return MentionRange(i, end, member, code, member.id == 1L) }
        if (hits.all { it.code.isNotEmpty() }) return null // names a different person
    }
    return MentionRange(i, end, member, "", member.id == 1L)
}

/** First 4 hex of a real fingerprint (40+ hex). Derived-only keys stay blank. */
internal fun fprCode(fpr: String?): String {
    val hex = fpr.orEmpty().filter { it.isDigit() || it in 'A'..'F' || it in 'a'..'f' }.uppercase()
    return if (hex.length >= 40) hex.take(4) else ""
}

/** What the picker inserts, trailing space included (mentions.js mentionToken). */
internal fun mentionToken(member: MentionMember): String {
    val name = member.name.trim()
    return if (member.code.isNotEmpty()) "@$name (${member.code}) " else "@$name "
}

/** The "@query" being typed at the caret, or null (mentions.js mentionQuery). */
internal data class MentionQuery(val start: Int, val query: String)

internal fun mentionQuery(value: String, caret: Int = value.length): MentionQuery? {
    val end = caret.coerceIn(0, value.length)
    val v = value.substring(0, end)
    val at = v.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && !Regex("[\\s(\\[{\"'«]").containsMatchIn(v[at - 1].toString())) return null
    val q = v.substring(at + 1)
    if (q.length > 40 || Regex("\\n|^\\s|\\s{2}|@|\\(").containsMatchIn(q)) return null
    return MentionQuery(at, q)
}

/** Bare "@" lists everyone only in small groups (mentions.js BARE_AT_MAX). */
internal const val BARE_AT_MAX = 10

/** Others, prefix before word-prefix before substring (mentions.js filterMembers). */
internal fun filterMembers(members: List<MentionMember>, query: String, limit: Int = 8): List<MentionMember> {
    val q = query.lowercase()
    return members.mapNotNull { m ->
        if (m.id == 1L || m.name.isBlank()) return@mapNotNull null
        val n = m.name.lowercase()
        val rank = when {
            q.isEmpty() -> 1
            n.startsWith(q) -> 0
            n.split(Regex("\\s+")).any { it.startsWith(q) } -> 1
            q in n -> 2
            else -> return@mapNotNull null
        }
        rank to m
    }.sortedWith(compareBy({ it.first }, { it.second.name.lowercase() })).take(limit).map { it.second }
}

/**
 * Does [text] mention me? Code match is rename-proof. [mentionInMuted] is the
 * settings switch (default on): a muted chat still notifies.
 */
internal fun mentionsMe(text: String, name: String, code: String): Boolean {
    if (name.isBlank() && code.isBlank()) return false
    if (code.isNotBlank()) {
        val re = Regex("(^|[^\\p{L}\\p{M}\\p{N}_.@+%&/:#-])@[^\\n@()]{1,64}? \\(([0-9A-Fa-f]{4})\\)")
        if (re.findAll(text).any { it.groupValues[2].equals(code, ignoreCase = true) }) return true
    }
    if (name.isBlank()) return false
    return findMentions(text, listOf(MentionMember(1L, name, code))).any { it.me }
}

internal fun mutedChatAllows(muted: Boolean, mentioned: Boolean, mentionInMuted: Boolean = true): Boolean {
    if (!muted) return true
    return mentionInMuted && mentioned
}

/** Scan one plain-text segment for @mentions of [members]. */
internal fun findMentions(seg: String, members: List<MentionMember>): List<MentionRange> {
    val out = mutableListOf<MentionRange>()
    val list = members.filter { it.name.isNotBlank() }
    if (list.isEmpty() || !seg.contains("@")) return out
    var i = seg.indexOf("@")
    while (i != -1) {
        if (i > 0 && MENTION_BAD_BEFORE.containsMatchIn(seg[i - 1].toString())) { i = seg.indexOf("@", i + 1); continue }
        val r = resolveAt(seg, i, list)
        if (r != null) {
            out.add(r.copy(start = i, end = r.end, text = seg.substring(i, r.end)))
            i = r.end - 1
        }
        i = seg.indexOf("@", i + 1)
    }
    return out
}
