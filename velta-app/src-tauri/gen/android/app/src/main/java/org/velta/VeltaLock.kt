package org.velta

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// #178 phase 4: the biometric app lock (plan §2.4 strong mode). A second
// AndroidKeyStore key ("velta_kek_auth") requires user authentication for
// EVERY use and wraps the SAME DEK into noBackupFilesDir/dbkey.wrap.auth;
// the plain wrap is removed while the lock is on, so cold starts cannot
// open the databases until the activity unlocks — background fetch waits
// until unlock, as the plan documents (Rust: init_android_core refuses to
// run until VeltaCore.startWithDek hands over the DEK after a prompt).
//
// Auto-lock rides on top as a UI gate: after N minutes hidden the activity
// shows a full-screen lock and re-prompts. Honest limitation: the DEK
// stays in the running core's memory, so this gates the screen, not the
// key — the cold-start prompt above is the real boundary.
object VeltaLock {
    private const val TAG = "velta-lock"
    private const val AUTH_KEK_ALIAS = "velta_kek_auth"
    private const val AUTH_WRAP_FILE = "dbkey.wrap.auth"
    private const val PREFS = "velta-lock"
    private const val PREF_AUTOLOCK_MINS = "autolock_mins"

    // The foreground activity, registered by MainActivity (the prompt and
    // the lock overlay need one; JNI from Rust only has a Context).
    @Volatile
    @JvmStatic
    var activity: FragmentActivity? = null

    private fun authWrap(context: Context): File = File(context.noBackupFilesDir, AUTH_WRAP_FILE)

    /** The biometric lock is on — the DEK only opens after a prompt. */
    @JvmStatic
    fun on(context: Context): Boolean = authWrap(context).exists()

    /** Strong biometric (or device credential) actually available. */
    @JvmStatic
    fun available(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 28) return false
        val bm = BiometricManager.from(context)
        return bm.canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
    }

    // A CryptoObject prompt only accepts Class 3 (strong) biometrics on every
    // API level; asking for WEAK on 28/29 made available() say yes on devices
    // whose prompt then refused the crypto op.
    //
    // Android 11+: the phone's screen-lock PIN/pattern/password is accepted
    // too (DEVICE_CREDENTIAL with a CryptoObject is supported from API 30),
    // so users without an enrolled fingerprint can turn the lock on.
    // Android 9-10 cannot combine a device credential with a CryptoObject:
    // strong biometric only there.
    private val AUTHENTICATORS: Int
        get() = if (Build.VERSION.SDK_INT >= 30) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        }

    /** Why canAuthenticate refused, in words for the toast / velta.log. */
    private fun canAuthenticateDetail(context: Context): String? {
        val code = BiometricManager.from(context).canAuthenticate(AUTHENTICATORS)
        return when (code) {
            BiometricManager.BIOMETRIC_SUCCESS -> null
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> if (Build.VERSION.SDK_INT >= 30) {
                "no-auth: canAuthenticate=$code: no screen lock or strong biometric set up"
            } else {
                "no-auth: canAuthenticate=$code: no fingerprint enrolled (Android 9-10 needs one)"
            }
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "canAuthenticate=$code: no biometric hardware"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "canAuthenticate=$code: biometric hardware unavailable"
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "canAuthenticate=$code: security update required"
            else -> "canAuthenticate=$code"
        }
    }

    fun autoLockMinutes(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(PREF_AUTOLOCK_MINS, 0)

    @JvmStatic
    fun setAutoLockMinutes(context: Context, mins: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(PREF_AUTOLOCK_MINS, mins.coerceIn(0, 240)).apply()
    }

    @Volatile
    private var lastKekError: String? = null

    private fun authKek(): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(AUTH_KEK_ALIAS, null) as? SecretKey)?.let { return it }
        return try {
            val generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore",
            )
            val builder = KeyGenParameterSpec.Builder(
                AUTH_KEK_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(false)
            if (Build.VERSION.SDK_INT >= 30) {
                // Matches the prompt: strong biometric or the screen lock.
                builder.setUserAuthenticationParameters(
                    0,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            } else {
                // -1: auth required for every use (CryptoObject mandatory).
                builder.setUserAuthenticationValidityDurationSeconds(-1)
            }
            generator.init(builder.build())
            generator.generateKey()
        } catch (e: Exception) {
            Log.e(TAG, "auth-bound KEK generation failed", e)
            lastKekError = "auth key generation failed: ${e.javaClass.simpleName}: ${e.message}"
            null
        }
    }

    /** [ver][12B iv][ct] blob, same shape as VeltaKeystore's plain wrap. */
    private fun writeWrap(file: File, dek: ByteArray, iv: ByteArray, ct: ByteArray): Boolean {
        val blob = ByteArray(1 + iv.size + ct.size)
        blob[0] = 1
        iv.copyInto(blob, 1)
        ct.copyInto(blob, 1 + iv.size)
        val tmp = File(file.parentFile, "${file.name}.tmp")
        return try {
            java.io.FileOutputStream(tmp).use { out ->
                out.write(blob)
                out.fd.sync()
            }
            tmp.renameTo(file) || (file.delete() && tmp.renameTo(file))
        } catch (e: Exception) {
            Log.e(TAG, "wrap write failed", e)
            false
        }
    }

    /** Last prompt failure ("code N: message") for the result event. */
    @Volatile
    private var lastPromptError: String? = null

    private fun prompt(activity: FragmentActivity, cipher: Cipher?, title: String, onResult: (ok: Boolean, cipher: Cipher?) -> Unit) {
        val executor = ContextCompat.getMainExecutor(activity)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onResult(true, result.cryptoObject?.cipher)
            }

            override fun onAuthenticationError(code: Int, msg: CharSequence) {
                Log.w(TAG, "prompt error $code: $msg")
                lastPromptError = "BiometricPrompt error $code: $msg"
                onResult(false, null)
            }

            override fun onAuthenticationFailed() {
                // A single failed finger; the prompt stays up for retries.
            }
        }
        val prompt = BiometricPrompt(activity, executor, callback)
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(AUTHENTICATORS)
            .setConfirmationRequired(false)
        // A DEVICE_CREDENTIAL prompt has its own cancel; a negative button
        // there throws IllegalArgumentException.
        if (Build.VERSION.SDK_INT < 30) builder.setNegativeButtonText(activity.getString(R.string.biometric_cancel))
        val info = builder.build()
        if (cipher != null) prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        else prompt.authenticate(info)
    }

    /**
     * Enable (on=true) / disable (on=false) the biometric lock. Both need a
     * user-authenticated crypto op on the auth-bound key, so both prompt:
     * enable wraps the current DEK under the auth KEK (a fresh cipher's IV
     * comes back on the succeeded result), disable unwraps the DEK back
     * into the plain wrap. The result reaches JS via the velta-biometric
     * event (JNI notifyResult) — the caller keeps no DEK.
     */
    /** The running core's DEK (from Rust; "" when keyless). Never logged. */
    @Volatile
    private var currentDek: String = ""

    @JvmStatic
    fun request(activity: FragmentActivity, on: Boolean) {
        // BiometricPrompt must be built and shown on the main thread; the
        // Rust command calls in from a worker thread.
        activity.runOnUiThread {
            try {
                requestOnMain(activity, on)
            } catch (e: Exception) {
                Log.e(TAG, "biometric request failed", e)
                report(on, false, "${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    private fun report(on: Boolean, ok: Boolean, detail: String = "") {
        if (!ok) Log.w(TAG, "biometric ${if (on) "enable" else "disable"} failed: $detail")
        notifyResult(on, ok, detail)
    }

    private fun notifyResult(on: Boolean, ok: Boolean) {
        val detail = if (ok) "" else (lastPromptError ?: "failed before the prompt")
        report(on, ok, detail)
    }

    private fun requestOnMain(activity: FragmentActivity, on: Boolean) {
        val context = activity.applicationContext
        lastPromptError = null
        if (on == on(context)) {
            notifyResult(on, true)
            return
        }
        if (Build.VERSION.SDK_INT < 28) {
            report(on, false, "Android ${Build.VERSION.SDK_INT} < 9")
            return
        }
        canAuthenticateDetail(context)?.let {
            report(on, false, it)
            return
        }
        if (activity.isFinishing || activity.supportFragmentManager.isStateSaved) {
            report(on, false, "activity not resumed")
            return
        }
        lastKekError = null
        // Enabling with the lock off: the auth key protects nothing yet, so
        // regenerate it — an older build made it biometric-only, which
        // would refuse the screen-lock PIN.
        if (on) {
            try {
                KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(AUTH_KEK_ALIAS)
            } catch (e: Exception) {
                Log.w(TAG, "auth key reset failed", e)
            }
        }
        val kek = authKek()
        if (kek == null) {
            report(on, false, lastKekError ?: "auth key unavailable")
            return
        }
        if (on) {
            // The existing DEK only: with no plain wrap the core is running
            // keyless (encryption not set up yet) and a fresh key would not
            // match its databases.
            // 1) the key the running core actually uses, 2) the plain wrap,
            // 3) none yet (the core runs keyless): create it now — the next
            // (unlocked) start migrates the plaintext databases to it.
            val running = currentDek.takeIf { it.length == 64 }
            val dekHex = running ?: VeltaKeystore.readDek(context)
                ?: if (!VeltaKeystore.pinOn(context) && !VeltaKeystore.hasPlainWrap(context)) {
                    Log.i(TAG, "no database key yet; creating one for the lock")
                    VeltaKeystore.getOrCreateDek(context)
                } else null
            if (dekHex == null) {
                report(on, false, VeltaKeystore.lastError ?: "database key unavailable")
                return
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, kek)
            prompt(activity, cipher, activity.getString(R.string.biometric_enable_title)) { ok, c ->
                if (!ok || c == null) {
                    notifyResult(on, false)
                    return@prompt
                }
                val dek = try {
                    hexDecode(dekHex)
                } catch (e: IllegalArgumentException) {
                    Log.e(TAG, "bad DEK hex", e)
                    notifyResult(on, false)
                    return@prompt
                }
                val ct = try {
                    c.doFinal(dek)
                } catch (e: Exception) {
                    Log.e(TAG, "auth wrap encrypt failed", e)
                    report(on, false, "encrypt failed: ${e.javaClass.simpleName}: ${e.message}")
                    return@prompt
                }
                // The auth wrap lands BEFORE the plain wrap is removed — a
                // crash in between leaves both, and the plain one still
                // opens the databases (no lockout).
                if (writeWrap(authWrap(context), dek, c.iv, ct)) {
                    VeltaKeystore.deletePlainWrap(context)
                    Log.i(TAG, "biometric app lock enabled")
                    notifyResult(on, true)
                } else {
                    authWrap(context).delete()
                    report(on, false, "auth wrap write failed")
                }
            }
        } else {
            val blob = authWrap(context).readBytes()
            if (blob.size < 14 || blob[0] != 1.toByte()) {
                Log.e(TAG, "auth wrap unreadable; dropping the lock marker")
                authWrap(context).delete()
                notifyResult(on, true)
                return
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(128, blob.copyOfRange(1, 13)))
            prompt(activity, cipher, activity.getString(R.string.biometric_disable_title)) { ok, c ->
                var dek: ByteArray? = null
                if (ok && c != null) {
                    try {
                        dek = c.doFinal(blob, 13, blob.size - 13)
                    } catch (e: Exception) {
                        Log.e(TAG, "auth wrap decrypt failed", e)
                        lastPromptError = "decrypt failed: ${e.javaClass.simpleName}: ${e.message}"
                    }
                }
                // With the app-lock PIN on, it stays the key root: no plain
                // wrap comes back, the auth wrap just goes.
                val plain = dek?.let { if (VeltaKeystore.pinOn(context)) true else VeltaKeystore.storePlainWrap(context, it) }
                if (plain == true) {
                    authWrap(context).delete()
                    Log.i(TAG, "biometric app lock disabled")
                    notifyResult(on, true)
                } else {
                    notifyResult(on, false)
                }
            }
        }
    }

    /** Rust command entry: prompt on the registered activity, if any. */
    @JvmStatic
    fun requestFromContext(context: Context, on: Boolean, dek: String): Boolean {
        val a = activity ?: return false
        currentDek = dek
        request(a, on)
        return true
    }

    // ---- activity-side gating (cold start + auto-lock) --------------------

    private var hiddenAt = 0L
    private var lockOverlay: View? = null

    /** MainActivity.onCreate: cold start with the lock on — gate + DEK. */
    @JvmStatic
    fun onActivityCreated(activity: FragmentActivity) {
        this.activity = activity
        hiddenAt = System.currentTimeMillis()
        if (!on(activity)) return
        showLock(activity)
        requestUnlock(activity)
    }

    /** MainActivity.onResume: auto-lock after N minutes hidden. */
    @JvmStatic
    fun onActivityResumed(activity: FragmentActivity) {
        if (on(activity) && lockOverlay == null &&
            hiddenAt > 0 && autoLockMinutes(activity) > 0 &&
            System.currentTimeMillis() - hiddenAt >= autoLockMinutes(activity) * 60_000L
        ) {
            showLock(activity)
            reAuth(activity)
        }
    }

    /** MainActivity.onStop. */
    @JvmStatic
    fun onActivityStopped() {
        hiddenAt = System.currentTimeMillis()
    }

    @JvmStatic
    fun onActivityDestroyed() {
        activity = null
        lockOverlay = null
    }

    /** Cold start: unwrap the DEK with the auth key and hand it to Rust. */
    private fun requestUnlock(activity: FragmentActivity) {
        val context = activity.applicationContext
        val blob = authWrap(context).readBytes()
        if (blob.size < 14 || blob[0] != 1.toByte()) {
            Log.e(TAG, "auth wrap unreadable at cold start — staying locked")
            return
        }
        val kek = authKek() ?: return
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(128, blob.copyOfRange(1, 13)))
        prompt(activity, cipher, activity.getString(R.string.biometric_unlock_title)) { ok, c ->
            if (!ok || c == null) return@prompt
            val dek = try {
                c.doFinal(blob, 13, blob.size - 13)
            } catch (e: Exception) {
                Log.e(TAG, "auth wrap decrypt failed", e)
                return@prompt
            }
            VeltaCore.startWithDek(hex(dek))
            if (VeltaCore.running()) hideLock() else showRetry(activity)
        }
    }

    /** Auto-lock re-entry: a plain (no-crypto) confirmation prompt. */
    private fun reAuth(activity: FragmentActivity) {
        prompt(activity, null, activity.getString(R.string.biometric_unlock_title)) { ok, _ ->
            if (ok) hideLock()
        }
    }

    private fun showRetry(activity: FragmentActivity) {
        (lockOverlay as? ViewGroup)?.let { root ->
            root.findViewWithTag<Button>("velta-retry")?.visibility = View.VISIBLE
        }
    }

    private fun showLock(activity: FragmentActivity) {
        if (lockOverlay != null) return
        val root = FrameLayout(activity).apply {
            tag = "velta-lock-overlay"
            setBackgroundColor(Color.parseColor("#10131a"))
            isClickable = true
            isFocusable = true
        }
        val box = android.widget.LinearLayout(activity).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        val title = TextView(activity).apply {
            text = activity.getString(R.string.biometric_unlock_title)
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            setPadding(48, 0, 48, 32)
        }
        val retry = Button(activity).apply {
            tag = "velta-retry"
            text = activity.getString(R.string.biometric_retry)
            visibility = View.GONE
            setOnClickListener {
                it.visibility = View.GONE
                if (VeltaLock.on(activity) && lockOverlay != null) requestUnlock(activity)
            }
        }
        // App-lock PIN on too: the page behind shows the PIN screen.
        val usePin = Button(activity).apply {
            text = activity.getString(R.string.biometric_use_pin)
            visibility = if (VeltaKeystore.pinOn(activity)) View.VISIBLE else View.GONE
            setOnClickListener { hideLock() }
        }
        box.addView(title)
        // Retry + Use PIN share one row as equal columns (weight 1 each);
        // a GONE one leaves the other the full width. Labels wrap, never cut.
        val row = android.widget.LinearLayout(activity).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            setPadding(48, 0, 48, 0)
        }
        val gap = (8 * activity.resources.displayMetrics.density).toInt()
        for ((i, b) in listOf(retry, usePin).withIndex()) {
            b.isAllCaps = false
            b.maxLines = 3
            row.addView(b, android.widget.LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                if (i > 0) marginStart = gap
            })
        }
        box.addView(row, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        activity.runOnUiThread {
            (activity.window.decorView as? ViewGroup)?.addView(
                root,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            lockOverlay = root
        }
    }

    private fun hideLock() {
        val view = lockOverlay ?: return
        (view.parent as? ViewGroup)?.removeView(view)
        lockOverlay = null
    }

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            out[i * 2] = digits[(bytes[i].toInt() shr 4) and 0xf]
            out[i * 2 + 1] = digits[bytes[i].toInt() and 0xf]
        }
        return String(out)
    }

    private fun hexDecode(s: String): ByteArray {
        require(s.length == 64 && s.all { it.isDigit() || it in 'a'..'f' }) { "not a 32-byte hex" }
        return ByteArray(32) { i -> ((Character.digit(s[2 * i], 16) shl 4) or Character.digit(s[2 * i + 1], 16)).toByte() }
    }

    // Rust → the webview: the prompt finished. Declared in Rust as
    // Java_org_velta_VeltaLock_notifyResult; the result event drives the
    // settings row (the prompt is asynchronous). @JvmStatic: the Rust
    // export is a static JNI symbol — a plain external member of an object
    // would compile as an instance native and fail to link at first call.
    @JvmStatic
    private external fun notifyResult(on: Boolean, ok: Boolean, detail: String)

}
