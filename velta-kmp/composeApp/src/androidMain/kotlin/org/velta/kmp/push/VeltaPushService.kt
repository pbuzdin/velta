package org.velta.kmp.push

import android.content.Context
import android.util.Log
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.data.ResolvedDistributor
import org.velta.kmp.AppHolder
import org.velta.kmp.BuildConfig

/**
 * UnifiedPush connector (P4): receives push events from the user-chosen
 * distributor (ntfy, NextPush, …) and forwards them into the shared model —
 * endpoint registrations become push subscriptions on the relay, messages
 * wake the core for a fetch whose results surface through the event loop.
 *
 * Mirrors the Tauri shell's UnifiedPushService: same webpush token
 * serialization, same VAPID key, same auto-registration rules.
 */
class VeltaPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val key = endpoint.pubKeySet
        if (key == null) {
            Log.e(TAG, "endpoint without key set - ignoring")
            return
        }
        val token = "webpush:${endpoint.url}|${key.pubKey}|${key.auth}"
        AppHolder.obtain(applicationContext).onPushEndpoint(token)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        Log.d(TAG, "push received - waking the core")
        AppHolder.obtain(applicationContext).onPushWakeup()
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(TAG, "UnifiedPush registration failed: ${reason.name}")
    }

    override fun onUnregistered(instance: String) {
        Log.w(TAG, "UnifiedPush unregistered")
        AppHolder.obtain(applicationContext).onPushUnregistered()
    }

    companion object {
        private const val TAG = "VeltaPushService"

        // VAPID public key identifying the push relay to the distributor.
        // 🐴 a self-hosted relay whose notifier uses a different VAPID keypair
        // must pass -PveltaVapidKey or VELTA_VAPID_KEY at APK build (see
        // composeApp/build.gradle.kts), or VAPID-verifying providers reject
        // its pushes; providers ignoring VAPID work regardless.

        /**
         * Auto-register on app start. Only the no-questions case: a single
         * distributor or a resolved system default, or one the user already
         * picked. Several distributors without a default are skipped
         * silently (a picker UI is a later slice).
         */
        fun maybeRegister(context: Context) {
            try {
                if (UnifiedPush.getSavedDistributor(context) == null) {
                    val resolved = UnifiedPush.resolveDefaultDistributor(context)
                    if (resolved is ResolvedDistributor.Found) {
                        UnifiedPush.saveDistributor(context, resolved.packageName)
                    }
                }
                if (UnifiedPush.getSavedDistributor(context) != null) register(context)
            } catch (e: Throwable) {
                Log.e(TAG, "UnifiedPush setup failed", e)
            }
        }

        fun register(context: Context) {
            UnifiedPush.register(context, INSTANCE_DEFAULT, null, BuildConfig.VAPID_KEY)
            Log.d(TAG, "UnifiedPush registration requested")
        }
    }
}
