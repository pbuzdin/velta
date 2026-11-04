package org.velta

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File

// #279: open a decrypted document copy (app cache, see open_document in
// lib.rs) in the user's default app. The cache dir is exposed through the
// manifest FileProvider (res/xml/file_paths.xml cache-path "."). With no
// default set, Android shows its own app chooser; with no app at all,
// return 1 so the page can offer "Save as…".
object FileOpen {
    @JvmStatic
    fun open(context: Context, path: String, mimeHint: String): Int {
        return try {
            val file = File(path)
            if (!file.exists()) return 2
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeFor(file.name, mimeHint))
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
            0
        } catch (e: ActivityNotFoundException) {
            1
        } catch (e: Exception) {
            2
        }
    }

    private fun mimeFor(name: String, hint: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        val byExt = if (ext.isEmpty()) null else MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        return byExt ?: hint.takeIf { it.contains('/') && it != "application/octet-stream" } ?: "*/*"
    }
}
