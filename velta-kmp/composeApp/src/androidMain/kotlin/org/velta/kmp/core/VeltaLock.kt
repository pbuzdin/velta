package org.velta.kmp.core

import android.content.Context
import java.io.File

/**
 * App-lock state (#178 phase 4 port). The flag lives in SharedPreferences;
 * when it is on, the DEK is only available inside the bio wrap
 * (`dbkey.bio`), `VeltaKeystore.getOrCreateDek` returns null (the core is
 * never started keyless over locked databases), and the UI runs the
 * unlock flow. A PIN fallback (Argon2id wrap, the Tauri phase-4 shape) is
 * a later slice — this one is biometric / device-credential only.
 */
object VeltaLock {
    private const val PREFS = "velta_lock"
    private const val KEY_ON = "app_lock_on"
    private const val BIO_FILE = "dbkey.bio"

    fun on(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ON, false)

    fun setOn(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_ON, on).apply()
    }

    fun bioFile(context: Context): File = File(context.noBackupFilesDir, BIO_FILE)
}
