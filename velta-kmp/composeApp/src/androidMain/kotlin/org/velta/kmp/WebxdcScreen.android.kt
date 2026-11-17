package org.velta.kmp

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.runBlocking
import org.velta.kmp.ui.AppModel

/**
 * P3a webxdc runtime: the archive is served per-file from the core
 * (`get_webxdc_blob`, base64) over the virtual host `https://xdc.local/<msgId>/`,
 * and the app's `window.webxdc` is injected at document start backed by a
 * blocking JS bridge (`WebxdcBridge.request`) — apps that ship the official
 * webxdc.js detect the existing API and use it directly, no iframe needed.
 * Realtime channels and the Velta call bridge land with P3b.
 */
@Composable
actual fun WebxdcScreen(model: AppModel, screen: AppModel.Screen.Webxdc) {
    val context = LocalContext.current
    AndroidView(
        modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars),
        factory = { ctx ->
            WebView(ctx).apply {
                configureWebxdc(this, model, screen.msgId)
                loadUrl("https://xdc.local/${screen.msgId}/")
            }
        },
        onRelease = { it.destroy() },
    )
}

@SuppressLint("SetJavaScriptEnabled")
private fun configureWebxdc(web: WebView, model: AppModel, msgId: Long) {
    with(web.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        allowFileAccess = false
        databaseEnabled = false
    }
    web.addJavascriptInterface(WebxdcBridge(model, msgId), "AndroidWebxdcBridge")
    web.webViewClient = object : android.webkit.WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val url = request.url
            if (url.host != "xdc.local") return null
            val segments = url.pathSegments
            if (segments.isEmpty() || segments.first() != msgId.toString()) return null
            val path = segments.drop(1).joinToString("/").ifEmpty { "index.html" }
            val b64 = runBlocking {
                runCatching { model.callsWebxdcBlob(msgId, path) }.getOrNull()
            } ?: return notFound()
            val bytes = try {
                android.util.Base64.decode(b64, android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
            } catch (_: IllegalArgumentException) {
                return notFound()
            }
            return WebResourceResponse(mimeFor(path), "utf-8", java.io.ByteArrayInputStream(bytes))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Apps open external links outside the app canvas (web parity).
            val url = request.url
            if (url.host != "xdc.local") {
                try {
                    view.context.startActivity(
                        android.content.Intent(android.content.Intent.ACTION_VIEW, url),
                    )
                } catch (_: android.content.ActivityNotFoundException) {}
                return true
            }
            return false
        }
    }
}

private fun notFound(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, java.io.ByteArrayInputStream(ByteArray(0)))

private fun mimeFor(path: String): String {
    val ext = path.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "json", "map" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "svg" -> "image/svg+xml"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "wasm" -> "application/wasm"
        "txt" -> "text/plain"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "wav" -> "audio/wav"
        "ogg", "opus" -> "audio/ogg"
        "mp4" -> "video/mp4"
        "ttf" -> "font/ttf"
        "otf" -> "font/otf"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "toml" -> "text/plain"
        else -> "application/octet-stream"
    }
}

/** JS-facing bridge: the injected `window.webxdc` serializes every call to
 *  one `request(json)` (blocking the WebView's JS thread is the standard
 *  pattern — the methods answer from the core in microseconds). */
private class WebxdcBridge(private val model: AppModel, private val msgId: Long) {

    @androidx.annotation.JavascriptInterface
    fun request(json: String): String {
        val response = runBlocking {
            runCatching { handle(json) }.getOrElse {
                kotlinx.serialization.json.buildJsonObject {
                    put("error", kotlinx.serialization.json.JsonPrimitive(it.message ?: it.toString()))
                }
            }
        }
        return response.toString()
    }

    private suspend fun handle(json: String): kotlinx.serialization.json.JsonObject {
        val req = kotlinx.serialization.json.Json.parseToJsonElement(json) as? kotlinx.serialization.json.JsonObject
            ?: error("bad request")
        val method = (req["method"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: error("no method")
        val params = req["params"] as? kotlinx.serialization.json.JsonObject ?: kotlinx.serialization.json.JsonObject(emptyMap())
        fun str(k: String): String = (params[k] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
        fun long(k: String): Long = str(k).toLongOrNull() ?: 0L
        val core = model.callCore() ?: error("no core")
        val acc = model.callAccountId() ?: error("no account")
        return when (method) {
            "getInfo" -> core.getWebxdcInfo(acc, msgId)
                ?: error("app info unavailable")
            "getStatusUpdates" -> core.getWebxdcStatusUpdates(acc, msgId, long("serial"))
                ?: kotlinx.serialization.json.buildJsonObject {
                    put("updates", kotlinx.serialization.json.JsonArray(emptyList()))
                    put("serial", kotlinx.serialization.json.JsonPrimitive(0L))
                }
            "sendUpdate" -> {
                val update = str("update")
                require(update.isNotEmpty()) { "empty update" }
                core.sendWebxdcStatusUpdate(acc, msgId, update, str("description"))
                kotlinx.serialization.json.buildJsonObject { put("done", kotlinx.serialization.json.JsonPrimitive(true)) }
            }
            else -> kotlinx.serialization.json.buildJsonObject {
                put("error", kotlinx.serialization.json.JsonPrimitive("method not available in this build: $method"))
            }
        }
    }
}
