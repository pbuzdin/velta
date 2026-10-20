package org.velta

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * Mic / camera runtime permission for calls (app/js/calls.js
 * `ensureMediaPermission`, Rust `call_permission`). Velta checks and asks
 * BEFORE getUserMedia, for every capture path (outgoing, accept, accept
 * with video, camera on mid-call, flip), instead of relying only on wry's
 * onPermissionRequest — which silently denies the WebView request when the
 * OS permission was refused before, so the camera just "failed".
 *
 * status: "granted" | "pending" (our dialog is up) | "prompt" (can ask) |
 * "blocked" (asked before, the OS will not show the dialog again).
 */
object CallPermissions {
  private const val REQUEST_CODE = 0x7141
  private const val PREFS = "velta_call_permissions"
  @Volatile private var pending = false
  private var activityRef: WeakReference<Activity>? = null

  fun attach(activity: Activity) { activityRef = WeakReference(activity) }

  /** Pure mapping, mirrored by tests/call-permission.test.mjs. */
  fun manifestName(kind: String): String? = when (kind) {
    "camera" -> Manifest.permission.CAMERA
    "microphone" -> Manifest.permission.RECORD_AUDIO
    else -> null
  }

  @JvmStatic
  fun check(context: Context, kind: String, request: Boolean): String {
    val perm = manifestName(kind) ?: return "prompt"
    if (ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED) {
      return "granted"
    }
    if (pending) return "pending"
    val activity = activityRef?.get()
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val asked = prefs.getBoolean(perm, false)
    if (activity != null && asked && !ActivityCompat.shouldShowRequestPermissionRationale(activity, perm)) {
      return "blocked"
    }
    if (!request || activity == null) return "prompt"
    pending = true
    prefs.edit().putBoolean(perm, true).apply()
    activity.runOnUiThread {
      try {
        ActivityCompat.requestPermissions(activity, arrayOf(perm), REQUEST_CODE)
      } catch (_: Throwable) {
        pending = false
      }
    }
    return "pending"
  }

  /** From MainActivity.onRequestPermissionsResult. */
  fun onResult(requestCode: Int) {
    if (requestCode == REQUEST_CODE) pending = false
  }
}
