package org.velta

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Local chat (Loop, p2p.rs) on Android storage (#454): the folder picker
 * (the dialog plugin has none on Android), listing a picked tree for a
 * streamed folder send, and writing a received folder zip into a picked
 * tree (loopzip::extract_to through saf.rs TreeDest).
 *
 * Files cross to Rust as detached file descriptors (Rust owns and closes
 * them), so bytes never go through JNI arrays.
 */
object LoopFiles {
  private var activityRef: WeakReference<Activity>? = null
  private var launcher: ActivityResultLauncher<Uri?>? = null

  // pickTree state polled by Rust: null = nothing asked, "" = waiting,
  // "-" = cancelled, otherwise the tree URI.
  @Volatile private var result: String? = null

  /** MainActivity.onCreate, before the activity is started. */
  fun attach(activity: ComponentActivity) {
    activityRef = WeakReference(activity)
    launcher = activity.registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
      if (uri == null) {
        result = "-"
        return@registerForActivityResult
      }
      try {
        activity.contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
      } catch (_: Exception) {
        // Not every provider offers persistable grants; the session grant
        // is enough for this transfer.
      }
      result = uri.toString()
    }
  }

  /** Opens the system folder picker. false: no activity to show it on. */
  @JvmStatic
  fun pickTree(): Boolean {
    val activity = activityRef?.get() ?: return false
    val l = launcher ?: return false
    result = ""
    activity.runOnUiThread {
      try {
        l.launch(null)
      } catch (_: Exception) {
        result = "-"
      }
    }
    return true
  }

  /** "" while the picker is up, "-" when cancelled, else the tree URI. */
  @JvmStatic
  fun takeResult(): String {
    val r = result ?: return "-"
    if (r.isNotEmpty()) result = null
    return r
  }

  private fun rootDoc(tree: Uri): Uri =
    DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

  /**
   * {"name": root folder name, "entries": [{rel, dir, size, mtime (ms), uri}]}
   * depth-first; "" on error.
   */
  @JvmStatic
  fun listTree(context: Context, treeStr: String): String {
    return try {
      val tree = Uri.parse(treeStr)
      val root = rootDoc(tree)
      val out = JSONArray()
      walk(context, tree, DocumentsContract.getTreeDocumentId(tree), "", out)
      JSONObject().put("name", displayName(context, root) ?: "folder").put("entries", out).toString()
    } catch (e: Exception) {
      ""
    }
  }

  private fun walk(context: Context, tree: Uri, docId: String, prefix: String, out: JSONArray) {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    val dirs = ArrayList<Pair<String, String>>()
    context.contentResolver.query(children, cols, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0) ?: continue
        val name = c.getString(1) ?: continue
        val isDir = c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
        val rel = prefix + name
        out.put(
          JSONObject()
            .put("rel", rel)
            .put("dir", isDir)
            .put("size", if (isDir || c.isNull(3)) 0L else c.getLong(3))
            .put("mtime", if (c.isNull(4)) 0L else c.getLong(4))
            .put("uri", if (isDir) "" else DocumentsContract.buildDocumentUriUsingTree(tree, id).toString()),
        )
        if (isDir) dirs.add(id to "$rel/")
      }
    }
    for ((id, p) in dirs) walk(context, tree, id, p, out)
  }

  private fun displayName(context: Context, uri: Uri): String? =
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
      }
    } catch (_: Exception) {
      null
    }

  /** {"name", "size"} of a single content:// file (size -1 if unknown); "" on error. */
  @JvmStatic
  fun describe(context: Context, uriStr: String): String {
    return try {
      val uri = Uri.parse(uriStr)
      var name: String? = null
      var size = -1L
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          name = c.getString(0)
          if (!c.isNull(1)) size = c.getLong(1)
        }
      }
      if (size < 0) {
        context.contentResolver.openFileDescriptor(uri, "r")?.use { size = it.statSize }
      }
      JSONObject().put("name", name ?: "file").put("size", size).toString()
    } catch (_: Exception) {
      ""
    }
  }

  /** A detached read fd for a content:// file, -1 on error. */
  @JvmStatic
  fun openRead(context: Context, uriStr: String): Int =
    try {
      context.contentResolver.openFileDescriptor(Uri.parse(uriStr), "r")?.detachFd() ?: -1
    } catch (_: Exception) {
      -1
    }

  // Directory document URIs made during one extraction, by tree + rel path.
  private val dirCache = HashMap<String, Uri>()

  @Synchronized
  private fun dirFor(context: Context, tree: Uri, rel: String): Uri? {
    if (rel.isEmpty()) return rootDoc(tree)
    val key = "$tree|$rel"
    dirCache[key]?.let { return it }
    val parentRel = rel.substringBeforeLast('/', "")
    val name = rel.substringAfterLast('/')
    val parent = dirFor(context, tree, parentRel) ?: return null
    val found = findChild(context, tree, parent, name, true)
      ?: DocumentsContract.createDocument(context.contentResolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name)
      ?: return null
    dirCache[key] = found
    return found
  }

  private fun findChild(context: Context, tree: Uri, parent: Uri, name: String, dir: Boolean): Uri? {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
    )
    context.contentResolver.query(children, cols, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        if (c.getString(1) == name && (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) == dir) {
          return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
        }
      }
    }
    return null
  }

  /** Creates the folder `rel` (slash-separated) under the tree; false on error. */
  @JvmStatic
  fun mkdirs(context: Context, treeStr: String, rel: String): Boolean =
    try {
      dirFor(context, Uri.parse(treeStr), rel.trim('/')) != null
    } catch (_: Exception) {
      false
    }

  /**
   * Creates the file `rel` under the tree and returns a detached write fd
   * plus its document URI as "fd|uri", or "" on error. An existing name
   * gets the provider's " (1)" suffix rather than being overwritten.
   */
  @JvmStatic
  fun createFile(context: Context, treeStr: String, rel: String): String {
    return try {
      val tree = Uri.parse(treeStr)
      val clean = rel.trim('/')
      val parent = dirFor(context, tree, clean.substringBeforeLast('/', "")) ?: return ""
      val name = clean.substringAfterLast('/')
      val ext = name.substringAfterLast('.', "").lowercase()
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      val doc = DocumentsContract.createDocument(context.contentResolver, parent, mime, name) ?: return ""
      val fd = context.contentResolver.openFileDescriptor(doc, "w")?.detachFd() ?: return ""
      "$fd|$doc"
    } catch (_: Exception) {
      ""
    }
  }

  /** Deletes a document made by createFile (a failed or cancelled extract). */
  @JvmStatic
  fun remove(context: Context, docStr: String): Boolean =
    try {
      DocumentsContract.deleteDocument(context.contentResolver, Uri.parse(docStr))
    } catch (_: Exception) {
      false
    }

  /** Forget cached folder URIs once an extraction is done. */
  @JvmStatic
  @Synchronized
  fun endExtract() {
    dirCache.clear()
  }
}
