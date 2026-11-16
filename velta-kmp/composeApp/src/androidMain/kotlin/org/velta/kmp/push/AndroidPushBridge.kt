package org.velta.kmp.push

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush
import org.velta.kmp.ui.PushApp
import org.velta.kmp.ui.PushBridge
import org.velta.kmp.ui.PushStatus
import org.velta.kmp.ui.pushRegistration

/**
 * Settings › Push notifications, Android side — a port of stable's
 * UnifiedPushBridge (#140/#204). State the connector does not keep
 * (explicit Off, last push time, last endpoint, registration failure)
 * lives in the "velta_push" SharedPreferences, shared with VeltaPushService.
 */
class AndroidPushBridge(private val context: Context) : PushBridge {

    override fun status(): PushStatus {
        val distributors = try {
            UnifiedPush.getDistributors(context)
                .filter { it != context.packageName }
                .map { PushApp(it, label(it)) }
        } catch (e: Throwable) {
            Log.e(TAG, "getDistributors failed", e)
            emptyList()
        }
        val saved = try { UnifiedPush.getSavedDistributor(context) } catch (_: Throwable) { null }
        val p = prefs(context)
        val failed = p.getString(KEY_REG_FAILED, "") ?: ""
        return PushStatus(
            distributors = distributors,
            saved = saved ?: "",
            savedLabel = saved?.let { label(it) } ?: "",
            optedOut = optedOut(context),
            lastPush = p.getLong(KEY_LAST_PUSH, 0L),
            registration = pushRegistration(p.getLong(KEY_LAST_ENDPOINT, 0L), failed),
            registrationError = failed,
        )
    }

    override fun select(pkg: String) {
        prefs(context).edit().putBoolean(KEY_OPTED_OUT, false).putString(KEY_REG_FAILED, "").apply()
        UnifiedPush.saveDistributor(context, pkg)
        VeltaPushService.register(context)
    }

    override fun off() {
        prefs(context).edit().putBoolean(KEY_OPTED_OUT, true).apply()
        try { UnifiedPush.unregister(context, INSTANCE_DEFAULT) } catch (e: Throwable) { Log.w(TAG, "unregister failed", e) }
        try { UnifiedPush.removeDistributor(context) } catch (e: Throwable) { Log.w(TAG, "removeDistributor failed", e) }
    }

    private fun label(pkg: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        pkg
    }

    companion object {
        private const val TAG = "AndroidPushBridge"
        const val PREFS = "velta_push"
        const val KEY_OPTED_OUT = "opted_out"
        const val KEY_LAST_PUSH = "last_push_ms"
        const val KEY_LAST_ENDPOINT = "last_endpoint_ms"
        const val KEY_REG_FAILED = "reg_failed"

        fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun optedOut(context: Context) = prefs(context).getBoolean(KEY_OPTED_OUT, false)
    }
}
