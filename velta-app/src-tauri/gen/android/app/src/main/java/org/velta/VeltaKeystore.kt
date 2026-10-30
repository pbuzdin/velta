package org.velta

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Database-encryption DEK custody (#178 phase 2). A non-exportable
// AES-256-GCM key ("velta_kek") lives in AndroidKeyStore — StrongBox when
// the device has one — and wraps a random 256-bit DEK. The wrapped blob
// goes to noBackupFilesDir (never backed up, even before the global
// data-extraction rules) so a restored database can never be decrypted on
// another device. No user authentication is bound to the KEK: push and job
// cold starts must unlock databases without UI; the strong (biometric)
// mode is phase 4's app lock.
//
// Returns the DEK as 64 hex chars, or null when the keychain is lost or
// unusable — the caller then runs keyless, which leaves already-encrypted
// databases closed (locked) and never recreates anything over them.
object VeltaKeystore {
    private const val TAG = "velta-keystore"
    private const val KEK_ALIAS = "velta_kek"
    private const val WRAP_FILE = "dbkey.wrap"
    private const val GCM_TAG_BITS = 128

    @JvmStatic
    fun getOrCreateDek(context: Context): String? {
        return try {
            val wrapFile = File(context.noBackupFilesDir, WRAP_FILE)
            if (wrapFile.exists()) {
                unwrap(wrapFile)?.let { return it }
                // The wrap exists but cannot be decrypted: the Keystore key
                // was lost (uninstall + partial restore). Do NOT regenerate
                // anything — the encrypted databases stay locked instead.
                Log.e(TAG, "dbkey.wrap present but undecryptable; running keyless")
                return null
            }
            create(context, wrapFile)
        } catch (e: Exception) {
            Log.e(TAG, "keystore unavailable", e)
            null
        }
    }

    private fun create(context: Context, wrapFile: File): String? {
        val kek = kek() ?: return null
        val dek = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, kek)
        val iv = cipher.iv
        val blob = ByteArray(1 + iv.size + dek.size)
        blob[0] = 1 // format version
        iv.copyInto(blob, 1)
        cipher.doFinal(dek).copyInto(blob, 1 + iv.size)
        wrapFile.writeBytes(blob)
        Log.i(TAG, "generated a new database key")
        return hex(dek)
    }

    private fun unwrap(wrapFile: File): String? = try {
        val kek = kek() ?: return null
        val blob = wrapFile.readBytes()
        if (blob.size < 14 || blob[0] != 1.toByte()) {
            Log.e(TAG, "unknown dbkey.wrap format")
            null
        } else {
            val iv = blob.copyOfRange(1, 13)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(GCM_TAG_BITS, iv))
            hex(cipher.doFinal(blob, 13, blob.size - 13))
        }
    } catch (e: Exception) {
        null
    }

    private fun kek(): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEK_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore",
        )
        val common = {
            KeyGenParameterSpec.Builder(
                KEK_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
        }
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                try {
                    generator.init(common().setStrongBoxBacked(true).build())
                } catch (e: Exception) {
                    if (e is StrongBoxUnavailableException || e is KeyPermanentlyInvalidatedException) {
                        generator.init(common().build())
                    } else {
                        throw e
                    }
                }
            } else {
                generator.init(common().build())
            }
        } catch (e: Exception) {
            Log.e(TAG, "kek generation failed", e)
            return null
        }
        return generator.generateKey()
    }

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            out[i * 2] = digits[(bytes[i].toInt() shr 4) and 0xf]
            out[i * 2 + 1] = digits[bytes[i].toInt() and 0xf]
        }
        return String(out)
    }
}
