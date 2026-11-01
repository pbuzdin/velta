package org.velta.kmp

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.velta.kmp.core.VeltaForegroundService
import org.velta.kmp.ui.App
import org.velta.kmp.ui.AppModel
import java.io.File

class MainActivity : ComponentActivity() {

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
                        val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = AppModel(
            AndroidCorePlatform(applicationContext),
            CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
        model.attachmentPicker = { pickFile.launch(arrayOf("*/*")) }
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
