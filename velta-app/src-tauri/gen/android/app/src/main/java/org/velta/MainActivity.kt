package org.velta

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
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
  }
}
