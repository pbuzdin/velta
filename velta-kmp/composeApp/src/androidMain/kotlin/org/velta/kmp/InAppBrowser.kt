package org.velta.kmp

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import org.velta.kmp.ui.L
import org.velta.kmp.ui.pickCustomTabProvider

/**
 * Message links stay inside Velta (stable InAppBrowser).
 * Custom Tab when a provider exists; otherwise a second WebView with no
 * JS bridges and no file access. A bare ACTION_VIEW leaves the app.
 */
object InAppBrowser {
    private val candidates = listOf(
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

    private var activity: ComponentActivity? = null
    private var overlay: ViewGroup? = null
    private var webView: WebView? = null
    private var backCallback: OnBackPressedCallback? = null

    fun attach(act: ComponentActivity) {
        if (activity === act) return
        activity = act
        val cb = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                val wv = webView
                if (wv != null && wv.canGoBack()) wv.goBack() else closeWebView()
            }
        }
        backCallback = cb
        act.onBackPressedDispatcher.addCallback(act, cb)
    }

    /** No-op when a newer activity has already attached (rotation). */
    fun detach(act: Activity) {
        if (activity !== act) return
        closeWebView()
        activity = null
        backCallback = null
    }

    fun open(url: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { open(url) }
            return
        }
        val act = activity ?: return
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return
        val provider = providerPackage(act)
        if (provider != null) {
            val intent = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .setShareState(CustomTabsIntent.SHARE_STATE_ON)
                .build()
            intent.intent.setPackage(provider)
            try {
                intent.launchUrl(act, uri)
                return
            } catch (_: Exception) {
                // Disabled provider or a ROM that refuses the tab.
            }
        }
        openWebView(act, url)
    }

    private fun providerPackage(act: Activity): String? {
        val pm = act.packageManager
        val serviceIntent = Intent("android.support.customtabs.action.CustomTabsService")
        val services = try {
            pm.queryIntentServices(serviceIntent, 0).orEmpty()
        } catch (_: Exception) {
            emptyList()
        }
        val packages = services.map { it.serviceInfo.packageName }
        val defaultBrowser = try {
            pm.resolveActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("https://www.example.org")),
                PackageManager.MATCH_DEFAULT_ONLY,
            )?.activityInfo?.packageName
        } catch (_: Exception) {
            null
        }
        val candidate = try {
            CustomTabsClient.getPackageName(act, candidates, false)
        } catch (_: Exception) {
            null
        }
        return pickCustomTabProvider(defaultBrowser, packages, candidate)
    }

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun openWebView(act: ComponentActivity, url: String) {
        closeWebView()
        val dp = { v: Int ->
            TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), act.resources.displayMetrics,
            ).toInt()
        }
        val title = TextView(act).apply {
            text = Uri.parse(url).host ?: url
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
                    act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: ActivityNotFoundException) {
                }
            }
        }
        val close = Button(act, null, 0).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.parseColor("#f2f2f5"))
            setBackgroundColor(Color.TRANSPARENT)
            setPadding(dp(10), 0, dp(10), 0)
            contentDescription = L.t("Close")
            setOnClickListener { closeWebView() }
        }
        val bar = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1c1c26"))
            setPadding(dp(12), dp(10), dp(4), dp(10))
            addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(external)
            addView(close)
        }
        val wv = WebView(act).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val next = request.url.scheme?.lowercase()
                    if (next == "http" || next == "https") return false
                    if (next == "mailto" || next == "tel" || next == "market") {
                        try {
                            act.startActivity(
                                Intent(Intent.ACTION_VIEW, request.url)
                                    .addCategory(Intent.CATEGORY_BROWSABLE),
                            )
                        } catch (_: Exception) {
                        }
                    }
                    return true
                }
            }
            webChromeClient = WebChromeClient()
            loadUrl(url)
        }
        val root = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0f0f14"))
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
        act.addContentView(
            root,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
    }

    private fun closeWebView() {
        val root = overlay
        val wv = webView
        overlay = null
        webView = null
        backCallback?.isEnabled = false
        if (root != null) (root.parent as? ViewGroup)?.removeView(root)
        wv?.apply {
            stopLoading()
            destroy()
        }
    }
}
