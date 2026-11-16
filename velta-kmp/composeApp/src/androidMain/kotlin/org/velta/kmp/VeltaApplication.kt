package org.velta.kmp

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import org.velta.kmp.core.RpcShim

/**
 * Runs first in every process start, whatever woke it — activity, sync
 * service, push, the periodic job, boot (stable VeltaApp). It loads the core
 * shim library and builds the shared model, which applies the stored
 * language, so a headless start posts localized notifications. The core
 * itself starts on demand (AppModel.connect / catchUpFetch), never here.
 */
class VeltaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        org.velta.kmp.ui.EditScratch.dir = java.io.File(cacheDir, "edits")
        if (!RpcShim.available) println("velta-kmp: core shim not loaded at process start")
        AppHolder.obtain(this)
        registerNetworkCallback()
    }

    /** Network came back → `maybe_network` (stable CoreService's callback,
     *  Delta Chat's network-state listener), so the core reconnects at once
     *  instead of waiting for its own backoff. Process-wide: covers the UI,
     *  the sync service and headless wake-ups alike. */
    private fun registerNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    AppHolder.obtain(this@VeltaApplication).onNetworkAvailable(true)
                }
            })
        } catch (t: RuntimeException) {
            println("velta-kmp: network callback not registered: $t")
        }
    }
}
