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
import org.velta.kmp.ui.L
import org.velta.kmp.ui.LockPolicy
import java.io.File

/**
 * FragmentActivity: BiometricPrompt (app lock, #178 phase 4 port) requires it.
 */
class MainActivity : FragmentActivity() {

    private lateinit var model: AppModel

    /** Microphone for voice messages: asked on the first recording. */
    private var micAnswer: kotlinx.coroutines.CompletableDeferred<Boolean>? = null
    private val requestMic = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> micAnswer?.complete(granted); micAnswer = null }

    private suspend fun askMic(): Boolean {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) return true
        val answer = kotlinx.coroutines.CompletableDeferred<Boolean>()
        micAnswer?.complete(false)
        micAnswer = answer
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
            requestMic.launch(android.Manifest.permission.RECORD_AUDIO)
        }
        return answer.await()
    }

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

    /** Message sheet "Download" below API 29 (no MediaStore.Downloads):
     *  the SAF save dialog, stable's Android save path. */
    private var pendingSave: Pair<String, kotlinx.coroutines.CompletableDeferred<String?>>? = null
    private val createDocument = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri ->
        val (path, done) = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        if (uri == null) { done.complete("cancelled"); return@registerForActivityResult }
        done.complete(
            runCatching {
                contentResolver.openOutputStream(uri)?.use { out -> File(path).inputStream().use { it.copyTo(out) } }
                null
            }.getOrElse { it.message ?: it.toString() },
        )
    }

    /** Copy a core blob into Downloads (#334 step 5 "Download"). */
    /** Stable FileOpen.kt (#279): an original-named copy in cache/open-docs
     *  (the FileProvider's cache-path), then ACTION_VIEW. "no-app" when
     *  nothing can open it, so the page offers "Save as…". Copies older
     *  than a day are swept on the next open. */
    private suspend fun openWithSystem(path: String, name: String, mime: String?): String? =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            try {
                val dir = File(cacheDir, "open-docs").apply { mkdirs() }
                val dayAgo = System.currentTimeMillis() - 24 * 3600_000L
                dir.listFiles()?.forEach { f -> if (f.lastModified() < dayAgo) f.deleteRecursively() }
                val copy = File(File(dir, System.currentTimeMillis().toString()).apply { mkdirs() }, org.velta.kmp.ui.safeOpenName(name))
                File(path).copyTo(copy, overwrite = true)
                val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", copy)
                val ext = copy.name.substringAfterLast('.', "").lowercase()
                val byExt = if (ext.isEmpty()) null else android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
                val type = (if (mime == "text/plain") mime else null)
                    ?: byExt
                    ?: mime?.takeIf { it.contains('/') && it != "application/octet-stream" }
                    ?: "*/*"
                val view = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, type)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { startActivity(view) }
                null
            } catch (e: android.content.ActivityNotFoundException) {
                "no-app"
            } catch (t: Throwable) {
                t.message ?: t.toString()
            }
        }

    private suspend fun saveToDownloads(path: String, name: String, mime: String?): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            val done = kotlinx.coroutines.CompletableDeferred<String?>()
            pendingSave = path to done
            runOnUiThread { createDocument.launch(name) }
            return done.await()
        }
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching {
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime ?: "application/octet-stream")
                    put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
                    put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: error("no Downloads entry")
                try {
                    resolver.openOutputStream(uri)?.use { out -> File(path).inputStream().use { it.copyTo(out) } }
                        ?: error("cannot write")
                    values.clear()
                    values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                } catch (t: Throwable) {
                    resolver.delete(uri, null, null)
                    throw t
                }
                null
            }.getOrElse { it.message ?: it.toString() }
        }
    }

    /** Welcome splash "Restore from a backup…": stage the picked tar in
     * the cache (gzip PWA exports unpacked, stable prep_backup). */
    private val pickBackup = registerForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        try {
            val staged = File(cacheDir, "backup-${System.currentTimeMillis()}.tar")
            contentResolver.openInputStream(uri)?.use { raw ->
                val input = java.io.BufferedInputStream(raw)
                input.mark(2)
                val gzip = input.read() == 0x1f && input.read() == 0x8b
                input.reset()
                val src = if (gzip) java.util.zip.GZIPInputStream(input) else input
                staged.outputStream().use { output -> src.copyTo(output) }
            } ?: throw java.io.IOException("no stream")
            model.onBackupPicked(staged.absolutePath)
        } catch (t: Throwable) {
            model.onBackupPicked(null, t.message ?: t.toString())
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
     * App-lock prompt (no CryptoObject: a successful authentication opens
     * the Keystore auth window the keystore calls run inside). The allowed
     * authenticators come from LockPolicy and match the bio KEK's
     * requirement (strong biometric or device credential) — a weak face
     * unlock used to pass the prompt and then fail at the key, silently.
     * Failures land in model.lockError (lock screen + settings row).
     */
    private fun runAuthPrompt(onSuccess: () -> Unit) {
        val policy = LockPolicy.authenticators(Build.VERSION.SDK_INT)
        var allowed = 0
        if (policy.strongBiometric) allowed = allowed or BiometricManager.Authenticators.BIOMETRIC_STRONG
        if (policy.deviceCredential) allowed = allowed or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val can = BiometricManager.from(this).canAuthenticate(allowed)
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            model.onLockError(
                if (policy.deviceCredential) L.t("Set up a screen lock (PIN, pattern or password) or a fingerprint in Android settings first.")
                else L.t("Set up a fingerprint in Android settings first."),
            )
            return
        }
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    model.onLockError(null)
                    onSuccess()
                }

                override fun onAuthenticationError(code: Int, errString: CharSequence) {
                    println("velta-kmp: auth prompt error $code: $errString")
                    val userCancelled = code == BiometricPrompt.ERROR_USER_CANCELED ||
                        code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                        code == BiometricPrompt.ERROR_CANCELED
                    if (!userCancelled) {
                        model.onLockError(L.t("Authentication failed: {reason}").replace("{reason}", errString.toString()))
                    }
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Velta")
            .setSubtitle(L.t("Confirm to continue"))
            .setAllowedAuthenticators(allowed)
            .apply { if (policy.needsNegativeButton) setNegativeButtonText(L.t("Cancel")) }
            .build()
        prompt.authenticate(info)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Shared with the foreground service: one model, one core, one event loop.
        model = AppHolder.obtain(applicationContext)
        InAppBrowser.attach(this)
        model.openHttp = { InAppBrowser.open(it) }
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
        model.backupPicker = { pickBackup.launch(arrayOf("application/x-tar", "application/gzip", "application/octet-stream", "*/*")) }
        model.backupExportDir = { File(cacheDir, "backup-out").apply { mkdirs() }.absolutePath }
        model.newestFileIn = { dir ->
            File(dir).listFiles()?.filter { it.isFile }?.maxByOrNull { it.lastModified() }?.let { it.absolutePath to it.name }
        }
        model.saveFile = { path, name, mime -> saveToDownloads(path, name, mime) }
        model.openFile = { path, name, mime -> openWithSystem(path, name, mime) }
        model.mediaInLightbox = true
        model.videoInApp = true
        // The model outlives the activity (AppHolder): keep one engine and
        // one recorder so a rotation never orphans playback or a recording.
        if (model.audioEngine == null) model.audioEngine = AndroidAudioEngine()
        val mic: suspend () -> Boolean = { askMic() }
        (model.voiceRecorder as? AndroidVoiceRecorder)?.let { it.askMic = mic }
            ?: run { model.voiceRecorder = AndroidVoiceRecorder(applicationContext, mic) }
        // QR view "Share a link" (web shareLink → ACTION_SEND chooser).
        model.shareText = { text ->
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            startActivity(Intent.createChooser(send, null))
        }
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
                else model.onLockError(L.t("Couldn't unlock. Try again."))
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
        consumeLinkIntent(intent)
        // A recreated activity gets the original intent again: share once.
        if (savedInstanceState == null) consumeShareIntent(intent)
        setContent {
            App(model)
            LaunchedEffect(Unit) { model.connect() }
        }
        org.velta.kmp.push.VeltaPushService.maybeRegister(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeChatIntent(intent)
        consumeLinkIntent(intent)
        consumeShareIntent(intent)
    }

    /**
     * #334 step 7 — ACTION_SEND / SEND_MULTIPLE (stable routeOpenedBatch):
     * a shared text that is one invite / chatmail link opens like a tapped
     * link; other text and the streams become one share burst for the
     * "Share to…" picker. Streams are copied into the cache off the main
     * thread (the core reads plain paths), as the attachment picker does.
     */
    private fun consumeShareIntent(intent: Intent?) {
        val action = intent?.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val uris = LinkedHashSet<Uri>()
        if (action == Intent.ACTION_SEND) {
            @Suppress("DEPRECATION")
            (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)?.let { uris += it }
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris += it }
        }
        intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris += it } }
        intent.action = null
        val items = ArrayList<org.velta.kmp.ui.ShareItem>()
        when (val routed = text?.let { org.velta.kmp.ui.classifySharedText(it) }) {
            is org.velta.kmp.ui.SharedText.Link -> model.onQrScanned(routed.link)
            is org.velta.kmp.ui.SharedText.Text -> items += org.velta.kmp.ui.ShareItem(text = routed.text)
            else -> Unit
        }
        if (uris.isEmpty()) {
            model.receiveShare(items)
            return
        }
        Thread {
            for (uri in uris) {
                try {
                    var displayName = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
                    contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0 && cursor.moveToFirst()) displayName = cursor.getString(idx) ?: displayName
                    }
                    val safeName = displayName.replace(Regex("[/\\\\]"), "_")
                    val staged = File(cacheDir, "share-${System.currentTimeMillis()}-$safeName")
                    contentResolver.openInputStream(uri)?.use { input ->
                        staged.outputStream().use { output -> input.copyTo(output) }
                    } ?: continue
                    items += org.velta.kmp.ui.ShareItem(file = staged.absolutePath, name = displayName)
                } catch (t: Throwable) {
                    println("velta-kmp: share staging failed: $t")
                }
            }
            model.receiveShare(items)
        }.start()
    }

    /** Invite / chatmail-code links (manifest VIEW filters): same path as
     * a scanned QR — welcome splash or Join screen; parked until the core
     * is up on a cold start. */
    private fun consumeLinkIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val link = intent.dataString ?: return
        intent.data = null
        model.onQrScanned(link)
    }

    /** A notification tap carries the account + chat; the model switches
     * account if needed and opens the chat (now, or once the core is up). */
    private fun consumeChatIntent(intent: Intent?) {
        val chatId = intent?.getLongExtra("chatId", -1L) ?: -1L
        if (chatId <= 0) return
        val accountId = intent?.getLongExtra("accountId", -1L)?.takeIf { it > 0 }
        model.openFromNotification(accountId, chatId)
        // Consumed: a configuration change must not re-open it.
        intent?.removeExtra("chatId")
    }

    override fun onResume() {
        super.onResume()
        // Returning from the system battery dialog — re-read the exemption.
        model.refreshBattery()
    }

    override fun onDestroy() {
        InAppBrowser.detach(this)
        super.onDestroy()
    }

    override fun onStart() {
        super.onStart()
        model.onAppForeground(true)
        // App in the foreground: the user is looking at it, no service needed.
        VeltaForegroundService.stop(this)
    }

    override fun onStop() {
        super.onStop()
        model.onAppForeground(false)
        // App backgrounded: hold the process so the core keeps syncing.
        VeltaForegroundService.start(this)
    }
}
