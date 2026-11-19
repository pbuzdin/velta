package org.velta.kmp.ui

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Mail HTML only. Do not copy [configureWebxdc]: that WebView injects
 * `window.webxdc` and a JS bridge into the core.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal actual fun HtmlBody(model: AppModel, screen: AppModel.Screen.Html, modifier: Modifier) {
    val dark = Velta.tokens.isDark
    var page by remember(screen.path, screen.html, dark) { mutableStateOf<String?>(null) }
    LaunchedEffect(screen.path, screen.html, dark) {
        val raw = screen.path?.let { path ->
            withContext(Dispatchers.IO) {
                runCatching { java.io.File(path).readText() }.getOrNull()
            }
        } ?: screen.html
        if (model.screen != screen) return@LaunchedEffect
        if (raw.isBlank()) {
            model.showToast(L.t("The full version isn't available for this message"))
            model.closeHtml()
            return@LaunchedEffect
        }
        page = prepareHtmlView(raw, dark)
    }
    val body = page ?: return
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                configureHtmlView(this, model)
                loadDataWithBaseURL(HTML_VIEW_ORIGIN, body, "text/html", "utf-8", null)
            }
        },
        onRelease = { it.destroy() },
    )
}

@Suppress("DEPRECATION")
private fun configureHtmlView(web: WebView, model: AppModel) {
    with(web.settings) {
        javaScriptEnabled = false
        javaScriptCanOpenWindowsAutomatically = false
        domStorageEnabled = false
        databaseEnabled = false
        allowFileAccess = false
        allowContentAccess = false
        allowFileAccessFromFileURLs = false
        allowUniversalAccessFromFileURLs = false
        blockNetworkLoads = true
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        setGeolocationEnabled(false)
    }
    web.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (htmlLinkLeavesViewer(uri?.scheme, request.hasGesture())) {
                model.openHttp?.invoke(uri.toString())
            }
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (htmlSubresourceAllowed(uri?.scheme, uri?.host)) return null
            return WebResourceResponse(
                "text/plain",
                "utf-8",
                403,
                "Blocked",
                emptyMap(),
                java.io.ByteArrayInputStream(ByteArray(0)),
            )
        }
    }
}
