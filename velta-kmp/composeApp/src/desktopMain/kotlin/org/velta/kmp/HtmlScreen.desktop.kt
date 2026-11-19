package org.velta.kmp.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** No WebView on desktop. The system browser would run the mail's scripts. */
@Suppress("UNUSED_PARAMETER")
@Composable
internal actual fun HtmlBody(model: AppModel, screen: AppModel.Screen.Html, modifier: Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            "This page opens in the Android app",
            modifier = Modifier.padding(24.dp),
            textAlign = TextAlign.Center,
        )
    }
}
