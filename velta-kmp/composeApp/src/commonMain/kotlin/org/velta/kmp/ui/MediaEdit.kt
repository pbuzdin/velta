package org.velta.kmp.ui

import androidx.compose.ui.graphics.ImageBitmap

/** Decode [path] with its longer side at most [maxSide] px (subsampled,
 *  EXIF orientation applied where the platform knows it); null if unreadable. */
expect fun decodeImageScaled(path: String, maxSide: Int): ImageBitmap?

/** A video's first frame (scaled to [maxSide]) and duration; null fields when unknown. */
class VideoInfo(val frame: ImageBitmap?, val durationMs: Long)

expect fun readVideoInfo(path: String, maxSide: Int): VideoInfo?

/** Write [image] as a JPEG into the app's private scratch directory under
 *  [name]; returns the path, or null on failure. Never the user's folders. */
expect fun saveEditedJpeg(image: ImageBitmap, name: String): String?
