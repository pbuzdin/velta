package org.velta.kmp

import org.velta.kmp.core.PinUnlock
import org.velta.kmp.core.PinWrap
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Tauri `pin_wrap_roundtrip_and_backoff` + corrupt stays corrupt. */
class PinWrapTest {
    private val key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
    private val other = "ff112233445566778899aabbccddeeff00112233445566778899aabbccddee00"

    @Test
    fun roundtripBackoffAndCorruptMatchTheDesktopWrap() {
        val dir = File(System.getProperty("java.io.tmpdir"), "velta-pin-wrap-test").apply {
            deleteRecursively()
            mkdirs()
        }
        val wrap = File(dir, "dbkey.pin.wrap")
        try {
            assertEquals("pin too short", PinWrap.write(wrap, "12345", key))
            assertEquals("bad dek", PinWrap.write(wrap, "123456", "abcd"))
            assertEquals(null, PinWrap.write(wrap, "123456", key))
            assertEquals(86, wrap.length())

            assertEquals(key, assertIs<PinUnlock.Dek>(PinWrap.open(wrap, "123456")).hex)
            assertIs<PinUnlock.Wrong>(PinWrap.open(wrap, other))
            val second = assertIs<PinUnlock.Wrong>(PinWrap.open(wrap, "000000"))
            assertEquals(2L, second.delaySecs)
            val third = assertIs<PinUnlock.Wrong>(PinWrap.open(wrap, "000000"))
            assertEquals(4L, third.delaySecs)
            assertEquals(key, assertIs<PinUnlock.Dek>(PinWrap.open(wrap, "123456")).hex)
            val reset = assertIs<PinUnlock.Wrong>(PinWrap.open(wrap, "000000"))
            assertEquals(1L, reset.delaySecs)
            assertEquals(30L, PinWrap.backoffSecs(10))
            assertEquals(0L, PinWrap.backoffSecs(0))

            val flipped = wrap.readBytes().also { it[0] = 'X'.code.toByte() }
            wrap.writeBytes(flipped)
            assertIs<PinUnlock.Corrupt>(PinWrap.open(wrap, "123456"))
            assertTrue(flipped.contentEquals(wrap.readBytes()))

            val tiny = File(dir, "tiny")
            tiny.writeBytes("tiny".toByteArray())
            assertIs<PinUnlock.Corrupt>(PinWrap.open(tiny, "123456"))
            assertEquals(4, tiny.length())
        } finally {
            dir.deleteRecursively()
        }
    }
}
