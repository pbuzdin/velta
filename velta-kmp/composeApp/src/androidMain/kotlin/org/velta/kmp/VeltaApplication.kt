package org.velta.kmp

import android.app.Application
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
        if (!RpcShim.available) println("velta-kmp: core shim not loaded at process start")
        AppHolder.obtain(this)
    }
}
