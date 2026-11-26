package org.velta

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
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

    // #548: Copy image — Android clipboards carry images by content URI, so
    // the decrypted cache copy goes out as ClipData through the same
    // FileProvider that powers ACTION_VIEW. Paste targets read the bytes
    // lazily through the granted URI; nothing is decoded here.
    @JvmStatic
    fun copyImage(context: Context, path: String, mimeHint: String): Int {
        return try {
            val file = File(path)
            if (!file.exists()) return 2
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            val clip = ClipData.newUri(context.contentResolver, mimeFor(file.name, mimeHint), uri)
            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
            0
        } catch (e: Exception) {
            2
        }
    }

    // Dash card Save: create a Movies/Velta, Pictures/Velta or Download/Velta
    // destination and return "dest\nfolder" so Rust can stream-decrypt into it.
    // dest is a content URI (API 29+) or a filesystem path (older). Empty on
    // failure. finishSave commits or rolls the entry back.
    @JvmStatic
    fun beginSave(context: Context, kind: String, name: String): String {
        return try {
            val folder = folderFor(kind)
            val mime = mimeFor(name, "")
            val dest = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                beginMediaStore(context, kind, name, mime, folder)
            } else {
                beginPublicFile(kind, name)?.absolutePath
            }
            if (dest.isNullOrEmpty()) "" else "$dest\n$folder"
        } catch (_: Exception) {
            ""
        }
    }

    @JvmStatic
    fun finishSave(context: Context, dest: String, success: Boolean) {
        if (dest.startsWith("content:")) {
            val uri = Uri.parse(dest)
            val resolver = context.contentResolver
            if (success) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                try { resolver.update(uri, values, null, null) } catch (_: Exception) {}
            } else {
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
            }
            return
        }
        val file = File(dest)
        if (!success) {
            file.delete()
            return
        }
        try {
            MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(mimeFor(file.name, "")), null)
        } catch (_: Exception) {}
    }

    private fun folderFor(kind: String): String = when (kind) {
        "video" -> "Movies/Velta"
        "image" -> "Pictures/Velta"
        else -> "Download/Velta"
    }

    private fun beginMediaStore(context: Context, kind: String, name: String, mime: String, folder: String): String? {
        val collection: Uri = when (kind) {
            "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            else -> MediaStore.Downloads.EXTERNAL_CONTENT_URI
        }
        val relative = "$folder/"
        val display = uniqueDisplayName(context, collection, relative, name)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, display)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        return context.contentResolver.insert(collection, values)?.toString()
    }

    private fun uniqueDisplayName(context: Context, collection: Uri, relative: String, name: String): String {
        val clean = sanitizeName(name)
        val (stem, ext) = splitName(clean)
        var n = 0
        while (n < 100) {
            val candidate = if (n == 0) clean else "$stem ($n)$ext"
            val exists = try {
                context.contentResolver.query(
                    collection,
                    arrayOf(MediaStore.MediaColumns._ID),
                    "${MediaStore.MediaColumns.DISPLAY_NAME}=? AND ${MediaStore.MediaColumns.RELATIVE_PATH}=?",
                    arrayOf(candidate, relative),
                    null,
                )?.use { it.moveToFirst() } == true
            } catch (_: Exception) {
                false
            }
            if (!exists) return candidate
            n++
        }
        return "$stem-${System.currentTimeMillis()}$ext"
    }

    private fun beginPublicFile(kind: String, name: String): File? {
        val type = when (kind) {
            "video" -> Environment.DIRECTORY_MOVIES
            "image" -> Environment.DIRECTORY_PICTURES
            else -> Environment.DIRECTORY_DOWNLOADS
        }
        val dir = File(Environment.getExternalStoragePublicDirectory(type), "Velta")
        if (!dir.exists() && !dir.mkdirs()) return null
        return uniqueFile(dir, name)
    }

    private fun uniqueFile(dir: File, name: String): File {
        val clean = sanitizeName(name)
        val (stem, ext) = splitName(clean)
        var n = 0
        while (n < 100) {
            val f = File(dir, if (n == 0) clean else "$stem ($n)$ext")
            if (!f.exists()) return f
            n++
        }
        return File(dir, "$stem-${System.currentTimeMillis()}$ext")
    }

    private fun sanitizeName(name: String): String {
        val trimmed = name.trim().ifEmpty { "file" }
        val base = trimmed.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base.map { c ->
            if (c.isISOControl() || c in ":*?\"<>|") '_' else c
        }.joinToString("").trim('.', ' ')
        return cleaned.ifEmpty { "file" }.take(120)
    }

    private fun splitName(name: String): Pair<String, String> {
        val dot = name.lastIndexOf('.')
        return if (dot > 0) name.substring(0, dot) to name.substring(dot) else name to ""
    }

    private fun mimeFor(name: String, hint: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        val byExt = if (ext.isEmpty()) null else MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        return byExt ?: hint.takeIf { it.contains('/') && it != "application/octet-stream" } ?: "*/*"
    }
}
