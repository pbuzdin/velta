package org.velta

import android.content.Context
import org.json.JSONObject

// Drawer "Use background connection" as Rust stores it (notify-prefs.json,
// key use_bg_connection; missing file or key = on).
object BgPrefs {
    @JvmStatic
    fun backgroundConnectionEnabled(context: Context): Boolean =
        try {
            val text = AppFiles.read(context, "notify-prefs.json")
            if (text != null) {
                val obj = JSONObject(text)
                if (obj.has("use_bg_connection")) obj.getBoolean("use_bg_connection") else true
            } else true
        } catch (_: Exception) { true }
}
