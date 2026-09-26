package org.velta

// Issue #12: WebView.setWebContentsDebuggingEnabled throws a Java exception
// when invoked off the Android UI thread (Rust set_devtools runs on a Tokio
// worker). Rust posts the flag here; the static call then runs on the main
// looper, which every WebView accepts.
import android.os.Handler
import android.os.Looper
import android.webkit.WebView

object DevTools {
    private val main = Handler(Looper.getMainLooper())

    @JvmStatic
    fun set(enabled: Boolean) {
        main.post { WebView.setWebContentsDebuggingEnabled(enabled) }
    }
}
