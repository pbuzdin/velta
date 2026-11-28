package org.velta.kmp.ui

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.runBlocking
import org.velta.kmp.ui.AppModel

/**
 * P3a webxdc runtime: the archive is served per-file from the core
 * (`get_webxdc_blob`, base64) over a per-instance virtual host `https://a<account>m<msgId>.xdc.local/`
 * (own origin, own storage; only that host is served, see WebxdcRules.kt),
 * and the app's `window.webxdc` is injected at document start backed by a
 * blocking JS bridge (`WebxdcBridge.request`) — apps that ship the official
 * webxdc.js detect the existing API and use it directly, no iframe needed.
 * Realtime channels and the Velta call bridge land with P3b.
 */
@Composable
actual fun WebxdcScreen(model: AppModel, screen: AppModel.Screen.Webxdc) {
    val context = LocalContext.current
    // One origin per app instance (account + message): storage is not shared.
    val host = remember(screen.msgId) { webxdcHost(model.callAccountId() ?: 0L, screen.msgId) }
    AndroidView(
        modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars),
        factory = { ctx ->
            WebView(ctx).apply {
                configureWebxdc(this, model, screen.msgId, host)
                model.webxdcRealtimeSink = { dataMsgId, data ->
                    if (dataMsgId == screen.msgId) {
                        post {
                            evaluateJavascript(
                                "window.webxdc && window.webxdc._onRealtimeData(" + data.joinToString(",") + ")",
                                null,
                            )
                        }
                    }
                }
                loadUrl("https://$host/")
            }
        },
        onRelease = {
            model.webxdcRealtimeSink = null
            model.webxdcJoined = false
            it.destroy()
        },
    )
}

    private const val INJECTED_API = """
<script>
(function () {
  if (window.webxdc) return;
  function rpc(method, params) {
    var raw = AndroidWebxdcBridge.request(JSON.stringify({ method: method, params: params || {} }));
    var out = JSON.parse(raw);
    if (out && out.error) throw new Error(out.error);
    return out;
  }
  var serial = 0;
  var updateListener = null;
  var info = null;
  var realtimeChannel = null;
  var interval = null;
  window.webxdc = {
    getInfo: function () {
      if (!info) info = rpc("getInfo");
      return info;
    },
    sendUpdate: function (update, description) {
      rpc("sendUpdate", { update: typeof update === "string" ? update : JSON.stringify(update), description: description || "" });
    },
    getStatusUpdates: function (lastKnownSerial) {
      return rpc("getStatusUpdates", { serial: lastKnownSerial || 0 });
    },
    setUpdateListener: function (cb, serial) {
      updateListener = cb;
      if (typeof serial === "number") this._serial = serial;
      if (interval) clearInterval(interval);
      var api = this;
      interval = setInterval(function () {
        try {
          var r = api.getStatusUpdates(api._serial);
          if (r.serial > api._serial) {
            r.updates.forEach(function (u) { if (updateListener) updateListener(u); });
            api._serial = r.serial;
          }
        } catch (e) {}
      }, Math.max(200, (this.getInfo() && this.getInfo().sendUpdateInterval) || 1000));
    },
    getAllUpdates: function () {
      return rpc("getAllUpdates").updates;
    },
    joinRealtimeChannel: function () {
      rpc("realtimeJoin");
      realtimeChannel = {
        onmessage: null,
        send: function (data) {
          var bytes = typeof data === "string" ? Array.from(new TextEncoder().encode(data)) : Array.from(new Uint8Array(data));
          AndroidWebxdcBridge.request(JSON.stringify({ method: "realtimeSend", params: { data: bytes } }));
        },
        leave: function () {
          AndroidWebxdcBridge.request(JSON.stringify({ method: "realtimeLeave", params: {} }));
        },
      };
      return realtimeChannel;
    },
    sendRealtimeData: function (data) { if (realtimeChannel) realtimeChannel.send(data); },
    leaveRealtimeChannel: function () { if (realtimeChannel) realtimeChannel.leave(); },
    // Host -> app delivery (WebxdcRealtimeData events from the core).
    _onRealtimeData: function () {
      if (!realtimeChannel || !realtimeChannel.onmessage) return;
      var arr = Array.prototype.slice.call(arguments);
      realtimeChannel.onmessage({ data: new Uint8Array(arr) });
    },
    sendToChat: function (message) {
      return Promise.reject(new Error("sendToChat is not available in this build"));
    },
    selfAddr: "",
    selfName: "",
  };
})();
</script>
"""

@SuppressLint("SetJavaScriptEnabled")
private fun configureWebxdc(web: WebView, model: AppModel, msgId: Long, host: String) {
    with(web.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        allowFileAccess = false
        allowContentAccess = false
        databaseEnabled = false
    }
    web.addJavascriptInterface(WebxdcBridge(model, msgId), "AndroidWebxdcBridge")
    web.webViewClient = object : android.webkit.WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val url = request.url
            // Only this app's own origin (and data:/blob:) is served; every
            // other request is refused here instead of reaching the network.
            if (!webxdcRequestAllowed(url.scheme, url.host, host)) return blocked()
            if (!url.scheme.equals("https", ignoreCase = true)) return null
            val path = webxdcArchivePath(url.pathSegments)
            val b64 = runBlocking {
                runCatching { model.callWebxdcBlob(msgId, path) }.getOrNull()
            } ?: return notFound()
            val bytes = try {
                android.util.Base64.decode(b64, android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
            } catch (_: IllegalArgumentException) {
                return notFound()
            }
            if (path.endsWith(".html")) {
                val html = String(bytes, Charsets.UTF_8)
                val withApi = if (html.contains("<head>", ignoreCase = true)) {
                    html.replaceFirst(Regex("<head>", RegexOption.IGNORE_CASE), "<head>$INJECTED_API")
                } else INJECTED_API + html
                return served("text/html", withApi.toByteArray(Charsets.UTF_8))
            }
            return served(mimeFor(path), bytes)
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Navigation stays on the app's own origin. A user tap on an http(s)
            // link goes to the system chooser; anything else (scripts, redirects,
            // intent:/file:/content: and other schemes) is dropped.
            val url = request.url
            if (webxdcRequestAllowed(url.scheme, url.host, host)) return false
            if (webxdcLinkLeaves(url.scheme, request.hasGesture())) {
                try {
                    val open = android.content.Intent(android.content.Intent.ACTION_VIEW, url)
                        .addCategory(android.content.Intent.CATEGORY_BROWSABLE)
                    val chooser = android.content.Intent.createChooser(open, null)
                        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    web.context.startActivity(chooser)
                } catch (_: android.content.ActivityNotFoundException) {}
            }
            return true
        }
    }
}

private fun served(mime: String, bytes: ByteArray): WebResourceResponse =
    WebResourceResponse(
        mime, "utf-8", 200, "OK",
        mapOf("Content-Security-Policy" to WEBXDC_CSP, "X-Content-Type-Options" to "nosniff"),
        java.io.ByteArrayInputStream(bytes),
    )

private fun blocked(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, java.io.ByteArrayInputStream(ByteArray(0)))

private fun notFound(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, java.io.ByteArrayInputStream(ByteArray(0)))

/** JS-facing bridge: the injected `window.webxdc` serializes every call to
 *  one `request(json)` (blocking the WebView's JS thread is the standard
 *  pattern — the methods answer from the core in microseconds). */
private class WebxdcBridge(private val model: AppModel, private val msgId: Long) {

    @JavascriptInterface
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
            "realtimeJoin" -> {
                model.webxdcJoined = true
                core.sendWebxdcRealtimeAdvertisement(acc, msgId)
                kotlinx.serialization.json.buildJsonObject { put("done", kotlinx.serialization.json.JsonPrimitive(true)) }
            }
            "realtimeSend" -> {
                require(model.webxdcJoined) { "realtime channel not joined" }
                val data = (params["data"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() }
                    ?: error("no data")
                core.sendWebxdcRealtimeData(acc, msgId, data)
                kotlinx.serialization.json.buildJsonObject { put("done", kotlinx.serialization.json.JsonPrimitive(true)) }
            }
            "realtimeLeave" -> {
                model.webxdcJoined = false
                core.leaveWebxdcRealtime(acc, msgId)
                kotlinx.serialization.json.buildJsonObject { put("done", kotlinx.serialization.json.JsonPrimitive(true)) }
            }
            else -> kotlinx.serialization.json.buildJsonObject {
                put("error", kotlinx.serialization.json.JsonPrimitive("method not available in this build: $method"))
            }
        }
    }
}
