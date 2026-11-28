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
    /**
     * Only the APK the in-app updater downloaded (Velta-<v>-arm64.apk under
     * the app cache dir; Tauri's app_cache_dir is cacheDir/<identifier>) goes
     * to the installer; any other path is refused.
     */
    @JvmStatic
    fun isDownloadedApk(cacheDir: File, file: File): Boolean {
        if (!file.isFile) return false
        val name = file.name
        if (!name.startsWith("Velta-") || !name.endsWith("-arm64.apk")) return false
        val root = cacheDir.canonicalPath + File.separator
        return file.canonicalPath.startsWith(root)
    }

    @JvmStatic
    fun install(context: Context, path: String): Boolean {
        val file = File(path)
        if (!isDownloadedApk(context.cacheDir, file)) return false
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
