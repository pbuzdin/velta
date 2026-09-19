package org.velta

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Re-enable WryActivity's WebView-history BACK handling (TauriActivity
  // turns it off): BACK pops the SPA history entry pushed by openChat
  // (chat -> chat list) and only exits once the app is back at its base
  // state, where canGoBack() is false.
  override val handleBackNavigation: Boolean = true

  companion object {
    init {
      // velta_app.so is loaded by the Tauri runtime; ensure it is available
      // before onCreate hands it the application context.
      System.loadLibrary("velta_app")
    }
  }

  // Hands the application context to the Rust shell (see
  // Java_org_velta_MainActivity_setApplicationContext in src/lib.rs) so
  // commands can use the Android ContentResolver (attachment picking).
  external fun setApplicationContext(context: Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    setApplicationContext(applicationContext)
    super.onCreate(savedInstanceState)
    // The second-WebView browser overlay (InAppBrowser.openWebView) needs the
    // Activity to add views and to own BACK priority over wry's history
    // navigation. attach() registers its OnBackPressedCallback AFTER
    // WryActivity's, so it wins whenever the overlay is open.
    InAppBrowser.attach(this)
    // Keep the process (and the in-process Delta Chat core) alive after the
    // user leaves the app: promote to a foreground service with a persistent
    // low-importance notification. Background notifications are posted by
    // Rust's background event poller; see start_bg_event_poller in lib.rs.
    try {
      CoreService.start(this)
    } catch (_: Exception) {
    }
    // Local chat (p2p.rs) discovers peers on the LAN via iroh's mDNS
    // (swarm-discovery); Android silently drops multicast packets unless a
    // MulticastLock is held for the process lifetime.
    try {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      val lock = wifi?.createMulticastLock("velta-p2p-mdns")
      lock?.setReferenceCounted(false)
      lock?.acquire()
    } catch (_: Exception) {
    }
    applyTextZoomFix()
  }

  override fun onDestroy() {
    InAppBrowser.detach()
    super.onDestroy()
  }

  // Velta owns its scaling end to end: the WebView otherwise applies the
  // system font scale as text-only zoom (textZoom = 100 * fontScale), which
  // inflates text while the px-sized layout boxes stay put — clipped header,
  // broken composer at large scales (user report on a 320px-viewport device).
  // The coherent alternative lives in the app itself: drawer -> Interface
  // scale (zoom on <html>, see ui.js). The WebView is created by the Tauri
  // runtime some time after onCreate, hence the bounded retry.
  private var textZoomApplied = false
  private val textZoomFix = object : Runnable {
    override fun run() {
      if (textZoomApplied) return
      val wb = findWebView(window?.decorView, 0)
      if (wb != null) {
        wb.settings.textZoom = 100
        textZoomApplied = true
        return
      }
      if (retryCount++ < 60) Handler(Looper.getMainLooper()).postDelayed(this, 250)
    }
  }
  private var retryCount = 0
  private fun applyTextZoomFix() {
    Handler(Looper.getMainLooper()).postDelayed(textZoomFix, 250)
  }
  private fun findWebView(v: View?, depth: Int): WebView? {
    if (v == null || depth > 12) return null
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i), depth + 1)?.let { return it }
      }
    }
    return null
  }
}
