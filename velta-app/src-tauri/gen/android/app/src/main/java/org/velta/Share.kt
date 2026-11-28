package org.velta

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File

// #37: native "Share a link" for the QR screen. The WebView has no Web Share
// API, so the page asks the shell (share_text in lib.rs, JNI) to show the
// system chooser for a plain-text payload (the invite link).
object Share {
    @JvmStatic
    fun text(context: Context, text: String, title: String): Boolean {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        // The stored context is the application context: starting an activity
        // from it needs NEW_TASK.
        val chooser = Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(chooser)
            true
        } catch (e: Exception) {
            false
        }
    }

    // Dash card Share: a decrypted cache copy (FileProvider) goes out through
    // the system share sheet. The copy lives under cache/open-docs and is
    // swept after a day, same as open_document.
    @JvmStatic
    fun file(context: Context, path: String, mimeHint: String, title: String): Boolean {
        return try {
            val file = File(path)
            if (!file.exists()) return false
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            val mime = mimeFor(file.name, mimeHint)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, title)
                clipData = ClipData.newRawUri(title, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, title)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // No per-package grants: the chooser intent carries the read
            // grant (ClipData + FLAG_GRANT_READ_URI_PERMISSION) and Android gives it
            // to the app the user picks, not to every candidate.
            context.startActivity(chooser)
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun mimeFor(name: String, hint: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        val byExt = if (ext.isEmpty()) null else MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        return byExt ?: hint.takeIf { it.contains('/') && it != "application/octet-stream" } ?: "*/*"
    }
}
