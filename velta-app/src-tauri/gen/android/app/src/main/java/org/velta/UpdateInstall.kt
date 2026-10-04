package org.velta

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

// #60: hand a downloaded APK to the system package installer without a
// browser detour. The APK lives in the app's cache dir, which
// res/xml/file_paths.xml already exposes through the manifest FileProvider
// (cache-path "."). Launching the ACTION_VIEW package-archive intent surfaces
// the system "install unknown apps" authorization on first use; Velta stays
// in the foreground behind the installer sheet.
object UpdateInstall {
    @JvmStatic
    fun install(context: Context, path: String): Boolean {
        val file = File(path)
        if (!file.exists()) return false
        val uri: Uri = FileProvider.getUriForFile(
            context,
            context.packageName + ".fileprovider",
            file
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }
}
