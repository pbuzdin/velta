package org.velta

import android.content.Context
import java.io.File

// State files Rust writes (notify-prefs.json, scheduled.json). Tauri's
// app-local data dir on Android is Context.getDataDir(), not filesDir, so
// read dataDir first and fall back to filesDir (older builds / comments
// assumed filesDir).
object AppFiles {
    @JvmStatic
    fun dataDir(context: Context): File = context.dataDir

    @JvmStatic
    fun read(context: Context, name: String): String? {
        for (dir in listOf(dataDir(context), context.filesDir)) {
            val f = File(dir, name)
            try {
                if (f.exists()) return f.readText()
            } catch (_: Exception) {
            }
        }
        return null
    }
}
