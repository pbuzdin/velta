package org.velta

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
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
    // #178 phase 4: the Argon2id(PIN) wrap written by Rust (lib.rs
    // android_pin_set); while it exists the PIN is the key root.
    private const val PIN_WRAP_FILE = "dbkey.pin.wrap"
    private const val GCM_TAG_BITS = 128

    /** Why the last getOrCreateDek/readDek gave null (no key material). */
    @Volatile
    @JvmStatic
    var lastError: String? = null

    /** Rust: where the PIN wrap lives (never backed up). */
    @JvmStatic
    fun noBackupDir(context: Context): String = context.noBackupFilesDir.absolutePath

    @JvmStatic
    fun pinOn(context: Context): Boolean = File(context.noBackupFilesDir, PIN_WRAP_FILE).exists()

    /** Rust (PIN removal): the DEK hex back into the plain wrap. */
    @JvmStatic
    fun storePlainWrapHex(context: Context, dekHex: String): Boolean {
        if (dekHex.length != 64) return false
        val dek = ByteArray(32) { i -> ((Character.digit(dekHex[2 * i], 16) shl 4) or Character.digit(dekHex[2 * i + 1], 16)).toByte() }
        return storePlainWrap(context, dek)
    }

    /** The plain wrap exists: database encryption is set up on this device. */
    @JvmStatic
    fun hasPlainWrap(context: Context): Boolean = File(context.noBackupFilesDir, WRAP_FILE).exists()

    /**
     * #178 phase 4 (enable flow): the EXISTING DEK, never a fresh one — a
     * new key here would not match databases the core opened keyless.
     */
    @JvmStatic
    fun readDek(context: Context): String? {
        lastError = null
        val wrapFile = File(context.noBackupFilesDir, WRAP_FILE)
        if (!wrapFile.exists()) {
            lastError = "no-key: dbkey.wrap missing"
            return null
        }
        return try {
            unwrap(wrapFile) ?: run {
                if (lastError == null) lastError = "dbkey.wrap undecryptable"
                null
            }
        } catch (e: Exception) {
            lastError = "keystore: ${e.javaClass.simpleName}: ${e.message}"
            null
        }
    }

    @JvmStatic
    fun getOrCreateDek(context: Context): String? {
        lastError = null
        return try {
            // #178 phase 4: with the biometric app lock on, the DEK only
            // opens after a successful BiometricPrompt (VeltaLock) — never
            // silently here, and never a fresh key over locked databases.
            if (VeltaLock.on(context)) {
                Log.i(TAG, "biometric app lock is on; the DEK needs the activity unlock")
                lastError = "app-locked (biometric)"
                return null
            }
            // Same for the app-lock PIN: never a fresh key over its databases.
            if (pinOn(context)) {
                lastError = "app-locked (PIN)"
                return null
            }
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
            lastError = "keystore: ${e.javaClass.simpleName}: ${e.message}"
            null
        }
    }

    /** #178 phase 4 (disable flow): write the DEK back into the plain wrap. */
    @JvmStatic
    fun storePlainWrap(context: Context, dek: ByteArray): Boolean {
        return try {
            val kek = kek() ?: return false
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, kek)
            val iv = cipher.iv
            val blob = ByteArray(1 + iv.size + dek.size)
            blob[0] = 1
            iv.copyInto(blob, 1)
            cipher.doFinal(dek).copyInto(blob, 1 + iv.size)
            val wrapFile = File(context.noBackupFilesDir, WRAP_FILE)
            val tmp = File(wrapFile.parentFile, "$WRAP_FILE.tmp")
            java.io.FileOutputStream(tmp).use { out ->
                out.write(blob)
                out.fd.sync()
            }
            tmp.renameTo(wrapFile)
        } catch (e: Exception) {
            Log.e(TAG, "plain wrap restore failed", e)
            false
        }
    }

    /** #178 phase 4 (enable flow): drop the plain wrap once the auth wrap exists. */
    @JvmStatic
    fun deletePlainWrap(context: Context) {
        File(context.noBackupFilesDir, WRAP_FILE).delete()
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
        Log.e(TAG, "dbkey.wrap unwrap failed", e)
        lastError = "unwrap: ${e.javaClass.simpleName}: ${e.message}"
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
        // StrongBox first; StrongBoxUnavailableException surfaces from
        // generateKey() (not init()) on devices without a StrongBox, so the
        // fallback has to wrap both calls — otherwise every start ran keyless.
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                generator.init(common().setIsStrongBoxBacked(true).build())
                return generator.generateKey()
            } catch (e: Exception) {
                Log.w(TAG, "StrongBox KEK unavailable (${e.javaClass.simpleName}); using the TEE")
            }
        }
        return try {
            generator.init(common().build())
            generator.generateKey()
        } catch (e: Exception) {
            Log.e(TAG, "kek generation failed", e)
            lastError = "kek generation: ${e.javaClass.simpleName}: ${e.message}"
            null
        }
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
