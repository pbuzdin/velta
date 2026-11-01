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
        App(model)
    }
}
