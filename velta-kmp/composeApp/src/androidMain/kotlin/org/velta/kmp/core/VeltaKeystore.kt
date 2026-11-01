package org.velta.kmp.core

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

/**
 * Database-encryption DEK custody (#178 port, P4 slice 9). A non-exportable
 * AES-256-GCM key ("velta_kek") lives in AndroidKeyStore — StrongBox when
 * the device has one — and wraps a random 256-bit DEK. The wrapped blob
 * goes to noBackupFilesDir (never backed up) so a restored database can
 * never be decrypted on another device. No user authentication is bound to
 * the KEK: push and job cold starts must unlock databases without UI; the
 * strong (biometric) app lock is a later slice — its hook is marked below.
 *
 * Returns the DEK as 64 hex chars, or null when the keychain is lost or
 * unusable — the caller then runs keyless, which leaves already-encrypted
 * databases closed (locked) and never recreates anything over them.
 *
 * Faithful port of the Tauri shell's VeltaKeystore.kt (same alias, same
 * dbkey.wrap layout v1+iv+GCM(ct), same atomic write) so both apps share
 * one reviewed format.
 */
object VeltaKeystore {
    private const val TAG = "velta-keystore"
    private const val KEK_ALIAS = "velta_kek"
    private const val WRAP_FILE = "dbkey.wrap"
    private const val GCM_TAG_BITS = 128

    @JvmStatic
    fun getOrCreateDek(context: Context): String? {
        return try {
            // Later slice (app lock): when the biometric lock is on, return
            // null here and let VeltaLock hand over the DEK after the prompt.
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
        // GCM output = plaintext + 16-byte tag: size the blob from the
        // CIPHERTEXT. (The Tauri original allocated for the plaintext — the
        // copyInto overflowed on every device, so create() always threw and
        // every Tauri Android install silently ran keyless.)
        val encrypted = cipher.doFinal(dek)
        val blob = ByteArray(1 + iv.size + encrypted.size)
        blob[0] = 1 // format version
        iv.copyInto(blob, 1)
        encrypted.copyInto(blob, 1 + iv.size)
        // Atomic: temp file + fsync + rename, so a crash mid-write never
        // leaves a torn dbkey.wrap (which would read as "Keystore lost").
        val tmp = File(wrapFile.parentFile, "$WRAP_FILE.tmp")
        java.io.FileOutputStream(tmp).use { out ->
            out.write(blob)
            out.fd.sync()
        }
        if (!tmp.renameTo(wrapFile)) {
            tmp.delete()
            Log.e(TAG, "dbkey.wrap rename failed")
            return null
        }
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
        // StrongBox first, then plain. The failure surfaces at generateKey()
        // — init() only stores the spec — so BOTH attempts must wrap the
        // generate call. (The Tauri original wraps only init(); its fallback
        // is dead code and StrongBox-failure devices silently run keyless.)
        val attempts = buildList {
            if (Build.VERSION.SDK_INT >= 28) add(true)
            add(false)
        }
        for (strongBox in attempts) {
            try {
                val builder = common()
                if (strongBox) builder.setIsStrongBoxBacked(true)
                generator.init(builder.build())
                return generator.generateKey()
            } catch (e: Exception) {
                if (e is StrongBoxUnavailableException || e is KeyPermanentlyInvalidatedException) {
                    Log.w(TAG, "strongbox kek attempt failed; falling back")
                    continue
                }
                Log.e(TAG, "kek generation failed", e)
                return null
            }
        }
        Log.e(TAG, "kek generation failed: no working keystore attempt")
        return null
    }

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            out[i * 2] = digits[(bytes[i].toInt() shr 4) and 0xf]
            out[i * 2 + 1] = digits[(bytes[i].toInt() shr 4) and 0xf]
        }
        return String(out)
    }
}
