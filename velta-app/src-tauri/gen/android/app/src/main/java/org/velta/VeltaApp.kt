package org.velta

import android.app.Application

// Runs first in every process start, whatever woke it (activity, service,
// push, job, alarm, boot): loads the native library so every JNI entry
// point works. The core itself starts on demand (VeltaCore.ensureStarted),
// never here, so a boot or time-change broadcast with "Use background
// connection" off does not bring it up.
class VeltaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        VeltaCore.load(this)
    }
}
