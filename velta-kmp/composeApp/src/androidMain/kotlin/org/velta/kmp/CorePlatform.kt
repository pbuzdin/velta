package org.velta.kmp

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import org.velta.kmp.ui.AppIconChoice
import org.velta.kmp.ui.APP_ICON_PREF
import org.velta.kmp.ui.launcherAliasState
import org.velta.kmp.ui.notificationIconName
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.JniRpcTransport
import org.velta.kmp.core.RpcShim
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaKeystore
import org.velta.kmp.core.VeltaLock
import java.io.File

/**
 * Android platform: accounts under `filesDir/accounts`; the core runs
 * IN-PROCESS via the Rust cdylib shim (native/rpc-shim). JSON-RPC crosses
 * JNI (#357). No exec'd sidecar (issue #192 P1b).
 */
class AndroidCorePlatform(private val context: Context) : CorePlatform {

    override fun appVersion(): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "?"

    override fun accountsDir(): String =
        File(context.filesDir, "accounts").apply { mkdirs() }.absolutePath

    // App-level settings (#321 step 5): SharedPreferences mirrors the web's
    // localStorage keys (dw-theme, velta-amoled, velta-accent, velta-lang).
    override fun pref(key: String): String? =
        context.getSharedPreferences("velta_prefs", Context.MODE_PRIVATE).getString(key, null)

    override fun setPref(key: String, value: String?) {
        context.getSharedPreferences("velta_prefs", Context.MODE_PRIVATE).edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }

    override fun spawnRpcServer(accountsDir: String): RpcTransport? {
        // Database encryption at rest (#178 port): the DEK comes from the
        // Keystore wrap; null → "" runs keyless, which leaves
        // already-encrypted databases locked instead of recreating them.
        val dbKey = VeltaKeystore.getOrCreateDek(context) ?: ""
        return openShim(accountsDir, dbKey)
    }

    override fun connectHint(): String =
        "core shim missing — build native/rpc-shim (README) and copy into jniLibs"

    override fun stopRpcServer() {
        if (RpcShim.available) RpcShim.stopCoreOnce()
    }

    override fun isAppLocked(): Boolean =
        VeltaLock.on(context) && VeltaLock.bioFile(context).exists()

    override fun isAppLockOn(): Boolean = VeltaLock.on(context)

    /** Unlock path: the DEK comes from the auth-window unwrap, not the store. */
    override fun spawnRpcServerWithKey(accountsDir: String, dbKey: String): RpcTransport? =
        openShim(accountsDir, dbKey)

    private fun openShim(accountsDir: String, dbKey: String): RpcTransport? {
        if (!RpcShim.available) {
            println("velta-kmp: rpc shim not packaged — build native/rpc-shim for this ABI (see README)")
            return null
        }
        return try {
            val code = RpcShim.startCoreOnce(accountsDir, dbKey)
            if (code <= 0) {
                println("velta-kmp: shim failed to start the core (code=$code)")
                null
            } else {
                JniRpcTransport()
            }
        } catch (t: Throwable) {
            println("velta-kmp: shim start threw: $t")
            null
        }
    }

    /** MUST be called inside the auth window a successful prompt just opened. */
    override fun enableAppLock(): Boolean {
        val dek = VeltaKeystore.getOrCreateDek(context) ?: return false
        return VeltaKeystore.enableAppLock(context, dek)
    }

    /** The DEK for the plain wrap comes from the bio wrap's auth window. */
    override fun disableAppLock(): Boolean {
        val dek = VeltaKeystore.unlockDek(context) ?: return false
        return VeltaKeystore.disableAppLock(context, dek)
    }

    /** Enable exactly one launcher alias; MainActivity itself stays enabled
     *  so notifications and shortcuts that target it keep working. */
    override fun applyAppIcon(choice: String) {
        val state = launcherAliasState(AppIconChoice.fromPref(choice))
        val pm = context.packageManager
        val flags = PackageManager.DONT_KILL_APP
        fun set(name: String, enabled: Int) {
            pm.setComponentEnabledSetting(ComponentName(context, name), enabled, flags)
        }
        set(state.enabled, PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
        for (name in state.disabled) {
            set(name, PackageManager.COMPONENT_ENABLED_STATE_DISABLED)
        }
    }
}

/** The picked app icon as stored in prefs (default when absent). */
fun Context.currentAppIcon(): AppIconChoice =
    AppIconChoice.fromPref(
        getSharedPreferences("velta_prefs", Context.MODE_PRIVATE).getString(APP_ICON_PREF, null),
    )

/** The chosen logo's status-bar glyph (ic_notify_default/badge/classic). */
fun Context.appIconSmallIconRes(choice: AppIconChoice): Int =
    resources.getIdentifier(choice.notificationIconName, "drawable", packageName)

/** The chosen logo's launcher tile as a bitmap for notification banners.
 *  Skins (vivo) draw the app icon on banners and cache it across icon
 *  switches — an explicit largeIcon of the chosen tile bypasses that. */
fun Context.appLauncherTileBitmap(choice: AppIconChoice): android.graphics.Bitmap {
    val size = 192
    val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
    val drawable = try {
        val resId = resources.getIdentifier(choice.launcherMipmapName, "mipmap", packageName)
        if (resId != 0) resources.getDrawable(resId, theme) else null
    } catch (_: RuntimeException) {
        null
    } ?: applicationInfo.loadIcon(packageManager) // fall back to whatever the system thinks we are
    drawable.setBounds(0, 0, size, size)
    drawable.draw(android.graphics.Canvas(bitmap))
    return bitmap
}
