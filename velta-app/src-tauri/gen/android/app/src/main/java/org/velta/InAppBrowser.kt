package org.velta

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Chrome Custom Tabs launcher for message links (Telegram-style in-app
 * browsing). Called from Rust via JNI — see open_in_app_browser in lib.rs.
 */
object InAppBrowser {
    // A bare CustomTabsIntent resolves like ACTION_VIEW: on devices whose
    // DEFAULT browser has no Custom Tabs support (e.g. vivo.browser) the
    // link opens as a full browser task instead of an in-app tab — no error,
    // so no fallback ever fired. Resolve an explicit provider instead; the
    // default browser wins when it supports Custom Tabs (ignoreDefault=false),
    // otherwise the first installed candidate. Keep in sync with the
    // <queries> CustomTabsService declaration in AndroidManifest.xml —
    // without it package visibility hides every provider on API 30+.
    private val CT_CANDIDATES = listOf(
        "com.android.chrome",
        "com.chrome.beta",
        "com.chrome.dev",
        "com.chrome.canary",
        "com.google.android.apps.chrome",
        "org.mozilla.firefox",
        "org.mozilla.fenix",
        "com.microsoft.emmx",
        "com.sec.android.app.sbrowser",
        "com.brave.browser",
        "com.opera.browser",
    )

    @JvmStatic
    fun open(context: Context, url: String) {
        val uri = Uri.parse(url)
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .build()
        try {
            CustomTabsClient.getPackageName(context, CT_CANDIDATES, false)
                ?.let { intent.intent.setPackage(it) }
        } catch (_: Exception) {
            // Package visibility or PM hiccups must not block the launch —
            // fall through to the untargeted intent below.
        }
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
