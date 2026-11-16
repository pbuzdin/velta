package org.velta.kmp.ui

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.graphics.toComposeImageBitmap
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO

actual fun decodeImageScaled(path: String, maxSide: Int): ImageBitmap? = runCatching {
    val src = ImageIO.read(File(path)) ?: return null
    val longer = maxOf(src.width, src.height)
    if (longer <= maxSide) return src.toComposeImageBitmap()
    val k = maxSide.toDouble() / longer
    val w = maxOf(1, (src.width * k).toInt())
    val h = maxOf(1, (src.height * k).toInt())
    val out = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
    val g = out.createGraphics()
    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
    g.drawImage(src, 0, 0, w, h, null)
    g.dispose()
    out.toComposeImageBitmap()
}.getOrNull()

/** Desktop has no frame grabber without extra native deps; the preview shows a video tile. */
actual fun readVideoInfo(path: String, maxSide: Int): VideoInfo? = null

actual fun saveEditedJpeg(image: ImageBitmap, name: String): String? = runCatching {
    val argb = image.toAwtImage()
    // JPEG has no alpha: flatten onto white.
    val rgb = BufferedImage(argb.width, argb.height, BufferedImage.TYPE_INT_RGB)
    val g = rgb.createGraphics()
    g.color = java.awt.Color.WHITE
    g.fillRect(0, 0, rgb.width, rgb.height)
    g.drawImage(argb, 0, 0, null)
    g.dispose()
    val dir = File(System.getProperty("java.io.tmpdir"), "velta-edits").apply { mkdirs() }
    // Old edits were copied into the core's blobdir on send/draft; drop them.
    val dayAgo = System.currentTimeMillis() - 24 * 3600 * 1000L
    dir.listFiles()?.forEach { if (it.lastModified() < dayAgo) it.delete() }
    val out = File(dir, "${System.currentTimeMillis()}-${name.replace(Regex("[/\\\\]"), "_")}")
    if (!ImageIO.write(rgb, "jpg", out)) return null
    out.absolutePath
}.getOrNull()
