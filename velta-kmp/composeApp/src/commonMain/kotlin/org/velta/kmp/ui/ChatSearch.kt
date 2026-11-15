package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * Stable "Search in chat" (app.js openChatSearch): a modal with a search
 * field, a thin progress strip while the core's fulltext search runs, and
 * up to 30 hits (newest first) as "**Name**: text". A hit closes the modal
 * and jumps to the message, loading history if needed.
 */
@Composable
internal fun ChatSearchDialog(model: AppModel) {
    if (!model.chatSearchOpen) return
    val tokens = Velta.tokens
    val close = { model.closeChatSearch() }
    PlatformBackHandler { close() }
    SheetModal(title = L.t("Search in chat"), onClose = close) {
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { delay(50); runCatching { focus.requestFocus() } }
        val label = L.t("Search in chat")
        BasicTextField(
            value = model.chatSearchQuery,
            onValueChange = { model.searchInChat(it) },
            singleLine = true,
            textStyle = TextStyle(fontSize = 15.sp, color = tokens.text),
            cursorBrush = SolidColor(tokens.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .background(tokens.bg, RoundedCornerShape(10.dp))
                .border(1.dp, tokens.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .semantics { contentDescription = label },
            decorationBox = { inner ->
                Box {
                    if (model.chatSearchQuery.isEmpty()) Text(L.t("Search in chat…"), fontSize = 15.sp, color = tokens.textDim)
                    inner()
                }
            },
        )
        // .search-load-bar: a thin sweep under the field while the query runs.
        Box(Modifier.fillMaxWidth().height(3.dp).padding(top = 1.dp)) {
            if (model.chatSearchBusy) {
                val busy = L.t("Searching…")
                LinearProgressIndicator(
                    color = tokens.accent,
                    trackColor = tokens.border,
                    modifier = Modifier.fillMaxWidth().height(2.dp).semantics { contentDescription = busy },
                )
            }
        }
        val hits = model.chatSearchHits
        val error = model.chatSearchError
        when {
            error != null -> Text(L.t("Search failed:") + " " + error, fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.padding(vertical = 8.dp))
            hits != null && hits.isEmpty() -> Text(L.t("Nothing found."), fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.padding(vertical = 8.dp))
            hits != null -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                items(hits, key = { it.id }) { m ->
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(searchHitName(m)) }
                            append(": ")
                            append(searchHitText(m))
                        },
                        fontSize = 14.5.sp,
                        color = tokens.text,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { model.pickSearchHit(m) }
                            .padding(horizontal = 8.dp, vertical = 12.dp),
                    )
                }
            }
        }
    }
}
