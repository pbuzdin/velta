package org.velta.kmp

import org.velta.kmp.core.decodeHex
import org.velta.kmp.core.encodeHex
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

/**
 * The database key string is the hex of the DEK bytes. An encoder that
 * repeated the high nibble (the pre-fix VeltaKeystore.hex) kept only 16 of 256
 * values per byte, so the key carried 128 effective bits.
 */
class HexTest {
    @Test
    fun everyByteKeepsBothNibbles() {
        val all = ByteArray(256) { it.toByte() }
        val hex = encodeHex(all)
        assertEquals(512, hex.length)
        for (v in 0..255) {
            assertEquals("%02x".format(v), hex.substring(v * 2, v * 2 + 2), "byte $v")
        }
        assertContentEquals(all, decodeHex(hex))
    }

    @Test
    fun aKnownDekEncodesToItsOwnBytes() {
        val dek = ByteArray(32) { (it * 7 + 3).toByte() }
        val hex = encodeHex(dek)
        assertEquals(64, hex.length)
        assertContentEquals(dek, decodeHex(hex), "the key string must decode back to the DEK")
        // A repeated-high-nibble string is a different (degenerate) key.
        val degenerate = dek.joinToString("") { "%x%x".format((it.toInt() and 0xff) shr 4, (it.toInt() and 0xff) shr 4) }
        assert(hex != degenerate)
    }
}
