package org.velta

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Chrome Custom Tabs launcher for message links (Telegram-style in-app
 * browsing). CustomTabsIntent falls back to the default browser
 * automatically when no Custom Tabs provider (Chrome) is installed.
 * Called from Rust via JNI — see open_in_app_browser in lib.rs.
 */
object InAppBrowser {
    @JvmStatic
    fun open(context: Context, url: String) {
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .build()
        intent.launchUrl(context, Uri.parse(url))
    }
}
