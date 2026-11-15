package org.velta.kmp.ui

/**
 * How a tapped attachment opens (#334 step 11), mirrored from stable
 * chat-view.js documentOpenPlan / isMediaFilePath (#279). Pure — no
 * Compose, no platform — so the desktop tests pin it.
 */

private val MEDIA_FILE = Regex("\\.(?:png|jpe?g|gif|webp|bmp|avif)$", RegexOption.IGNORE_CASE)
private val HTML_FILE = Regex("\\.x?html?$", RegexOption.IGNORE_CASE)

/** Images the in-app lightbox shows (animated webp/gif included). */
fun isMediaFilePath(path: String?): Boolean = MEDIA_FILE.containsMatchIn(path ?: "")

enum class OpenPlan { Html, Lightbox, Native }

/** Stable on Android: HTML is untrusted web content, images stay in the
 *  lightbox, everything else goes to the system's default app. */
fun documentOpenPlan(path: String?, name: String?, android: Boolean): OpenPlan {
    val ref = name ?: path ?: ""
    if (HTML_FILE.containsMatchIn(path ?: "") || HTML_FILE.containsMatchIn(ref)) return OpenPlan.Html
    return if (android && isMediaFilePath(path)) OpenPlan.Lightbox else OpenPlan.Native
}

/** stable attachmentName: the message's file name, else the blob's. */
fun attachmentName(fileName: String?, path: String): String =
    fileName?.takeIf { it.isNotBlank() } ?: path.substringAfterLast('/')

/** A name safe for the open-docs copy (no path separators or controls). */
fun safeOpenName(name: String): String {
    val cleaned = name.replace(Regex("[/\\\\:*?\"<>|\\u0000-\\u001f]"), "_").trim().trimStart('.')
    return cleaned.ifEmpty { "file" }.take(120)
}

/** Lightbox caption: stable passes the file name, else a plain noun. */
fun lightboxCaption(fileName: String?, viewType: String): String =
    fileName?.takeIf { it.isNotBlank() } ?: if (viewType == "Sticker") "sticker" else "photo"

/** Pinch zoom range and double-tap level (stable openImageLightbox). */
const val LIGHTBOX_MAX_SCALE = 8f
const val LIGHTBOX_DOUBLE_TAP_SCALE = 2.5f

/** Clamp a pinch result; at <= 1.02 the image snaps back to fit. */
fun lightboxScale(raw: Float): Float {
    val s = raw.coerceIn(1f, LIGHTBOX_MAX_SCALE)
    return if (s <= 1.02f) 1f else s
}
