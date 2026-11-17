package org.velta.kmp

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.jetbrains.compose.resources.painterResource
import org.velta.kmp.generated.resources.Res
import org.velta.kmp.generated.resources.icon_preview_badge
import org.velta.kmp.generated.resources.icon_preview_classic
import org.velta.kmp.generated.resources.icon_preview_default
import org.velta.kmp.ui.App
import org.velta.kmp.ui.AppIconChoice
import org.velta.kmp.ui.AppModel
import java.awt.FileDialog
import java.io.File

fun main() = application {
    val model = remember {
        AppModel(DesktopCorePlatform(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
    }
    LaunchedEffect(Unit) { model.connect() }

    Window(
        onCloseRequest = ::exitApplication,
        title = "Velta",
        state = rememberWindowState(width = 900.dp, height = 680.dp),
        icon = painterResource(
            when (model.appIconChoice) {
                AppIconChoice.Classic -> Res.drawable.icon_preview_classic
                AppIconChoice.Badge -> Res.drawable.icon_preview_badge
                AppIconChoice.Default -> Res.drawable.icon_preview_default
            },
        ),
    ) {
        // FileDialog blocks, so it runs on its own thread; the model hops the
        // result into its own scope. The scope's `window` is the ComposeWindow
        // (a java.awt.Frame).
        val awtFrame = window as java.awt.Frame
        model.backupExportDir = {
            File(System.getProperty("java.io.tmpdir"), "velta-backup").apply { mkdirs() }.absolutePath
        }
        model.newestFileIn = { dir ->
            File(dir).listFiles()?.filter { it.isFile }?.maxByOrNull { it.lastModified() }?.let { it.absolutePath to it.name }
        }
        model.attachmentPicker = {
            Thread {
                val dialog = FileDialog(awtFrame, "Attach file", FileDialog.LOAD)
                dialog.isVisible = true
                val chosen = dialog.file?.let { File(dialog.directory, it) }
                if (chosen != null && chosen.isFile) {
                    model.onAttachmentPicked(chosen.absolutePath, chosen.name)
                }
            }.start()
        }
        // Message sheet "Download": a save dialog, then copy the blob.
        model.saveFile = { path, name, _ ->
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val dialog = FileDialog(awtFrame, "Save", FileDialog.SAVE)
                dialog.file = name
                dialog.isVisible = true
                val target = dialog.file?.let { File(dialog.directory, it) }
                if (target == null) "cancelled"
                else runCatching { File(path).copyTo(target, overwrite = true); null }.getOrElse { it.message ?: it.toString() }
            }
        }
        // Tap on a file: an original-named copy, then the desktop's default app.
        model.openFile = { path, name, _ ->
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    val dir = File(System.getProperty("java.io.tmpdir"), "velta-open-docs").apply { mkdirs() }
                    val copy = File(dir, org.velta.kmp.ui.safeOpenName(name))
                    File(path).copyTo(copy, overwrite = true)
                    if (!java.awt.Desktop.isDesktopSupported()) return@runCatching "no-app"
                    java.awt.Desktop.getDesktop().open(copy)
                    null
                }.getOrElse { it.message ?: it.toString() }
            }
        }
        App(model)
    }
}
