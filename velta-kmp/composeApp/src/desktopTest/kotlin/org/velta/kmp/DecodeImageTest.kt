package org.velta.kmp

import java.awt.image.BufferedImage
import java.nio.file.Files
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.velta.kmp.ui.decodeImage

/** P4 media rendering: the JVM decoder reads real files and rejects junk. */
class DecodeImageTest {

    @Test
    fun decodesPngAndRejectsMissingFiles() = runBlocking {
        withContext(Dispatchers.IO) {
        val png = Files.createTempFile("kmp-decode", ".png")
        val img = BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB)
        img.setRGB(1, 1, 0xFF3366)
        ImageIO.write(img, "png", png.toFile())

        val decoded = decodeImage(png.toString())
        assertNotNull(decoded, "a real PNG decodes")
        assertEquals(3, decoded.width)
        assertEquals(2, decoded.height)

        assertNull(decodeImage("/nonexistent/path.png"), "missing file → null")
        assertNull(decodeImage(png.toString() + ".txt"), "non-image bytes → null")
        }
    }
}
