package org.velta.kmp

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * P4 QR scanning: the same decoder pipeline the ScanActivity uses
 * (luminance source → HybridBinarizer → QRCodeReader) round-trips a payload
 * encoded by the companion writer. Pins the dependency and the decode setup
 * that the camera frames feed on Android.
 */
class QrRoundTripTest {

    @Test
    fun encodeThenDecodeRoundTrips() {
        val payload = "DCACCOUNT:https://relay.example/i/abc123"

        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 256, 256)
        // Rasterize the bit matrix the way a camera frame would arrive: an
        // RGB pixel array whose luminance the decoder samples.
        val pixels = IntArray(matrix.width * matrix.height)
        for (x in 0 until matrix.width) {
            for (y in 0 until matrix.height) {
                pixels[y * matrix.width + x] = if (matrix[x, y]) 0x000000 else 0xFFFFFF
            }
        }

        val decoded = QRCodeReader().decode(
            BinaryBitmap(HybridBinarizer(RGBLuminanceSource(matrix.width, matrix.height, pixels))),
        )

        assertEquals(payload, decoded.text)
    }
}
