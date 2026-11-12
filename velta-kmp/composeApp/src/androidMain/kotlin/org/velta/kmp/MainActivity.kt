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

    /** Camera capture (#321 step 3 web parity): ACTION_IMAGE_CAPTURE into a
     * cache file, staged like any other attachment. */
    private var cameraOut: java.io.File? = null
    private val takePicture = registerForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { ok ->
        if (ok) {
            cameraOut?.let { out ->
                model.onAttachmentPicked(out.absolutePath, out.name)
            }
        }
    }

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
     * Invite-QR scan. No ActivityResult here: FragmentActivity's legacy
     * startActivityForResult path rejects the registry-generated request
     * codes ("lower 16 bits"), and the model is a process-wide singleton —
     * ScanActivity hands the payload straight to it and finishes.
     */
    private fun startQrScan() {
        startActivity(Intent(this, org.velta.kmp.scan.ScanActivity::class.java))
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
        model.cameraCapture = {
            val out = File(
                cacheDir,
                "camera-${System.currentTimeMillis()}.jpg",
            )
            cameraOut = out
            takePicture.launch(androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", out))
        }
        model.attachmentPicker = { kind ->
            pickFile.launch(
                arrayOf(
                    when (kind) {
                        AppModel.AttachKind.PHOTO -> "image/*"
                        AppModel.AttachKind.VIDEO -> "video/*"
                        AppModel.AttachKind.FILE -> "*/*"
                    },
                ),
            )
        }
        model.requestQrScan = { startQrScan() }
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
        consumeChatIntent(intent)
        setContent {
            App(model)
            LaunchedEffect(Unit) { model.connect() }
        }
        org.velta.kmp.push.VeltaPushService.maybeRegister(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumeChatIntent(intent)
    }

    /** A notification tap carries the chat id; the list opens it on landing. */
    private fun consumeChatIntent(intent: Intent?) {
        val chatId = intent?.getLongExtra("chatId", -1L) ?: -1L
        if (chatId >= 0) model.pendingOpenChatId = chatId
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
