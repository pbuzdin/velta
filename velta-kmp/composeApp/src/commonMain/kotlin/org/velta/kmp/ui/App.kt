package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.MessageObject
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** P1 read-path UI: login, chat list, chat view. Bare bones by design (issue #192). */
@Composable
fun App(model: AppModel) {
    MaterialTheme(colorScheme = darkColorScheme()) {
        Surface(modifier = Modifier.fillMaxSize()) {
            when (val current = model.screen) {
                AppModel.Screen.Login -> LoginScreen(model)
                AppModel.Screen.ChatList -> ChatListScreen(model)
                is AppModel.Screen.Chat -> ChatScreen(model, current)
            }
        }
    }
}

@Composable
private fun LoginScreen(model: AppModel) {
    var addr by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Velta", style = MaterialTheme.typography.displaySmall)
        Text(
            "KMP client · core ${model.coreVersion} · ${model.status}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.size(32.dp))

        OutlinedTextField(
            value = addr,
            onValueChange = { addr = it },
            label = { Text("Address") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.size(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.size(16.dp))

        Button(
            onClick = { model.login(addr.trim(), password) },
            enabled = model.connected && !model.loginBusy && addr.isNotBlank() && password.isNotBlank(),
        ) {
            Text(if (model.loginBusy) "Configuring…" else "Sign in")
        }
        model.loginProgress?.let {
            Spacer(Modifier.size(8.dp))
            Text(it, style = MaterialTheme.typography.bodySmall)
        }
        model.loginError?.let {
            Spacer(Modifier.size(8.dp))
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (!model.connected) {
            Spacer(Modifier.size(16.dp))
            Text(
                model.status,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.size(24.dp))
        Text(
            "P1 bridge demo — use a throwaway account",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatListScreen(model: AppModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Velta")
                        Text(
                            listOfNotNull(model.accountAddr, "core ${model.coreVersion}").joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    if (model.chatsLoading) {
                        CircularProgressIndicator(Modifier.size(20.dp))
                        Spacer(Modifier.size(12.dp))
                    }
                    TextButton(onClick = { model.refreshChats() }) { Text("Refresh") }
                },
            )
        },
    ) { inner ->
        if (model.chats.isEmpty()) {
            Box(Modifier.padding(inner).fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (model.chatsLoading) "Loading…" else "No chats yet",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.padding(inner)) {
                items(model.chats, key = { it.id }) { item ->
                    ChatListRow(item) { model.openChat(item) }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun ChatListRow(item: ChatListItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(color = chatColor(item.color), shape = RoundedCornerShape(22.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(item.name.take(1).uppercase(), fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, fontWeight = FontWeight.SemiBold)
            val summary = listOf(item.summaryText1, item.summaryText2)
                .filter { it.isNotBlank() }
                .joinToString(" ")
            if (summary.isNotBlank()) {
                Text(
                    summary,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        if (item.freshMessageCounter > 0) {
            Badge { Text(item.freshMessageCounter.toString()) }
        }
    }
}

/** Parse the core's "#rrggbb" chat color; falls back to a slate blue. */
private fun chatColor(hex: String?): androidx.compose.ui.graphics.Color {
    val rgb = hex?.removePrefix("#")?.toLongOrNull(16)
    val argb = if (rgb != null) (0xFF000000L or rgb) else 0xFF335577L
    return androidx.compose.ui.graphics.Color(argb)
}

/** One row of the chat view: a day separator or a message. */
private sealed interface ChatRow {
    val key: String

    data class Header(val text: String) : ChatRow {
        override val key: String get() = "h:$text"
    }

    data class Message(val message: MessageObject) : ChatRow {
        override val key: String get() = "m:${message.id}"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(model: AppModel, chat: AppModel.Screen.Chat) {
    val listState = rememberLazyListState()
    LaunchedEffect(model.chatMessages.size) {
        if (model.chatMessages.isNotEmpty()) {
            listState.animateScrollToItem(chatRows(model.chatMessages).size - 1)
        }
    }

    // System back (Android) returns to the chat list; desktop uses ‹ Back.
    PlatformBackHandler {
        model.backToChatList()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(chat.title) },
                navigationIcon = {
                    TextButton(onClick = { model.backToChatList() }) { Text("‹ Back") }
                },
                actions = {
                    if (model.chatLoading) CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.size(12.dp))
                },
            )
        },
        bottomBar = { Composer(model) },
    ) { inner ->
        val rows = chatRows(model.chatMessages)
        LazyColumn(
            modifier = Modifier.padding(inner).fillMaxSize(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp, horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is ChatRow.Header -> DayHeader(row.text)
                    is ChatRow.Message -> MessageBubble(
                        message = row.message,
                        senderName = if (chat.isGroup) model.senderNames[row.message.fromId] else null,
                    )
                }
            }
        }
    }
}

/** Group messages by local calendar date, inserting a header where the day changes. */
private fun chatRows(messages: List<MessageObject>): List<ChatRow> {
    val rows = mutableListOf<ChatRow>()
    var lastDay: String? = null
    for (message in messages) {
        val day = formatDateHeader(message.timestamp)
        if (day != lastDay) {
            rows += ChatRow.Header(day)
            lastDay = day
        }
        rows += ChatRow.Message(message)
    }
    return rows
}

@Composable
private fun DayHeader(text: String) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .background(
                    MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(10.dp),
                )
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

private fun viewTypeGlyph(viewType: String): String = when (viewType) {
    "Image" -> "📷"
    "Gif" -> "🖼"
    "Video" -> "🎞"
    "Sticker" -> "✨"
    "Audio" -> "🎵"
    "Voice" -> "🎤"
    "File" -> "📎"
    "Webxdc" -> "🌐"
    else -> "📎"
}

/** Outgoing delivery state (core/src/message.rs): 20 pending, 24 failed, 26 delivered, 28 read. */
private fun stateGlyph(state: Int): String? = when (state) {
    20 -> "⏳"
    24 -> "⚠️"
    26 -> "✓"
    28 -> "✓✓"
    else -> null
}

@Composable
private fun Composer(model: AppModel) {
    val reply = model.replyTo
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        if (reply != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "↩ ${reply.text.take(60)}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                TextButton(onClick = { model.replyTo = null }) { Text("✕") }
            }
        }
        model.sendError?.let {
            Text(
                "send failed: $it",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Row(verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = model.composerText,
                onValueChange = { model.composerText = it },
                placeholder = { Text("Message") },
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
            Spacer(Modifier.size(8.dp))
            Button(
                onClick = { model.send() },
                enabled = !model.sending && model.composerText.isNotBlank(),
            ) {
                Text(if (model.sending) "…" else "Send")
            }
        }
    }
}

@Composable
private fun MessageBubble(message: MessageObject, senderName: String?) {
    val outgoing = message.fromId == 1L // ContactId.SELF
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Column(horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
            if (!outgoing && senderName != null) {
                Text(
                    senderName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 12.dp, bottom = 1.dp),
                )
            }
            Surface(
                color = if (outgoing) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.widthIn(max = 420.dp).heightIn(min = 20.dp),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    if (message.viewType != "Text") {
                        Text(
                            "${viewTypeGlyph(message.viewType)} ${message.viewType}",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (message.text.isNotBlank()) {
                        Text(message.text, style = MaterialTheme.typography.bodyMedium)
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.align(Alignment.End),
                    ) {
                        Text(
                            formatTimestamp(message.timestamp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (outgoing) {
                            stateGlyph(message.state)?.let { glyph ->
                                Spacer(Modifier.size(4.dp))
                                Text(
                                    glyph,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
