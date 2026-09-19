package org.velta

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * In-app browsing for message links.
 *
 *  1. Chrome Custom Tab (any provider, discovered by service intent).
 *  2. A second, native android.webkit.WebView in a fullscreen overlay — used
 *     when the device has no Custom Tabs provider (e.g. only vivo.browser).
 *     A dedicated WebView is a top-level browsing context, so sites cannot
 *     refuse it with X-Frame-Options the way they can refuse the JS iframe
 *     overlay. No JS bridges are exposed to it; file/content access stays off.
 *
 * Called from Rust via JNI — see open_in_app_browser / open_webview_browser
 * in lib.rs.
 */
object InAppBrowser {
    private const val TAG = "VeltaIAB"

    // A bare CustomTabsIntent resolves like ACTION_VIEW: on devices whose
    // default browser has no Custom Tabs support (e.g. vivo.browser) the
    // link opened as a full browser task instead of an in-app tab. Resolve
    // an explicit provider instead; discovery is by service intent first
    // (the <queries> declaration makes every provider visible, whatever its
    // package name), androidx default-first resolution as fallback. Keep in
    // sync with the <queries> CustomTabsService declaration in
    // AndroidManifest.xml — without it package visibility hides every
    // provider on API 30+.
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

    // ---- second-WebView overlay ----
    private var activity: Activity? = null
    private var overlay: ViewGroup? = null
    private var webView: WebView? = null
    private var backCallback: OnBackPressedCallback? = null

    /** MainActivity hands itself over so the overlay can add views and own BACK. */
    @JvmStatic
    fun attach(act: Activity) {
        activity = act
        if (backCallback == null) {
            val cb = object : OnBackPressedCallback(false) {
                override fun handleOnBackPressed() { handleBack() }
            }
            backCallback = cb
            // Added after WryActivity's callback -> LIFO priority when enabled.
            (act as? androidx.activity.ComponentActivity)
                ?.onBackPressedDispatcher?.addCallback(act, cb)
        }
    }

    @JvmStatic
    fun detach() {
        Handler(Looper.getMainLooper()).post { closeWebView() }
        activity = null
        backCallback = null
    }

    private fun handleBack() {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack() else closeWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    @JvmStatic
    fun openWebView(appContext: Context, url: String) {
        val act = activity ?: return
        Handler(Looper.getMainLooper()).post {
            closeWebView()

            val dp = { v: Int ->
                TypedValue.applyDimension(
                    TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), act.resources.displayMetrics
                ).toInt()
            }

            // Bar: host + path on the left, open-external and close buttons right.
            val title = TextView(act).apply {
                text = hostOf(url)
                textSize = 14f
                setTextColor(Color.parseColor("#f2f2f5"))
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                setSingleLine()
            }
            val external = Button(act, null, 0).apply {
                text = "↗"
                textSize = 16f
                setTextColor(Color.parseColor("#f2f2f5"))
                setBackgroundColor(Color.TRANSPARENT)
                setPadding(dp(10), 0, dp(10), 0)
                contentDescription = "Open in browser"
                setOnClickListener {
                    try {
                        act.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    } catch (_: ActivityNotFoundException) { }
                }
            }
            val close = Button(act, null, 0).apply {
                text = "✕"
                textSize = 16f
                setTextColor(Color.parseColor("#f2f2f5"))
                setBackgroundColor(Color.TRANSPARENT)
                setPadding(dp(10), 0, dp(10), 0)
                contentDescription = "Close"
                setOnClickListener { closeWebView() }
            }
            val bar = LinearLayout(act).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundColor(Color.parseColor("#1c1c26"))
                setPadding(dp(12), dp(10), dp(4), dp(10))
                addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(external, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                addView(close, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            }

            val wv = WebView(act).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // Remote pages run in our process: no bridges, no file access.
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                webViewClient = object : WebViewClient() {
                    // Keep http(s) inside; hand everything else (mailto:, market:,
                    // intent:, file:) to the system instead of loading it here.
                    override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                        val scheme = request.url.scheme?.lowercase()
                        return !(scheme == "http" || scheme == "https")
                    }
                }
                webChromeClient = WebChromeClient()
                loadUrl(url)
            }

            val root = LinearLayout(act).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.parseColor("#0f0f14"))
                // Keep the bar out of the status bar on edge-to-edge devices.
                setOnApplyWindowInsetsListener { v, insets ->
                    @Suppress("DEPRECATION")
                    val top = insets.systemWindowInsetTop
                    bar.setPadding(bar.paddingLeft, dp(10) + top, bar.paddingRight, dp(10))
                    v.onApplyWindowInsets(insets)
                }
                addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                addView(wv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            }

            overlay = root
            webView = wv
            backCallback?.isEnabled = true
            act.addContentView(root, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            ))
        }
    }

    private fun closeWebView() {
        val root = overlay
        val wv = webView
        overlay = null
        webView = null
        backCallback?.isEnabled = false
        if (root != null) (root.parent as? ViewGroup)?.removeView(root)
        wv?.apply {
            (parent as? ViewGroup)?.removeView(this)
            stopLoading()
            destroy()
        }
    }

    private fun hostOf(url: String): String {
        return try { Uri.parse(url).host ?: url } catch (_: Exception) { url }
    }

    // ---- Custom Tabs (first choice) ----

    @JvmStatic
    fun open(context: Context, url: String): Boolean {
        val uri = Uri.parse(url)
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .build()
        // Same action string as the <queries> declaration in the manifest.
        val serviceIntent = Intent("android.support.customtabs.action.CustomTabsService")
        var provider: String? = null
        try {
            provider = context.packageManager
                .queryIntentServices(serviceIntent, 0)
                ?.firstOrNull()?.serviceInfo?.packageName
        } catch (_: Exception) { }
        if (provider == null) {
            try {
                provider = CustomTabsClient.getPackageName(context, CT_CANDIDATES, false)
            } catch (_: Exception) { }
        }
        provider?.let { intent.intent.setPackage(it) }
        android.util.Log.i(TAG, "provider=$provider")
        // Launch from the Activity when possible (proper back-stack, no
        // flags needed). From the application context Android requires
        // FLAG_ACTIVITY_NEW_TASK — modern androidx no longer adds it for us,
        // which used to crash the launch and drop us onto the WebView
        // overlay even with Chrome present.
        val launchContext: Context = activity ?: context
        if (activity == null) intent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            intent.launchUrl(launchContext, uri)
            return true
        } catch (e: Exception) {
            // Launch failures come in more flavors than
            // ActivityNotFoundException (disabled provider, vendor ROM
            // restrictions) — log which and report failure so the frontend
            // opens the in-app WebView overlay instead of blowing up.
            android.util.Log.w(TAG, "custom tab launch failed: ${e.javaClass.simpleName}: ${e.message}")
        }
        // No usable Custom Tabs provider on this device: report it and launch
        // nothing — the JS side opens the native WebView overlay next.
        return false
    }
}
