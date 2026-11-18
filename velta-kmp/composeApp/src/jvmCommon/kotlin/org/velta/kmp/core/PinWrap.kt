package org.velta.kmp.core

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.io.File
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * App-lock PIN wrap (`db_key.rs` pin_wrap_*). File layout, 86 bytes:
 * `VLTDW | u8 ver=1 | u32 LE attempts | 16B salt | 12B nonce | 48B AES-GCM ct`.
 * KEK is Argon2id(PIN, salt, 64 MiB, t=3, p=1). The attempts counter is
 * cleartext and is not in the AAD, so a wrong guess can bump it without a rewrap.
 */
internal object PinWrap {
    private val MAGIC = byteArrayOf(0x56, 0x4c, 0x54, 0x44, 0x57) // VLTDW
    private const val FILE_LEN = 86

    /** null on success, otherwise "pin too short" or "bad dek". */
    fun write(path: File, pin: String, dekHex: String): String? {
        if (pin.codePointCount(0, pin.length) < 6) return "pin too short"
        val dek = decodeHex(dekHex)
        if (dek == null || dek.size != 32) return "bad dek"
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val head = header(0, salt, nonce)
        val ct = aes(encrypt = true, kek = derive(pin, salt), nonce = nonce, aad = aad(head, salt, nonce), msg = dek)
            ?: return "encrypt failed"
        val file = ByteArray(head.size + ct.size)
        head.copyInto(file)
        ct.copyInto(file, head.size)
        path.parentFile?.mkdirs()
        path.writeBytes(file)
        return null
    }

    fun open(path: File, pin: String): PinUnlock {
        val bytes = try {
            path.readBytes()
        } catch (_: Exception) {
            return PinUnlock.Corrupt
        }
        if (bytes.size != FILE_LEN || !bytes.copyOfRange(0, 5).contentEquals(MAGIC) || bytes[5] != 1.toByte()) {
            return PinUnlock.Corrupt
        }
        val attempts = le32(bytes, 6)
        val salt = bytes.copyOfRange(10, 26)
        val nonce = bytes.copyOfRange(26, 38)
        val ct = bytes.copyOfRange(38, bytes.size)
        val dek = aes(encrypt = false, kek = derive(pin, salt), nonce = nonce, aad = aad(bytes, salt, nonce), msg = ct)
        if (dek != null && dek.size == 32) {
            storeCounter(path, 0)
            return PinUnlock.Dek(encodeHex(dek))
        }
        // Unsigned: a hostile counter with the high bit set must not wrap to 0 or throw on shl.
        val cur = attempts.toUInt()
        val next = if (cur == UInt.MAX_VALUE) cur else cur + 1u
        storeCounter(path, next.toInt())
        return PinUnlock.Wrong(backoffSecs(next.toInt()))
    }

    /** 0, then 1, 2, 4, … capped at 30. Matches `db_key.rs` backoff_secs. */
    fun backoffSecs(attempts: Int): Long {
        val n = attempts.toUInt()
        if (n == 0u) return 0L
        val shift = (n - 1u).coerceAtMost(5u).toInt()
        return minOf(30L, 1L shl shift)
    }

    private fun derive(pin: String, salt: ByteArray): ByteArray {
        val gen = Argon2BytesGenerator()
        gen.init(
            Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                .withIterations(3)
                .withMemoryAsKB(64 * 1024)
                .withParallelism(1)
                .withSalt(salt)
                .build(),
        )
        val out = ByteArray(32)
        gen.generateBytes(pin.toByteArray(Charsets.UTF_8), out)
        return out
    }

    private fun header(counter: Int, salt: ByteArray, nonce: ByteArray): ByteArray {
        val head = ByteArray(38)
        MAGIC.copyInto(head)
        head[5] = 1
        putLe32(head, 6, counter)
        salt.copyInto(head, 10)
        nonce.copyInto(head, 26)
        return head
    }

    /** AAD is magic+version, salt, and nonce. The attempts counter is excluded. */
    private fun aad(head: ByteArray, salt: ByteArray, nonce: ByteArray): ByteArray {
        val out = ByteArray(6 + salt.size + nonce.size)
        head.copyInto(out, 0, 0, 6)
        salt.copyInto(out, 6)
        nonce.copyInto(out, 6 + salt.size)
        return out
    }

    private fun aes(encrypt: Boolean, kek: ByteArray, nonce: ByteArray, aad: ByteArray, msg: ByteArray): ByteArray? =
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val mode = if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE
            cipher.init(mode, SecretKeySpec(kek, "AES"), GCMParameterSpec(128, nonce))
            cipher.updateAAD(aad)
            cipher.doFinal(msg)
        } catch (_: Exception) {
            null
        }

    private fun storeCounter(path: File, counter: Int) {
        val bytes = try {
            path.readBytes()
        } catch (_: Exception) {
            return
        }
        if (bytes.size < 10) return
        putLe32(bytes, 6, counter)
        try {
            path.writeBytes(bytes)
        } catch (_: Exception) {
        }
    }

    private fun le32(bytes: ByteArray, at: Int): Int {
        return (bytes[at].toInt() and 0xff) or
            ((bytes[at + 1].toInt() and 0xff) shl 8) or
            ((bytes[at + 2].toInt() and 0xff) shl 16) or
            ((bytes[at + 3].toInt() and 0xff) shl 24)
    }

    private fun putLe32(bytes: ByteArray, at: Int, value: Int) {
        bytes[at] = value.toByte()
        bytes[at + 1] = (value ushr 8).toByte()
        bytes[at + 2] = (value ushr 16).toByte()
        bytes[at + 3] = (value ushr 24).toByte()
    }
}

internal fun decodeHex(hex: String): ByteArray? {
    if (hex.length % 2 != 0) return null
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        val hi = Character.digit(hex[i * 2].code, 16)
        val lo = Character.digit(hex[i * 2 + 1].code, 16)
        if (hi < 0 || lo < 0) return null
        out[i] = ((hi shl 4) or lo).toByte()
    }
    return out
}

internal fun encodeHex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
        val v = bytes[i].toInt() and 0xff
        out[i * 2] = digits[v ushr 4]
        out[i * 2 + 1] = digits[v and 0xf]
    }
    return String(out)
}
