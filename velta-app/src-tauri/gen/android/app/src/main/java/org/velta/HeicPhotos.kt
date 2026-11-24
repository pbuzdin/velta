package org.velta

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import java.io.FileOutputStream
import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * Outgoing HEIC/HEIF photos. The Android WebView cannot decode them, so they
 * went out as generic files with no preview. The platform decoder turns one
 * into a photo the app already handles end to end (preview, crop, the
 * "Compress photos" step): full size, JPEG at quality 95 — PNG only when it
 * has transparency, which JPEG cannot keep. The app shrinks it to the
 * "Image quality" budget at Send, so a crop still works on the full picture.
 * Returns "jpg" or "png", or null when this device cannot decode the file
 * (Android 8 and older, or a damaged file); the caller then sends the original.
 */
object HeicPhotos {
  // Full size, so a crop works on the whole picture — but not past this: a
  // 108 or 200 megapixel shot needs close to a gigabyte as a bitmap.
  private const val MAX_PIXELS = 24_000_000L

  @JvmStatic
  fun convert(context: Context, uri: String, destPath: String): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    return try {
      // ImageDecoder applies the stored orientation, so the photo comes out upright.
      val source = ImageDecoder.createSource(context.contentResolver, Uri.parse(uri))
      val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val pixels = info.size.width.toLong() * info.size.height
        if (pixels > MAX_PIXELS) {
          decoder.setTargetSampleSize(ceil(sqrt(pixels.toDouble() / MAX_PIXELS)).toInt())
        }
      }
      try {
        val alpha = bitmap.hasAlpha()
        val format = if (alpha) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        val written = FileOutputStream(destPath).use { out -> bitmap.compress(format, 95, out) }
        when {
          !written -> null
          alpha -> "png"
          else -> "jpg"
        }
      } finally {
        bitmap.recycle()
      }
    } catch (_: Exception) {
      null
    } catch (_: OutOfMemoryError) {
      null // an Error, not an Exception: send the original instead of crashing
    }
  }
}
