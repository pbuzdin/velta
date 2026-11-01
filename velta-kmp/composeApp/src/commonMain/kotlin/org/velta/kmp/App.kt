package org.velta.kmp

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

/** P0 placeholder shell — the real UI grows here phase by phase (issue #192). */
@Composable
fun App() {
    MaterialTheme {
        Scaffold { inner ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(inner),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Velta", style = MaterialTheme.typography.displaySmall)
                Text("KMP scaffold · ${platformName()}", style = MaterialTheme.typography.bodyLarge)
                Text("tracking issue #192", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/** Which platform entry point is running — replaced by the JSON-RPC core bridge in P1. */
expect fun platformName(): String
