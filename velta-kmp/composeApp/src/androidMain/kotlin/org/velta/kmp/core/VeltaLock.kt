package org.velta.kmp.core

import android.content.Context
import java.io.File

/**
 * App-lock state (#178 phase 4 port). The gate is the bio wrap FILE itself
 * (Tauri VeltaLock parity, #259 step 3): a flag flipped after the wrap
 * write leaves a crash window where `dbkey.wrap` is gone, `dbkey.bio` is
 * present and the flag is off — the next boot would mint a fresh DEK over
 * databases it can no longer open. With the file as the gate, the lock is
 * on the instant the wrap exists. The pref flag stays as a UI mirror; the
 * DEK is only obtainable through the unlock flow while the wrap exists,
 * and `VeltaKeystore.getOrCreateDek` returns null then. An app-lock PIN
 * (`dbkey.pin.wrap`, Argon2id) can sit beside this biometric /
 * device-credential lock. See `PinWrap`.
 */
object VeltaLock {
    private const val PREFS = "velta_lock"
    private const val KEY_ON = "app_lock_on"
    private const val BIO_FILE = "dbkey.bio"

    fun on(context: Context): Boolean = bioFile(context).exists()

    fun setOn(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_ON, on).apply()
    }

    fun bioFile(context: Context): File = File(context.noBackupFilesDir, BIO_FILE)
}
