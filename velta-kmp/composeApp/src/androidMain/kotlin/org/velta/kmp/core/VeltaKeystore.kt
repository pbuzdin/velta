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
    private const val BIO_KEK_ALIAS = "velta_kek_bio"
    private const val BIO2_KEK_ALIAS = "velta_kek_bio2"
    private const val BIO_V_TIMED: Byte = 1
    private const val BIO_V_PER_USE: Byte = 2
    private const val BIO_FILE = "dbkey.bio"
    private const val PIN_FILE = "dbkey.pin.wrap"
    private const val GCM_TAG_BITS = 128

    fun pinFile(context: Context): File = File(context.noBackupFilesDir, PIN_FILE)

    fun deletePlainWrap(context: Context) {
        File(context.noBackupFilesDir, WRAP_FILE).delete()
    }

    /** PIN removal: the DEK hex back into the plain wrap. */
    fun storePlainWrapHex(context: Context, dekHex: String): Boolean {
        val dek = decodeHex(dekHex)
        if (dek == null || dek.size != 32) return false
        return storePlainWrap(context, dek)
    }

    @JvmStatic
    fun getOrCreateDek(context: Context): String? {
        return try {
            // App lock (phase 4 port): when the lock is on, the DEK only
            // exists in the bio wrap and opens after a successful unlock
            // (VeltaUnlock) — never silently here, and never a fresh key
            // over locked databases.
            if (VeltaLock.on(context)) {
                Log.i(TAG, "app lock is on; the DEK needs the unlock flow")
                return null
            }
            // The PIN wrap replaced the plain wrap. Never mint a fresh key over it.
            if (pinFile(context).exists()) {
                Log.i(TAG, "app-lock PIN is on; the DEK needs the unlock flow")
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
            null
        }
    }

    // ---- App lock (phase 4 port): the bio wrap + enable/disable. ----

    /** Which bio wrap is on disk: 0 none, 1 timed-window key (older builds), 2 per-use key. */
    @JvmStatic
    fun bioWrapVersion(context: Context): Int {
        val f = VeltaLock.bioFile(context)
        if (!f.exists()) return 0
        return try {
            f.inputStream().use { it.read() }.coerceAtLeast(0)
        } catch (e: Exception) {
            0
        }
    }

    // One authenticated cipher / DEK is handed from the prompt callback to the
    // platform call the model makes right after it; each is taken once.
    @Volatile private var stagedCipher: Cipher? = null
    @Volatile private var stagedDek: String? = null

    @JvmStatic
    fun stageCipher(cipher: Cipher?) { stagedCipher = cipher }

    @JvmStatic
    fun takeCipher(): Cipher? = stagedCipher.also { stagedCipher = null }

    @JvmStatic
    fun stageDek(dekHex: String?) { stagedDek = dekHex }

    @JvmStatic
    fun takeDek(): String? = stagedDek.also { stagedDek = null }

    /**
     * Per-use KEK: the key can only be used inside a BiometricPrompt that
     * carries a CryptoObject for it, so every unwrap needs a fresh
     * authentication (strong biometric or device credential). A newly
     * enrolled biometric invalidates it (KeyPermanentlyInvalidatedException).
     */
    private fun bioKekPerUse(create: Boolean): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(BIO2_KEK_ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        for (invalidateOnEnroll in listOf(true, false)) {
            try {
                val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                val builder = KeyGenParameterSpec.Builder(
                    BIO2_KEK_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUserAuthenticationRequired(true)
                    .setInvalidatedByBiometricEnrollment(invalidateOnEnroll)
                if (Build.VERSION.SDK_INT >= 30) {
                    builder.setUserAuthenticationParameters(
                        0,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                } else {
                    builder.setUserAuthenticationValidityDurationSeconds(-1)
                }
                generator.init(builder.build())
                return generator.generateKey()
            } catch (e: Exception) {
                Log.w(TAG, "per-use bio kek generation failed (invalidateOnEnroll=$invalidateOnEnroll)", e)
            }
        }
        return null
    }

    /** The cipher to put in the prompt's CryptoObject when turning the lock on. */
    @JvmStatic
    fun enableCipher(): Cipher? = try {
        val kek = bioKekPerUse(create = true) ?: return null
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, kek) }
    } catch (e: Exception) {
        Log.e(TAG, "enable cipher failed", e)
        null
    }

    /**
     * The cipher for the unlock prompt's CryptoObject (per-use wrap only).
     * Throws [KeyPermanentlyInvalidatedException] when the biometric set
     * changed and the key is gone for good.
     */
    @JvmStatic
    fun unlockCipher(context: Context): Cipher? {
        val blob = try { VeltaLock.bioFile(context).readBytes() } catch (e: Exception) { return null }
        if (blob.size < 14 || blob[0] != BIO_V_PER_USE) return null
        val kek = bioKekPerUse(create = false) ?: return null
        return Cipher.getInstance("AES/GCM/NoPadding")
            .apply { init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(GCM_TAG_BITS, blob.copyOfRange(1, 13))) }
    }

    /**
     * The biometric set changed and the per-use key is gone. With an
     * app-lock PIN on, drop the dead bio wrap so the PIN is the lock root
     * (the lock can be turned on again afterwards, which re-wraps under a
     * fresh key). Returns whether the PIN took over.
     */
    @JvmStatic
    fun dropInvalidatedBio(context: Context): Boolean {
        if (!pinFile(context).exists()) return false
        VeltaLock.bioFile(context).delete()
        VeltaLock.setOn(context, false)
        deleteBioKeys()
        Log.w(TAG, "bio key invalidated; the PIN is the lock root now")
        return true
    }

    private fun deleteBioKeys() {
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            ks.deleteEntry(BIO2_KEK_ALIAS)
            ks.deleteEntry(BIO_KEK_ALIAS)
        } catch (e: Exception) {
            Log.w(TAG, "bio key cleanup failed", e)
        }
    }

    /**
     * Auth-window KEK of older builds (a successful prompt opened a 30 s
     * window). Kept only to read wraps those builds wrote.
     */
    private fun bioKek(): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(BIO_KEK_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore",
        )
        try {
            val builder = KeyGenParameterSpec.Builder(
                BIO_KEK_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
            if (Build.VERSION.SDK_INT >= 30) {
                builder.setUserAuthenticationParameters(
                    30,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            } else {
                builder.setUserAuthenticationValidityDurationSeconds(30)
            }
            generator.init(builder.build())
            return generator.generateKey()
        } catch (e: Exception) {
            Log.e(TAG, "bio kek generation failed", e)
            return null
        }
    }

    /**
     * Enable the app lock: wrap the current DEK into the bio wrap with
     * [cipher] — the one [enableCipher] made, authenticated by a prompt that
     * carried it as its CryptoObject — and flip the flag. The plain wrap is
     * removed: while the lock is on, the DEK must not be obtainable without
     * authentication.
     */
    @JvmStatic
    fun enableAppLock(context: Context, dekHex: String, cipher: Cipher): Boolean {
        return try {
            val dek = dekHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            val iv = cipher.iv
            val encrypted = cipher.doFinal(dek)
            val blob = ByteArray(1 + iv.size + encrypted.size)
            blob[0] = BIO_V_PER_USE
            iv.copyInto(blob, 1)
            encrypted.copyInto(blob, 1 + iv.size)
            val bioFile = VeltaLock.bioFile(context)
            val tmp = File(bioFile.parentFile, "$BIO_FILE.tmp")
            java.io.FileOutputStream(tmp).use { out ->
                out.write(blob)
                out.fd.sync()
            }
            if (!tmp.renameTo(bioFile)) {
                tmp.delete()
                Log.e(TAG, "dbkey.bio rename failed")
                return false
            }
            // The wrap file is the gate from here (#259 step 3) — flip the
            // pref mirror BEFORE removing the plain wrap.
            VeltaLock.setOn(context, true)
            File(context.noBackupFilesDir, WRAP_FILE).delete()
            // The timed-window key of older builds has no wrap left to open.
            try {
                KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(BIO_KEK_ALIAS)
            } catch (e: Exception) {
                Log.w(TAG, "old bio key cleanup failed", e)
            }
            Log.i(TAG, "app lock enabled")
            true
        } catch (e: Exception) {
            Log.e(TAG, "app lock enable failed", e)
            false
        }
    }

    /**
     * Unlock: unwrap the DEK from the bio wrap. A per-use wrap needs
     * [cipher], the one [unlockCipher] made and a prompt authenticated. A
     * wrap from older builds ignores it and must be called inside the 30 s
     * window a successful prompt opens (otherwise the Keystore throws
     * UserNotAuthenticatedException and the caller re-prompts).
     */
    @JvmStatic
    fun unlockDek(context: Context, cipher: Cipher? = null): String? = try {
        val bioFile = VeltaLock.bioFile(context)
        val blob = bioFile.readBytes()
        if (blob.size < 14) {
            Log.e(TAG, "unknown dbkey.bio format")
            null
        } else if (blob[0] == BIO_V_PER_USE) {
            val c = cipher ?: return null
            hex(c.doFinal(blob, 13, blob.size - 13))
        } else if (blob[0] == BIO_V_TIMED) {
            val kek = bioKek() ?: return null
            val iv = blob.copyOfRange(1, 13)
            val legacy = Cipher.getInstance("AES/GCM/NoPadding")
            legacy.init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(GCM_TAG_BITS, iv))
            hex(legacy.doFinal(blob, 13, blob.size - 13))
        } else {
            Log.e(TAG, "unknown dbkey.bio format")
            null
        }
    } catch (e: Exception) {
        Log.e(TAG, "app lock unwrap failed", e)
        null
    }

    /** Disable the app lock: restore the plain wrap, drop the bio wrap. */
    @JvmStatic
    fun disableAppLock(context: Context, dekHex: String): Boolean {
        return try {
            val ok = storePlainWrap(context, dekHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
            if (ok) {
                VeltaLock.bioFile(context).delete()
                VeltaLock.setOn(context, false)
                deleteBioKeys()
                Log.i(TAG, "app lock disabled")
            }
            ok
        } catch (e: Exception) {
            Log.e(TAG, "app lock disable failed", e)
            false
        }
    }

    private fun storePlainWrap(context: Context, dek: ByteArray): Boolean {
        return try {
            val kek = kek() ?: return false
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, kek)
            val iv = cipher.iv
            val encrypted = cipher.doFinal(dek)
            val blob = ByteArray(1 + iv.size + encrypted.size)
            blob[0] = 1
            iv.copyInto(blob, 1)
            encrypted.copyInto(blob, 1 + iv.size)
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
