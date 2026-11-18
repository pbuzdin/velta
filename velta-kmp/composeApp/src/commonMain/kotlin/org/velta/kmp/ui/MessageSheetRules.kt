package org.velta.kmp.ui

import org.velta.kmp.core.MessageObject

/**
 * Phone message sheet rules (#334 step 5) — a pure port of stable's
 * chat-view.js `_msgContextMenu` (item visibility + order), ui.js
 * `messageSheetRows` / `deleteConfirmChoices` / `buildReactionRow`,
 * reactions.js `myReaction` / `reactionToggle`, msg-edit.js `canEditMsg`,
 * admin-group.js `adminCaps`, chat-view `_canDeleteForAll` and
 * trackers.js `stripTrackingUrl`. No Compose here: MessageSheetRulesTest
 * pins every rule.
 */

/** Stable's 11 phone-sheet quick reactions (chat-view.js SHEET_REACTIONS). */
val SHEET_REACTIONS = listOf("👍", "👎", "❤️", "😂", "🎉", "😮", "🔥", "👀", "🙏", "😢", "💯")

/** Sheet buckets, in display order (chat-view.js SHEET_PAIRS). */
val SHEET_PAIRS = listOf("send", "keep", "file", "own", "text", "meta")

/** Delete-undo window (chat-view.js deleteUndoMs). */
const val DELETE_UNDO_MS = 10_000L

/** Long-press delay (chat-view.js touchstart pressTimer). */
const val LONG_PRESS_MS = 500L

/** One sheet entry. [label] is stable's English label (the L.t key);
 *  [short] the tile caption when stable gives one; [pair] the bucket. */
enum class SheetAction(val label: String, val short: String?, val pair: String?, val danger: Boolean = false) {
    CopyLink("Copy link", null, "text"),
    ShareLink("Share link", null, "text"),
    OpenLink("Open link", null, "text"),
    Reply("Reply", null, "send"),
    ShowReplies("Show replies", null, null),
    Edit("Edit", null, "own"),
    SaveSticker("Save sticker", "Sticker", "file"),
    Download("Download", "Download", "file"),
    Pin("Pin", null, "keep"),
    Unpin("Unpin", null, "keep"),
    CopyText("Copy text", "Copy", "text"),
    SelectText("Select text", null, "text"),
    Forward("Forward", null, "send"),
    Resend("Resend", null, "own"),
    SaveToSaved("Save to Saved Messages", "Save", "keep"),
    Select("Select", null, "meta"),
    Info("Info", null, "meta"),
    Delete("Delete", null, null, danger = true),
    ;

    /** The tile caption key (stable `t(it.short || it.label)`). */
    val caption: String get() = short ?: label
}

/** Stable's lowercase viewtype (rpc-core.js _mapViewtype). */
fun stableViewtype(coreViewType: String): String = when (coreViewType) {
    "Image", "Gif" -> "image"
    "Sticker" -> "sticker"
    "Voice" -> "voice"
    "Audio" -> "audio"
    "Video" -> "video"
    "File" -> "file"
    "Vcard" -> "vcard"
    "Webxdc" -> "webxdc"
    "Call" -> "call"
    else -> "text"
}

/** Chat-level inputs of the sheet (stable `this.chat` + `this.readOnly`). */
data class SheetChat(
    /** No composer: canSend false (stable readOnly). */
    val readOnly: Boolean = false,
    /** FullChat.groupAdminId (Velta admin groups); null for regular chats. */
    val groupAdminId: Long? = null,
    val isGroup: Boolean = false,
    /** Saved Messages (self talk). */
    val isSaved: Boolean = false,
    val isEncrypted: Boolean = true,
)

/** admin-group.js adminCaps: who may pin / delete-for-all. */
fun isAdminGroup(chat: SheetChat): Boolean = chat.isGroup && (chat.groupAdminId ?: 0L) > 0L
fun selfIsAdmin(chat: SheetChat): Boolean = isAdminGroup(chat) && chat.groupAdminId == 1L
fun canPin(chat: SheetChat): Boolean = !isAdminGroup(chat) || selfIsAdmin(chat)
fun canDeleteForAllFrom(chat: SheetChat, fromId: Long): Boolean =
    fromId == 1L || (isAdminGroup(chat) && selfIsAdmin(chat))

/** chat-view `_canDeleteForAll`: every message loaded, not Saved Messages,
 *  an encrypted chat, and each message own (or this account is the admin). */
fun canDeleteForAll(chat: SheetChat, messages: List<MessageObject?>): Boolean =
    messages.isNotEmpty() && messages.all { it != null } &&
        !chat.isSaved && chat.isEncrypted &&
        messages.all { canDeleteForAllFrom(chat, it!!.fromId) }

/** msg-edit.js EDITABLE_VIEWTYPES (stable names). */
val EDITABLE_VIEWTYPES = setOf("text", "image", "video", "audio", "voice", "file", "vcard")

/** msg-edit.js canEditMsg: own, not info, not HTML, editable type, non-empty text. */
fun canEditMsg(m: MessageObject): Boolean {
    if (m.fromId != 1L || m.isInfo || m.hasHtml) return false
    if (stableViewtype(m.viewType) !in EDITABLE_VIEWTYPES) return false
    return m.text.isNotBlank()
}

/** Everything `_msgContextMenu` reads besides the message itself. */
data class SheetContext(
    val chat: SheetChat = SheetChat(),
    /** The long-press landed on this link (raw href; "" = none). */
    val linkHref: String = "",
    /** Platform can hand a link to the share sheet (stable canShareLink). */
    val canShareLink: Boolean = true,
    /** Replies counted for this message (stable _replyCountFor). */
    val replyCount: Int = 0,
    /** Touch UI (stable _offerSelectText): KMP is phone-first, always true. */
    val touch: Boolean = true,
    /** Text-only mode hides the attachment: no Download / Save sticker
     *  (stable passes `covered` to messageSheetActions). */
    val covered: Boolean = false,
)

/**
 * Stable `_msgContextMenu` item list, in push order (before bucketing).
 * Held (undo-pending) deletes get [deletedMessageActions] instead.
 */
fun messageSheetActions(m: MessageObject, ctx: SheetContext): List<SheetAction> {
    if (m.isInfo) return emptyList()
    val vt = stableViewtype(m.viewType)
    val own = m.fromId == 1L
    val items = mutableListOf<SheetAction>()
    if (isHttpLink(ctx.linkHref)) {
        items += SheetAction.CopyLink
        if (ctx.touch && ctx.canShareLink) items += SheetAction.ShareLink
        items += SheetAction.OpenLink
    }
    if (!ctx.chat.readOnly) items += SheetAction.Reply
    if (ctx.replyCount > 0) items += SheetAction.ShowReplies
    if (canEditMsg(m)) items += SheetAction.Edit
    if (!ctx.covered && vt == "sticker" && !own && !m.file.isNullOrEmpty()) items += SheetAction.SaveSticker
    val ds = m.downloadState ?: "Done"
    if (!ctx.covered && (vt == "image" || vt == "video" || vt == "file") && (!m.file.isNullOrEmpty() || ds != "Done")) {
        items += SheetAction.Download
    }
    if (!ctx.chat.readOnly && canPin(ctx.chat)) items += if (m.isPinned) SheetAction.Unpin else SheetAction.Pin
    if (vt == "text" && m.text.isNotEmpty()) items += SheetAction.CopyText
    if (m.text.isNotEmpty() && ctx.touch) items += SheetAction.SelectText
    items += SheetAction.Forward
    if (own) items += SheetAction.Resend
    items += SheetAction.SaveToSaved
    items += SheetAction.Select
    items += SheetAction.Info
    items += SheetAction.Delete
    return items
}

/** chat-view.js deletedMessageActions: an undo-held message offers only these. */
fun deletedMessageActions(): List<SheetAction> = listOf(SheetAction.Select, SheetAction.Info, SheetAction.Delete)

/** Sheet order: SHEET_PAIRS buckets, then the pair-less tail (Show replies,
 *  Delete) in push order — chat-view.js `[...SHEET_PAIRS.flatMap, ...tail]`. */
fun sheetOrder(items: List<SheetAction>): List<SheetAction> {
    val buckets = SHEET_PAIRS.associateWith { mutableListOf<SheetAction>() }
    val tail = mutableListOf<SheetAction>()
    for (a in items) {
        val b = a.pair?.let { buckets[it] }
        if (b != null) b += a else tail += a
    }
    return SHEET_PAIRS.flatMap { buckets.getValue(it) } + tail
}

/** ui.js messageSheetRows: tiles (grid) and full-width danger rows. */
fun messageSheetRows(items: List<SheetAction>): Pair<List<SheetAction>, List<SheetAction>> =
    items.partition { !it.danger }

/** ui.js deleteConfirmChoices: Cancel / Delete for me / (Delete for everyone). */
enum class DeleteChoice(val label: String) { Cancel("Cancel"), ForMe("Delete for me"), ForEveryone("Delete for everyone") }

fun deleteConfirmChoices(canForAll: Boolean): List<DeleteChoice> =
    if (canForAll) listOf(DeleteChoice.Cancel, DeleteChoice.ForMe, DeleteChoice.ForEveryone)
    else listOf(DeleteChoice.Cancel, DeleteChoice.ForMe)

/** ui.js buildReactionRow: our own reaction, when not a quick one, takes the
 *  first slot and the last quick one drops (the row stays 11 + smiley). */
fun shownReactions(reactions: List<String>, selected: String?): List<String> =
    if (selected != null && selected !in reactions) listOf(selected) + reactions.dropLast(1) else reactions

/** One reaction chip under a bubble (stable _mapReactions). */
data class ReactionChip(val emoji: String, val count: Int, val mine: Boolean)

/** Core `Reactions` (camelCase): `reactions` = [{emoji, count, isFromSelf}]. */
fun reactionChips(reactions: kotlinx.serialization.json.JsonElement?): List<ReactionChip> {
    val list = (reactions as? kotlinx.serialization.json.JsonObject)?.get("reactions")
        as? kotlinx.serialization.json.JsonArray ?: return emptyList()
    return list.mapNotNull { el ->
        val o = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
        val emoji = (o["emoji"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return@mapNotNull null
        val count = (o["count"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
        val mine = (o["isFromSelf"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
        if (count <= 0) null else ReactionChip(emoji, count, mine)
    }
}

/** reactions.js myReaction. */
fun myReaction(chips: List<ReactionChip>): String? = chips.firstOrNull { it.mine }?.emoji

/** reactions.js reactionToggle: what to send (`[]` removes ours) and the
 *  optimistic chips. Same emoji removes ours, another replaces it. */
data class ReactionPlan(val send: List<String>, val removing: Boolean, val chips: List<ReactionChip>)

fun reactionToggle(chips: List<ReactionChip>, emoji: String): ReactionPlan {
    var next = chips.map { it.copy() }
    val mine = next.firstOrNull { it.mine }
    val removing = mine != null && mine.emoji == emoji
    if (mine != null) {
        next = next.map { if (it === mine) it.copy(mine = false, count = it.count - 1) else it }.filter { it.count > 0 }
    }
    if (!removing) {
        val hit = next.firstOrNull { it.emoji == emoji }
        next = if (hit != null) next.map { if (it === hit) it.copy(count = it.count + 1, mine = true) else it }
        else next + ReactionChip(emoji, 1, true)
    }
    return ReactionPlan(if (removing) emptyList() else listOf(emoji), removing, next)
}

fun isHttpLink(href: String): Boolean =
    href.startsWith("http://", ignoreCase = true) || href.startsWith("https://", ignoreCase = true)

// ---- trackers.js (#89): strip known tracking params from http(s) links ----

private val CLICK_IDS = setOf(
    "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid",
    "gad_source", "gad_campaignid", "srsltid",
    "msclkid", "mc_cid", "mc_eid",
    "igshid", "igsh", "ttclid", "twclid", "yclid",
    "_hsenc", "_hsmi", "mkt_tok",
    "vero_id", "vero_conv", "li_fat_id",
)

private fun hostIs(host: String, root: String) = host == root || host.endsWith(".$root")

private fun extraNames(host: String): List<String> = when {
    host == "youtu.be" || hostIs(host, "youtube.com") || hostIs(host, "youtube-nocookie.com") -> listOf("si")
    hostIs(host, "spotify.com") -> listOf("si")
    hostIs(host, "x.com") || hostIs(host, "twitter.com") -> listOf("s", "t", "ref_src", "ref_url")
    host == "amzn.to" || hostIs(host, "amazon.com") || host.startsWith("amazon.") -> listOf("tag", "linkcode", "linkid", "ascsubtag")
    else -> emptyList()
}

private fun isTracker(name: String, host: String): Boolean {
    val n = name.lowercase()
    if (n.startsWith("utm_") || n.startsWith("hsa_")) return true
    if (n in CLICK_IDS) return true
    return n in extraNames(host)
}

private val INVITE_HASH = Regex("^[0-9a-fA-F]{40}(?:[&#]|$)")

private fun decodeComponent(s: String): String {
    if ('%' !in s && '+' !in s) return s
    val out = StringBuilder()
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '+') { out.append(' '); i++; continue }
        if (c == '%' && i + 2 < s.length) {
            val hex = s.substring(i + 1, i + 3).toIntOrNull(16)
            if (hex != null) { out.append(hex.toChar()); i += 3; continue }
        }
        out.append(c); i++
    }
    return out.toString()
}

/** trackers.js stripTrackingUrl: the original string when nothing was removed. */
fun stripTrackingUrl(raw: String): String {
    if (!isHttpLink(raw)) return raw
    val hashAt = raw.indexOf('#')
    val beforeHash = if (hashAt >= 0) raw.substring(0, hashAt) else raw
    val hash = if (hashAt >= 0) raw.substring(hashAt) else ""
    if (INVITE_HASH.containsMatchIn(hash.removePrefix("#").removePrefix("/"))) return raw
    val qAt = beforeHash.indexOf('?')
    if (qAt < 0) return raw
    val base = beforeHash.substring(0, qAt)
    val query = beforeHash.substring(qAt + 1)
    val authority = base.substringAfter("://").substringBefore('/')
    val host = authority.substringAfterLast('@').substringBefore(':').lowercase().removePrefix("www.")
    val parts = query.split('&').filter { it.isNotEmpty() }
    val kept = parts.filter { !isTracker(decodeComponent(it.substringBefore('=')), host) }
    if (kept.size == parts.size) return raw
    val path = if (base.substringAfter("://").contains('/')) base else "$base/"
    return path + (if (kept.isEmpty()) "" else "?" + kept.joinToString("&")) + hash
}

/** Every http(s) link a bubble renders (markdown + bare links), tracker-
 *  stripped when [strip] and deduped — the sheet's "Show links" list. The
 *  pressed link alone skips the list (its items are already above). */
fun sheetLinks(rendered: List<String>, pressedHref: String, strip: Boolean): List<String> {
    val links = mutableListOf<String>()
    for (raw in rendered) {
        if (!isHttpLink(raw)) continue
        val clean = if (strip) stripTrackingUrl(raw) else raw
        if (clean !in links) links += clean
    }
    val pressed = if (isHttpLink(pressedHref)) (if (strip) stripTrackingUrl(pressedHref) else pressedHref) else ""
    return if (links.isNotEmpty() && !(links.size == 1 && links[0] == pressed)) links else emptyList()
}

/** format.js formatServerUrl: "<addr/Folder/;UID=n>" → "addr Folder UID=n". */
fun formatServerUrl(raw: String): String {
    val m = Regex("^<(.+)/;UID=(\\d+)>$").find(raw) ?: return raw
    val body = m.groupValues[1]
    val uid = m.groupValues[2]
    val slash = body.indexOf('/')
    if (slash < 0) return "$body UID=$uid"
    val addr = body.substring(0, slash)
    val folder = body.substring(slash + 1)
    return if (folder.isNotEmpty() && folder != "INBOX") "$addr $folder UID=$uid" else "$addr UID=$uid"
}

/** Stable unread states (InFresh 10, InNoticed 13). */
fun isUnreadState(state: Int): Boolean = state == 10 || state == 13

/** format.js messageInfoState keys: (seen key, encryption key). */
fun messageInfoStateKeys(m: MessageObject): Pair<String, String> {
    val seen = if (m.fromId == 1L) m.state == 28 else !isUnreadState(m.state)
    return (if (seen) "Seen" else "Not seen") to (if (m.showPadlock) "Encrypted" else "Not encrypted")
}
