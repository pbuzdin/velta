package org.velta.kmp.ui

import org.velta.kmp.core.MessageObject

/**
 * Composer card (#334, Pavel's pick: variant A "floating card"): reply /
 * edit and the staged attachment share one rounded, elevated card above
 * the composer. Pure helpers so the content rules are testable.
 */

/** Which rows the card shows, top to bottom; empty = card hidden. */
enum class CardRow { Edit, Reply, Attachment }

fun composerCardRows(reply: Boolean, editing: Boolean, attachment: Boolean): List<CardRow> = buildList {
    // Editing replaces the reply row (stable reuses #reply-preview for both).
    if (editing) add(CardRow.Edit) else if (reply) add(CardRow.Reply)
    if (attachment) add(CardRow.Attachment)
}

/** Quoted media that gets a thumbnail instead of the sender's avatar. */
fun replyThumbKind(m: MessageObject): String? {
    if (m.file.isNullOrBlank()) return null
    return when (m.viewType) {
        "Image", "Gif", "Sticker" -> "image"
        "Video" -> "video"
        else -> null
    }
}

/** English label for a media message without text (L.t keys). */
fun mediaLabelKey(viewType: String): String? = when (viewType) {
    "Image" -> "Photo"
    "Gif" -> "GIF"
    "Sticker" -> "Sticker"
    "Video" -> "Video"
    "Voice" -> "Voice message"
    "Audio" -> "Audio"
    "File" -> "File"
    else -> null
}

/** Snippet line: the text (first line, 80 chars), else the file name or media label. */
fun replySnippet(m: MessageObject, t: (String) -> String = { it }): String {
    val shown = xferDisplayText(m.text, t)
    if (shown != null) return shown.take(80)
    val line = m.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    if (line.isNotEmpty()) return line.take(80)
    if (m.viewType == "File" && !m.fileName.isNullOrBlank()) return m.fileName
    return mediaLabelKey(m.viewType)?.let(t) ?: t("Message")
}

/** Attachment kind for the staged file, from its name (share rules). */
fun stagedKind(name: String): String = when (shareViewtype(name)) {
    "image" -> "image"
    "video" -> "video"
    else -> "file"
}

/** Secondary line under the staged file's name. */
fun stagedDetail(kind: String, durationMs: Long, t: (String) -> String = { it }): String = when (kind) {
    "image" -> t("Photo")
    "video" -> if (durationMs > 0) t("Video") + " · " + formatClipDuration(durationMs) else t("Video")
    else -> t("File")
}
