package org.velta

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Chrome Custom Tabs launcher for message links (Telegram-style in-app
 * browsing). Called from Rust via JNI — see open_in_app_browser in lib.rs.
 */
object InAppBrowser {
    @JvmStatic
    fun open(context: Context, url: String) {
        val uri = Uri.parse(url)
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .build()
        try {
            intent.launchUrl(context, uri)
            return
        } catch (_: ActivityNotFoundException) {
            // No Custom Tabs provider and no browser resolved the session
            // intent — launchUrl does NOT fall back on its own.
        }
        // Last resort: the default browser via plain ACTION_VIEW. App context
        // is not an Activity, so a new task flag is required.
        context.startActivity(
            Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
