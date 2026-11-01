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
import org.velta.kmp.ui.App
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
    ) {
        // FileDialog blocks, so it runs on its own thread; the model hops the
        // result into its own scope. The scope's `window` is the ComposeWindow
        // (a java.awt.Frame).
        val awtFrame = window as java.awt.Frame
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
        App(model)
    }
}
