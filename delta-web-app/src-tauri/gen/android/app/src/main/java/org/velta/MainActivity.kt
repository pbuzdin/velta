package org.velta

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object {
    init {
      // delta_web.so is loaded by the Tauri runtime; ensure it is available
      // before onCreate hands it the application context.
      System.loadLibrary("delta_web")
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
  }
}