package org.velta

import android.content.Context
import android.content.Intent

// #37: native "Share a link" for the QR screen. The WebView has no Web Share
// API, so the page asks the shell (share_text in lib.rs, JNI) to show the
// system chooser for a plain-text payload (the invite link).
object Share {
    @JvmStatic
    fun text(context: Context, text: String, title: String): Boolean {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        // The stored context is the application context: starting an activity
        // from it needs NEW_TASK.
        val chooser = Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(chooser)
            true
        } catch (e: Exception) {
            false
        }
    }
}
