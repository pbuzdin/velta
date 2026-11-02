package org.velta

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush

// #140/#204: Settings → Push notifications. Called from lib.rs (push_status /
// push_select / push_off) through the cached-class JNI pattern. State the
// connector does not keep (explicit "Off", last push time, last registration
// failure) lives in the "velta_push" SharedPreferences, shared with
// UnifiedPushService. status() is the only object the settings UI reads.
object UnifiedPushBridge {
    private const val TAG = "UnifiedPushBridge"
    const val PREFS = "velta_push"
    const val KEY_OPTED_OUT = "opted_out"
    const val KEY_LAST_PUSH = "last_push_ms"
    const val KEY_LAST_ENDPOINT = "last_endpoint_ms"
    const val KEY_REG_FAILED = "reg_failed"

    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun optedOut(context: Context) = prefs(context).getBoolean(KEY_OPTED_OUT, false)

    private fun label(context: Context, pkg: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: PackageManager.NameNotFoundException) {
        pkg
    }

    /** JSON: {distributors:[{pkg,label}], saved, savedLabel, optedOut, lastPush, lastEndpoint, registration, registrationError} */
    @JvmStatic
    fun status(context: Context): String {
        val out = JSONObject()
        val list = JSONArray()
        try {
            for (pkg in UnifiedPush.getDistributors(context)) {
                if (pkg == context.packageName) continue
                list.put(JSONObject().put("pkg", pkg).put("label", label(context, pkg)))
            }
        } catch (e: Throwable) {
            Log.e(TAG, "getDistributors failed", e)
        }
        out.put("distributors", list)
        val saved = try { UnifiedPush.getSavedDistributor(context) } catch (e: Throwable) { null }
        out.put("saved", saved ?: "")
        out.put("savedLabel", if (saved != null) label(context, saved) else "")
        out.put("optedOut", optedOut(context))
        val p = prefs(context)
        val lastEndpoint = p.getLong(KEY_LAST_ENDPOINT, 0L)
        val failed = p.getString(KEY_REG_FAILED, "") ?: ""
        out.put("lastPush", p.getLong(KEY_LAST_PUSH, 0L))
        out.put("lastEndpoint", lastEndpoint)
        // failed wins over a previous endpoint so a later registration error
        // is not reported as ok. ok needs a recorded endpoint and no failure.
        val registration = when {
            failed.isNotEmpty() -> "failed"
            lastEndpoint > 0L -> "ok"
            else -> "none"
        }
        out.put("registration", registration)
        out.put("registrationError", failed)
        return out.toString()
    }

    /** Use this distributor now: save + register; clears an explicit Off
     * and any previous registration-failure flag (retry in progress). */
    @JvmStatic
    fun select(context: Context, pkg: String) {
        prefs(context).edit()
            .putBoolean(KEY_OPTED_OUT, false)
            .putString(KEY_REG_FAILED, "")
            .apply()
        UnifiedPush.saveDistributor(context, pkg)
        UnifiedPushService.register(context)
    }

    /** Explicit Off: unregister, forget the distributor, and remember the
     * choice so maybeRegister on start does not re-enable push. */
    @JvmStatic
    fun off(context: Context) {
        prefs(context).edit().putBoolean(KEY_OPTED_OUT, true).apply()
        try { UnifiedPush.unregister(context, INSTANCE_DEFAULT) } catch (e: Throwable) { Log.w(TAG, "unregister failed", e) }
        try { UnifiedPush.removeDistributor(context) } catch (e: Throwable) { Log.w(TAG, "removeDistributor failed", e) }
    }
}
