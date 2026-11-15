package org.velta.kmp.ui

import org.velta.kmp.core.ChatListItem

/**
 * Share-in (#334 step 7) — a pure port of stable app/js/share-in.js
 * (shareTextIfUnconsumed, shareViewtype, shareTargets, sharePlan,
 * shareStageKind, buildCategoryChips' picker buckets) plus the
 * routeOpenedBatch split between deep links and text shares.
 * No Compose here: ShareInRulesTest pins every rule.
 */

/** One shared thing: text, or a file the platform staged readable ([file]
 *  = path, [name] = display name). */
data class ShareItem(val text: String? = null, val file: String? = null, val name: String? = null)

/** How a shared EXTRA_TEXT is routed (stable routeOpenedBatch). */
sealed interface SharedText {
    /** A link the deep-link router owns (invite / chatmail code): open it. */
    data class Link(val link: String) : SharedText
    data class Text(val text: String) : SharedText
    /** An app-scheme link nothing consumed (stale velta:, data:, …): dropped. */
    data object Drop : SharedText
}

private val ROUTER_SCHEMES = Regex("^(dcaccount|dclogin|dcbackup|openpgp4fpr):", RegexOption.IGNORE_CASE)
private val APP_SCHEMES = Regex("^(velta|dcaccount|dclogin|dcbackup|openpgp4fpr|data|content|file):", RegexOption.IGNORE_CASE)
private val ANY_SCHEME = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)

/** tao hands a shared text that parses as one URL over as that URL; the
 *  deep-link router gets first go (invite hosts, chatmail schemes), and
 *  only what it did not consume is shared as text (shareTextIfUnconsumed).
 *  Anything else is plain text. */
fun classifySharedText(raw: String): SharedText? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    val oneToken = s.none { it.isWhitespace() } && ANY_SCHEME.containsMatchIn(s)
    if (!oneToken) return SharedText.Text(raw)
    if (parseInviteLink(s) != null || ROUTER_SCHEMES.containsMatchIn(s)) return SharedText.Link(s)
    if (s.startsWith("http://", true) || s.startsWith("https://", true)) return SharedText.Text(s)
    if (APP_SCHEMES.containsMatchIn(s)) return SharedText.Drop
    return SharedText.Text(runCatching { decodeUriComponent(s) }.getOrDefault(s))
}

/** share-in.js shareViewtype (stable's lowercase kinds). */
fun shareViewtype(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg" -> "image"
    "mp4", "mov", "mkv", "avi", "webm" -> "video"
    "mp3", "m4a", "ogg", "opus", "wav", "flac" -> "audio"
    else -> "file"
}

/** rpc-core _toCoreViewtype for the share kinds. */
fun coreViewtype(kind: String): String = when (kind) {
    "image" -> "Image"
    "video" -> "Video"
    "audio" -> "Audio"
    else -> "File"
}

/** The picker's category chips (components.js buildCategoryChips). */
val SHARE_CATEGORIES = listOf("all", "people", "groups", "channels", "bots", "saved")

/** share-in.js shareTargets: no device chat, no contact request; [cat]
 *  narrows by bucket ("saved" = Saved Messages); [query] by name. */
fun shareTargets(chats: List<ChatListItem>, query: String = "", cat: String = "all", isBot: (Long) -> Boolean = { false }): List<ChatListItem> {
    val q = query.trim().lowercase()
    return chats.filter { c ->
        c.kind == "ChatListItem" && !c.isDeviceTalk && !c.isContactRequest &&
            (cat == "all" || (if (cat == "saved") c.isSelfTalk else chatCategoryOf(c, isBot) == cat)) &&
            (q.isEmpty() || c.name.lowercase().contains(q))
    }
}

/** One burst → the caption text and the distinct files, in order. */
data class SharePlan(val text: String, val files: List<ShareItem>)

fun sharePlan(items: List<ShareItem>): SharePlan {
    val list = items.filter { it.text != null || it.file != null }
    val text = list.mapNotNull { it.text?.takeIf { t -> t.isNotEmpty() } }.joinToString("\n\n")
    val files = list.filter { it.file != null }.distinctBy { it.file }
    return SharePlan(text, files)
}

private val STAGE_IMAGE = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp")

/** share-in.js shareStageKind: "text" (composer), "image"/"video" (one
 *  photo/video staged with the text as caption) or "send" (documents and
 *  several files go out right away). Decided on the file NAMES. */
fun shareStageKind(names: List<String>): String {
    if (names.isEmpty()) return "text"
    if (names.size > 1) return "send"
    val base = names[0].replace('\\', '/').substringAfterLast('/')
    val dot = base.lastIndexOf('.')
    val ext = if (dot > 0) base.substring(dot + 1).lowercase() else ""
    if (ext in STAGE_IMAGE) return "image"
    if (dot > 0 && shareViewtype(base) == "video") return "video"
    return "send"
}

/** Staged text joins what the composer already holds on a new line. */
fun composerWithShare(current: String, text: String): String =
    if (text.isEmpty()) current else if (current.isNotBlank()) "$current\n$text" else text
