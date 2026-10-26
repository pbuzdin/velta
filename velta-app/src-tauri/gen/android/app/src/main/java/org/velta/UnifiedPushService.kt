package org.velta

import android.content.Context
import android.util.Log
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.data.ResolvedDistributor

// UnifiedPush connector (Android): receives push events from the
// user-chosen distributor app (ntfy, NextPush, ...) and forwards them into
// the Rust core via JNI — endpoint registrations become push subscriptions
// on the relay, messages wake the core for a background fetch whose results
// surface as notifications through the existing background poller.
// The service is registered in AndroidManifest.xml with the
// org.unifiedpush.android.connector.PUSH_EVENT intent filter.
class UnifiedPushService : PushService() {
    // JNI exports implemented in lib.rs
    // (Java_org_velta_UnifiedPushService_*). VeltaApp loads velta_app.so in
    // every process and VeltaCore.ensureStarted brings the core up on a
    // cold start (process killed, push arrives); callers still catch
    // UnsatisfiedLinkError.
    private external fun pushEndpointReceived(token: String)
    private external fun pushWakeup()
    private external fun pushUnregistered()

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val key = endpoint.pubKeySet
        if (key == null) {
            Log.e(TAG, "endpoint without key set - ignoring")
            return
        }
        // The "webpush:<endpoint>|<pubkey>|<auth>" serialization is what the
        // chatmail push relay parses (same format as the upstream Delta Chat
        // UnifiedPush client); the core treats the token as opaque and
        // registers it with the relay itself (core push.rs / imap.rs).
        UnifiedPushBridge.prefs(this).edit()
            .putLong(UnifiedPushBridge.KEY_LAST_ENDPOINT, System.currentTimeMillis()).apply()
        val token = "webpush:${endpoint.url}|${key.pubKey}|${key.auth}"
        VeltaCore.ensureStarted(this)
        try {
            pushEndpointReceived(token)
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "native lib not loaded - core not running", e)
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        Log.d(TAG, "push received - waking the core")
        // #140: last push time for Settings → Push notifications.
        UnifiedPushBridge.prefs(this).edit()
            .putLong(UnifiedPushBridge.KEY_LAST_PUSH, System.currentTimeMillis()).apply()
        // Cold process: start the core first, the wake-up waits for it.
        if (!VeltaCore.ensureStarted(this)) {
            Log.w(TAG, "push received but the core is not running (background connection off?)")
        }
        try {
            pushWakeup()
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "native lib not loaded - core not running", e)
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(TAG, "UnifiedPush registration failed: ${reason.name}")
    }

    override fun onUnregistered(instance: String) {
        Log.w(TAG, "UnifiedPush unregistered")
        try {
            pushUnregistered()
        } catch (_: UnsatisfiedLinkError) {
        }
    }

    companion object {
        private const val TAG = "UnifiedPushService"

        // VAPID public key identifying the application server (the chatmail
        // push relay) to the UnifiedPush push server. Upstream chatmail
        // notifier key, same constant the Delta Chat UnifiedPush flavor
        // ships. 🐴 ceiling: a self-hosted relay whose notifier uses a
        // different VAPID keypair needs this constant updated, or push
        // providers that verify VAPID will reject its pushes; providers
        // ignoring VAPID work regardless.
        private const val VAPID_KEY =
            "BHNce1sXk99bpkFFYwiSR3Lp4n54PiS-Y0S9iX6R7va7sxQ5hE7ll6DMKlKs2tFT9POq92gLygezT7o0fkQU8NE"

        // Auto-register on app start. Only the no-questions case is handled:
        // a single distributor or a system default (resolveDefaultDistributor
        // Found), or one the user picked in Settings → Push notifications
        // (#140). Several distributors without a default are skipped silently
        // (no OS picker out of nowhere) — the Settings picker covers that.
        // An explicit "Off" in Settings (UnifiedPushBridge KEY_OPTED_OUT)
        // always wins over auto-registration.
        fun maybeRegister(context: Context) {
            try {
                if (UnifiedPushBridge.optedOut(context)) {
                    Log.d(TAG, "UnifiedPush off by user choice")
                    return
                }
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
            UnifiedPush.register(context, INSTANCE_DEFAULT, null, VAPID_KEY)
            Log.d(TAG, "UnifiedPush registration requested")
        }
    }
}
