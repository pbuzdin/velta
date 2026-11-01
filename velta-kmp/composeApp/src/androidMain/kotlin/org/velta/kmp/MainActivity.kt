package org.velta.kmp

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.LaunchedEffect
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.velta.kmp.core.VeltaForegroundService
import org.velta.kmp.core.VeltaKeystore
import org.velta.kmp.ui.App
import org.velta.kmp.ui.AppModel
import java.io.File

/**
 * FragmentActivity: BiometricPrompt (app lock, #178 phase 4 port) requires it.
 */
class MainActivity : FragmentActivity() {

    private lateinit var model: AppModel

    /** Notification permission (API 33+) — the foreground service needs it to show. */
    private val requestNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    /** SAF picker → stage the content URI into a cache file the core can read. */
    private val pickFile = registerForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            try {
                var displayName = uri.lastPathSegment ?: "attachment"
                contentResolver
                    .query(uri, null, null, null, null)
                    ?.use { cursor ->
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0 && cursor.moveToFirst()) displayName = cursor.getString(idx) ?: displayName
                    }
                val safeName = displayName.replace(Regex("[/\\\\]"), "_")
                val staged = File(cacheDir, "attach-${System.currentTimeMillis()}-$safeName")
                contentResolver.openInputStream(uri)?.use { input ->
                    staged.outputStream().use { output -> input.copyTo(output) }
                }
                model.onAttachmentPicked(staged.absolutePath, displayName)
            } catch (t: Throwable) {
                println("velta-kmp: attachment staging failed: $t")
            }
        }
    }

    /**
     * App-lock prompt (biometric or device credential — no CryptoObject: a
     * successful authentication opens the 30 s Keystore auth window the
     * keystore calls run inside).
     */
    private fun runAuthPrompt(onSuccess: () -> Unit) {
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onSuccess()
                }

                override fun onAuthenticationError(code: Int, errString: CharSequence) {
                    println("velta-kmp: auth prompt error $code: $errString")
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Velta")
            .setSubtitle("Confirm to continue")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_WEAK or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            )
            .build()
        prompt.authenticate(info)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Shared with the foreground service: one model, one core, one event loop.
        model = AppHolder.obtain(applicationContext)
        model.attachmentPicker = { pickFile.launch(arrayOf("*/*")) }
        model.batteryCheck = {
            val pm = getSystemService(android.os.PowerManager::class.java)
            pm?.isIgnoringBatteryOptimizations(packageName)
        }
        model.requestBatteryExemption = {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                ),
            )
        }
        model.requestUnlock = {
            runAuthPrompt {
                val dek = VeltaKeystore.unlockDek(applicationContext)
                if (dek != null) model.onAppUnlocked(dek)
                else println("velta-kmp: unlock succeeded but the DEK unwrap failed")
            }
        }
        model.requestAppLockEnable = {
            runAuthPrompt { model.onAppLockEnabled() }
        }
        model.requestAppLockDisable = {
            runAuthPrompt { model.onAppLockDisabled() }
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            App(model)
            LaunchedEffect(Unit) { model.connect() }
        }
        org.velta.kmp.push.VeltaPushService.maybeRegister(this)
    }

    override fun onResume() {
        super.onResume()
        // Returning from the system battery dialog — re-read the exemption.
        model.refreshBattery()
    }

    override fun onStart() {
        super.onStart()
        // App in the foreground: the user is looking at it, no service needed.
        VeltaForegroundService.stop(this)
    }

    override fun onStop() {
        super.onStop()
        // App backgrounded: hold the process so the core keeps syncing.
        VeltaForegroundService.start(this)
    }
}
