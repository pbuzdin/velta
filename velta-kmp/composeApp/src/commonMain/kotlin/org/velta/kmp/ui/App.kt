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
            "KMP client · core $model.coreVersion · ${model.status}",
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
                            listOfNotNull(model.accountAddr, "core $model.coreVersion").joinToString(" · "),
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(model: AppModel, chat: AppModel.Screen.Chat) {
    val listState = rememberLazyListState()
    LaunchedEffect(model.chatMessages.size) {
        if (model.chatMessages.isNotEmpty()) {
            listState.animateScrollToItem(model.chatMessages.size - 1)
        }
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
    ) { inner ->
        LazyColumn(
            modifier = Modifier.padding(inner).fillMaxSize(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp, horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(model.chatMessages, key = { it.id }) { message ->
                MessageBubble(message)
            }
        }
    }
}

@Composable
private fun MessageBubble(message: MessageObject) {
    val outgoing = message.fromId == 1L // ContactId.SELF
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
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
                if (message.text.isNotBlank()) {
                    Text(message.text, style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    formatTimestamp(message.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                    modifier = Modifier.align(Alignment.End),
                )
            }
        }
    }
}
