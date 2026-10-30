package org.velta

import android.content.Context
import android.util.Log

// The in-process Delta Chat core, reachable without the activity (audit
// item 1). The activity used to be the only thing that loaded velta_app.so
// and created the core (Tauri setup), so a process the system restarted for
// CoreService (START_STICKY), a push, the periodic job, a scheduled-send
// alarm or boot had no core: pushes were lost and the service notification
// claimed to sync while nothing ran. Now every entry point calls
// ensureStarted(); Rust (lib.rs, Java_org_velta_VeltaCore_startHeadless)
// creates the single core, and Tauri setup reuses it when the UI opens.
object VeltaCore {
    private const val TAG = "VeltaCore"

    @Volatile
    private var loaded = false

    private external fun setContext(context: Context)
    private external fun startHeadless(dataDir: String, extDir: String): Boolean
    private external fun isRunning(): Boolean
    private external fun provideDek(dekHex: String): Boolean

    /**
     * #178 phase 4: hands the DEK (64 hex, from the VeltaLock BiometricPrompt
     * flow) to Rust, which retries the deferred core init with it. false:
     * the library is not loaded or Rust refused the key shape.
     */
    @JvmStatic
    fun startWithDek(dekHex: String): Boolean {
        if (!loaded) return false
        return try {
            provideDek(dekHex)
        } catch (e: Throwable) {
            Log.e(TAG, "provideDek failed", e)
            false
        }
    }

    /** Loads velta_app.so and hands Rust the application context. */
    @JvmStatic
    fun load(context: Context): Boolean {
        if (loaded) return true
        synchronized(this) {
            if (loaded) return true
            try {
                System.loadLibrary("velta_app")
                setContext(context.applicationContext)
                loaded = true
            } catch (e: Throwable) {
                Log.e(TAG, "native library failed to load", e)
            }
        }
        return loaded
    }

    /**
     * Starts the core if it is not running yet. false: the library is
     * missing or "Use background connection" is off (and no core runs).
     */
    @JvmStatic
    fun ensureStarted(context: Context): Boolean {
        if (!load(context)) return false
        return try {
            startHeadless(AppFiles.dataDir(context).absolutePath, context.getExternalFilesDir(null)?.absolutePath ?: "")
        } catch (e: Throwable) {
            Log.e(TAG, "headless start failed", e)
            false
        }
    }

    /** The core finished initializing (its RPC session is up). */
    @JvmStatic
    fun running(): Boolean =
        loaded && try { isRunning() } catch (_: Throwable) { false }
}
