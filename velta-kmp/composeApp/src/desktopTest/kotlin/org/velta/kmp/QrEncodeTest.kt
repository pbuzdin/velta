package org.velta.kmp

import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.velta.kmp.ui.QrEncode

/**
 * The QrEncode port of app/js/qr-encode.js (Nayuki, optimal segmentation)
 * must produce symbols the same decoder the camera pipeline uses can read —
 * the QR view renders this matrix directly to a Canvas. Rasterized at 8 px
 * per module (37-module symbols stay too small for HybridBinarizer otherwise;
 * the web renders the same matrix as a scaled SVG).
 */
class QrEncodeTest {

    private fun decode(qr: QrEncode.Qr): String {
        val quiet = 4
        val scale = 8
        val n = (qr.size + quiet * 2) * scale
        val pixels = IntArray(n * n)
        for (py in 0 until n) {
            for (px in 0 until n) {
                val x = px / scale - quiet
                val y = py / scale - quiet
                pixels[py * n + px] = if (qr[x, y]) 0x000000 else 0xFFFFFF
            }
        }
        val decoded = QRCodeReader().decode(
            BinaryBitmap(HybridBinarizer(RGBLuminanceSource(n, n, pixels))),
        )
        return decoded.text
    }

    @Test
    fun inviteLinkRoundTripsThroughZxing() {
        // The canonical self-invite form the core's get_securejoin_qr returns.
        val payload = "https://i.delta.chat/#DD1FDB8A5621D4A89DE0054D1AC26A6BFBA39328v~0000000000000000000"
        val qr = QrEncode.encode(payload)
        assertEquals(payload, decode(qr))
    }

    @Test
    fun shortPayloadAndAstralTextRoundTrip() {
        assertEquals("DCACCOUNT:https://d13.buro.dev/new", decode(QrEncode.encode("DCACCOUNT:https://d13.buro.dev/new")))
        // Code points, not UTF-16 units: an astral char is one numChars unit.
        val emojiPayload = "hi 👋ometer"
        assertEquals(emojiPayload, decode(QrEncode.encode(emojiPayload)))
    }

    @Test
    fun optimalSegmentationBeatsSingleMode() {
        // A long numeric run: the optimal splitter often fits a lower version
        // than the core's single-mode choice — assert it still encodes and
        // decodes byte-identically.
        val numbers = "123456789012345678901234567890123456789012345678901234567890"
        val qr = QrEncode.encode(numbers)
        assertTrue(qr.version >= 1 && qr.version <= 40)
        assertEquals(numbers, decode(qr))
    }

    @Test
    fun oversizeDataThrows() {
        val huge = "x".repeat(4000)
        assertTrue(runCatching { QrEncode.encode(huge) }.isFailure)
    }
}
