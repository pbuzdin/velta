package org.velta.kmp.ui

import org.velta.kmp.core.MessageObject

/**
 * Auto-download limit + Text-only mode (#358 C/D) — a pure port of:
 *  - ui.js drawer "Auto-download limit" radios, app.js savedDownloadLimit /
 *    onDownloadLimit (device-global pref mirrored into every account's
 *    `download_limit` config) and multidevice.js DL_LIMIT_HINT,
 *  - chat-view.js download cards ("Tap to download" / "Downloading…"),
 *  - text-only-mode.js (`velta-text-only`, coversMessage, session reveals)
 *    and chat-view.js `_hiddenCard`.
 * Renderer-only policy, like stable: it decides what the interface loads
 * and shows, not what the core receives.
 * No Compose here: MediaGateRulesTest pins every rule.
 */

/** Stable pref key (localStorage) and the radio options (bytes as text). */
const val DOWNLOAD_LIMIT_KEY = "velta-download-limit"
val DOWNLOAD_LIMIT_OPTIONS: List<Pair<String, String>> = listOf(
    "0" to "No limit (default)",
    "1048576" to "1 MB",
    "5242880" to "5 MB",
    "26214400" to "25 MB",
)
const val DOWNLOAD_LIMIT_HINT =
    "Files above the limit are not downloaded automatically: tap them to download. Until then they stay on the relay (until the relay purges them, usually after about 7 days) and use relay storage."

/** app.js savedDownloadLimit: unset → "0"; the retired 640 KB value
 *  (655360) migrates to 1 MB. Returns (value, needs rewrite). */
fun savedDownloadLimit(raw: String?): Pair<String, Boolean> {
    val v = if (raw.isNullOrEmpty()) "0" else if (raw == "655360") "1048576" else raw
    return v to (raw != null && raw != v)
}

/** Stable toast after a change. */
fun downloadLimitToast(value: String): String =
    if (value == "0") "Auto-download limit: none" else "Auto-download limit set"

/** Text-only mode: "unknown" (default, stores nothing) | "off" | "all". */
const val TEXT_ONLY_KEY = "velta-text-only"
val TEXT_ONLY_OPTIONS: List<Pair<String, String>> = listOf(
    "unknown" to "Unknown senders",
    "off" to "Off",
    "all" to "All messages",
)
const val TEXT_ONLY_HINT = "Don't load attachments or link previews unless you choose to show them. Text and links stay visible."

fun textOnlyModeOf(raw: String?): String = if (raw == "off" || raw == "all") raw else "unknown"

/** The stored value: the default removes the key. */
fun textOnlyStored(mode: String): String? = if (mode == "off" || mode == "all") mode else null

fun textOnlyLabel(mode: String): String = TEXT_ONLY_OPTIONS.firstOrNull { it.first == mode }?.second ?: "Unknown senders"

/** chat-view.js COVERED_VIEWTYPES + hasAttachmentMetadata. */
// Stable also covers "vcard"; KMP draws no contact card yet, so there is
// nothing to hide and a reveal would show nothing.
private val COVERED = setOf("image", "sticker", "video", "audio", "voice", "webxdc", "file")
fun hasAttachmentMetadata(m: MessageObject): Boolean =
    !m.file.isNullOrEmpty() || !m.fileName.isNullOrEmpty() || !m.fileMime.isNullOrEmpty() || (m.fileBytes ?: 0L) > 0L

/** text-only-mode.js coversMessage + the attachment gate: "all" covers
 *  every attachment, "unknown" only those in an unaccepted 1:1 request
 *  (never our own or the device chat's), "off" none. */
fun coversAttachment(m: MessageObject, mode: String, chatKind: String?): Boolean {
    if (m.isInfo) return false
    if (stableViewtype(m.viewType) !in COVERED || !hasAttachmentMetadata(m)) return false
    return when (mode) {
        "off" -> false
        "all" -> true
        else -> chatKind == "deaddrop" && m.fromId != 1L && m.fromId != 5L
    }
}

/** Session reveal key (`${accountId}:${msgId}`). */
fun revealKey(accountId: Long, msgId: Long): String = "$accountId:$msgId"

/** `_hiddenCard` kind label for a nameless file. */
fun hiddenKindLabel(viewType: String): String = when (stableViewtype(viewType)) {
    "image" -> "Photo"
    "sticker" -> "Sticker"
    "video" -> "Video"
    "audio" -> "Audio"
    "voice" -> "Voice message"
    "webxdc" -> "Webxdc app"
    "vcard" -> "Contact"
    else -> "File"
}

/** `_hiddenCard` button: Show when the file is here, else Download and show. */
fun revealActionLabel(downloadState: String?): String =
    if ((downloadState ?: "Done") == "Done") "Show" else "Download and show"

/** Stable download cards: media whose file is not on the device yet. */
private val DOWNLOADABLE = setOf("image", "sticker", "video", "audio", "voice", "file")
fun needsDownloadCard(m: MessageObject): Boolean =
    stableViewtype(m.viewType) in DOWNLOADABLE && (m.downloadState ?: "Done") != "Done"

/** Download card label: the file name, else the kind (Photo / Video / Voice message / Audio / File). */
fun downloadCardName(m: MessageObject): String = m.fileName?.takeIf { it.isNotEmpty() } ?: hiddenKindLabel(m.viewType)

/** Download card sub-line key: "Downloading…" while in progress, else the
 *  size (images/video/files; [sizeText] already formatted) or "Tap to download".
 *  Audio and voice never show a size (stable). */
fun downloadCardSub(m: MessageObject, sizeText: String?): String = when {
    m.downloadState == "InProgress" -> "Downloading…"
    stableViewtype(m.viewType) in setOf("audio", "voice") -> "Tap to download"
    !sizeText.isNullOrEmpty() -> sizeText
    else -> "Tap to download"
}
