package org.velta.kmp.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.velta.kmp.core.Diag

/**
 * Settings → Diagnostics (#516): the in-memory Diag ring buffer, newest
 * first, with share/copy so a support report no longer needs adb. "Diagnostics"
 * stays an English literal — it is not a key in the web packs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticsScreen(model: AppModel) {
    // Recompose on every new entry.
    Diag.version
    val entries = Diag.snapshot().asReversed()
    val clipboard = LocalClipboardManager.current
    val shareBody = {
        entries.asReversed().joinToString("\n") { e ->
            val time = if (e.atSeconds > 0) formatTimestamp(e.atSeconds) else "—"
            "$time ${e.level} ${e.text}"
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Diagnostics") },
                navigationIcon = {
                    TextButton(onClick = { model.backFromDiagnostics() }) {
                        Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim)
                    }
                },
                actions = {
                    if (model.shareText != null) {
                        TextButton(onClick = { model.shareText?.invoke(shareBody()) }) { Text(L.t("Share")) }
                    }
                    TextButton(onClick = { clipboard.setText(AnnotatedString(shareBody())) }) { Text(L.t("Copy")) }
                    TextButton(onClick = { Diag.clear() }) { Text(L.t("Clear")) }
                },
            )
        },
        bottomBar = { ToastHost(model) },
    ) { inner ->
        if (entries.isEmpty()) {
            Column(Modifier.padding(inner).fillMaxSize().padding(16.dp)) {
                // Not a web-pack key: plain literal per the i18n rule.
                Text("No diagnostics recorded yet", color = Velta.tokens.textDim)
            }
        } else {
            LazyColumn(Modifier.padding(inner).fillMaxSize()) {
                items(entries) { e ->
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            if (e.atSeconds > 0) formatTimestamp(e.atSeconds) else "—",
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            color = Velta.tokens.textDim,
                            modifier = Modifier.padding(end = 8.dp),
                        )
                        Text(
                            e.text,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = if (e.level == 'w') Velta.tokens.danger else Velta.tokens.text,
                        )
                    }
                    HorizontalDivider(color = Velta.tokens.border.copy(alpha = 0.4f))
                }
            }
        }
    }
}
