package org.velta.kmp.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import java.io.File

/** App-private scratch for edited pictures; set by VeltaApplication (cacheDir/edits). */
object EditScratch {
    @Volatile var dir: File? = null
}

private fun scaledDown(bmp: Bitmap, maxSide: Int): Bitmap {
    val longer = maxOf(bmp.width, bmp.height)
    if (longer <= maxSide) return bmp
    val k = maxSide.toFloat() / longer
    return Bitmap.createScaledBitmap(bmp, maxOf(1, (bmp.width * k).toInt()), maxOf(1, (bmp.height * k).toInt()), true)
}

actual fun decodeImageScaled(path: String, maxSide: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val raw = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    // Camera JPEGs carry their rotation in EXIF; BitmapFactory ignores it.
    val degrees = runCatching {
        when (ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
    }.getOrDefault(0f)
    val upright = if (degrees == 0f) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(degrees) }, true)
    scaledDown(upright, maxSide).asImageBitmap()
}.getOrNull()

actual fun readVideoInfo(path: String, maxSide: Int): VideoInfo? {
    val r = MediaMetadataRetriever()
    return try {
        r.setDataSource(path)
        val dur = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        val frame = runCatching { r.getFrameAtTime(0) }.getOrNull()?.let { scaledDown(it, maxSide).asImageBitmap() }
        VideoInfo(frame, dur)
    } catch (t: Throwable) {
        null
    } finally {
        runCatching { r.release() }
    }
}

actual fun saveEditedJpeg(image: ImageBitmap, name: String): String? = runCatching {
    val dir = EditScratch.dir?.apply { mkdirs() } ?: return null
    val src = image.asAndroidBitmap()
    // JPEG has no alpha: flatten onto white.
    val flat = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
    android.graphics.Canvas(flat).apply { drawColor(android.graphics.Color.WHITE); drawBitmap(src, 0f, 0f, null) }
    // Old edits were copied into the core's blobdir on send/draft; drop them.
    val dayAgo = System.currentTimeMillis() - 24 * 3600 * 1000L
    dir.listFiles()?.forEach { if (it.lastModified() < dayAgo) it.delete() }
    val out = File(dir, "${System.currentTimeMillis()}-${name.replace(Regex("[/\\\\]"), "_")}")
    out.outputStream().use { flat.compress(Bitmap.CompressFormat.JPEG, 92, it) }
    out.absolutePath
}.getOrNull()
