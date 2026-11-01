package org.velta.kmp.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaCore

/** P1 application state: connect, login (add transport + configure), read paths. */
class AppModel(
    private val platform: CorePlatform,
    private val scope: CoroutineScope,
) {
    sealed interface Screen {
        data object Login : Screen
        data object ChatList : Screen
        data class Chat(val chatId: Long, val title: String) : Screen
    }

    var screen by mutableStateOf<Screen>(Screen.Login)
    var status by mutableStateOf("starting")
        private set
    var coreVersion by mutableStateOf("?")
        private set
    var connected by mutableStateOf(false)
        private set
    var accountAddr by mutableStateOf<String?>(null)
        private set
    var loginBusy by mutableStateOf(false)
        private set
    var loginProgress by mutableStateOf<String?>(null)
        private set
    var loginError by mutableStateOf<String?>(null)

    var chats by mutableStateOf<List<ChatListItem>>(emptyList())
    var chatsLoading by mutableStateOf(false)
        private set
    var chatMessages by mutableStateOf<List<MessageObject>>(emptyList())
    var chatLoading by mutableStateOf(false)
        private set

    private var core: VeltaCore? = null
    private var transport: RpcTransport? = null
    private var accountId: Long? = null

    fun connect() {
        scope.launch {
            status = "spawning rpc-server"
            val dir = platform.accountsDir()
            val spawned = platform.spawnRpcServer(dir)
            if (spawned == null) {
                status = "no deltachat-rpc-server binary found (set VELTA_KMP_RPC_SERVER)"
                return@launch
            }
            transport = spawned
            val client = RpcClient(spawned, log = { line -> println("velta-kmp: $line") })
            val veltaCore = VeltaCore(client)
            core = veltaCore

            try {
                status = "handshake"
                val info = veltaCore.systemInfo()
                coreVersion = (info["deltachat_core_version"]?.toString() ?: "?").trim('"')
                connected = true
                status = "connected"

                veltaCore.startEventLoop(scope) { event ->
                    handleEvent(event)
                }
            } catch (t: Throwable) {
                status = "connect failed: ${t.message}"
            }
        }
    }

    fun login(addr: String, password: String) {
        val veltaCore = core ?: return
        if (loginBusy) return
        scope.launch {
            loginBusy = true
            loginError = null
            loginProgress = null
            try {
                val id = accountId ?: veltaCore.addAccount().also { accountId = it }
                veltaCore.addTransport(id, addr, password)
                status = "configuring"
                veltaCore.configure(id)
                veltaCore.startIoForAllAccounts()
                accountAddr = veltaCore.accountInfo(id).addr
                refreshChats()
                screen = Screen.ChatList
            } catch (t: Throwable) {
                loginError = t.message ?: t.toString()
            } finally {
                loginBusy = false
                loginProgress = null
                status = if (accountId != null) "configured" else "connected"
            }
        }
    }

    fun refreshChats() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            chatsLoading = true
            try {
                val entries = veltaCore.chatlistEntries(id)
                val items = veltaCore.chatlistItems(id, entries)
                chats = items.sortedWith(
                    compareByDescending<ChatListItem> { it.isPinned }
                        .thenByDescending { it.lastUpdated ?: 0L },
                )
            } catch (t: Throwable) {
                println("velta-kmp: refreshChats failed: $t")
            } finally {
                chatsLoading = false
            }
        }
    }

    fun openChat(item: ChatListItem) {
        screen = Screen.Chat(item.id, item.name)
        loadMessages(item.id)
    }

    fun backToChatList() {
        screen = Screen.ChatList
        refreshChats()
    }

    private fun loadMessages(chatId: Long) {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            chatLoading = true
            try {
                val ids = veltaCore.messageIds(id, chatId)
                val messages = veltaCore.messages(id, ids)
                chatMessages = messages.sortedBy { it.sortTimestamp ?: it.timestamp }
            } catch (t: Throwable) {
                println("velta-kmp: loadMessages failed: $t")
            } finally {
                chatLoading = false
            }
        }
    }

    private suspend fun handleEvent(event: org.velta.kmp.core.CoreEvent) {
        when (event.kind) {
            "ConfigureProgress" -> {
                val comment = event.event?.get("comment")?.toString()?.trim('"')
                if (!comment.isNullOrBlank()) loginProgress = comment
            }
            "MsgsChanged", "IncomingMsg", "MsgsNoticed", "MsgDelivered" -> {
                when (val current = screen) {
                    is Screen.Chat -> if (current.chatId == event.chatId()) loadMessages(current.chatId)
                    Screen.ChatList -> refreshChats()
                    else -> {}
                }
            }
        }
    }

    private fun org.velta.kmp.core.CoreEvent.chatId(): Long? =
        (event?.get("chatId")?.toString())?.trim('"')?.toLongOrNull()
            ?: (event?.get("chat_id")?.toString())?.trim('"')?.toLongOrNull()
}
