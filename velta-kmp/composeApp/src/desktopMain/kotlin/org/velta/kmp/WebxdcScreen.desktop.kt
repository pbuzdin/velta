package org.velta.kmp

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import org.velta.kmp.ui.AppModel

/** Desktop is the web app — webxdc apps run there natively. */
@Composable
actual fun WebxdcScreen(model: AppModel, screen: AppModel.Screen.Webxdc) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("webxdc apps run in the web app")
    }
}
