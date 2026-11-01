package org.velta.kmp.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.Contact
import org.velta.kmp.core.CoreEvent
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaCore

/**
 * P2 application state: connect, RESUME a persisted account (the core's
 * accounts dir is the storage — no app-level settings), login fallback,
 * read paths with event-driven refresh.
 */
class AppModel(
    private val platform: CorePlatform,
    private val scope: CoroutineScope,
) {
    sealed interface Screen {
        data object Login : Screen
        data object ChatList : Screen
        data class Chat(val chatId: Long, val title: String, val isGroup: Boolean) : Screen
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
    var senderNames by mutableStateOf<Map<Long, String>>(emptyMap())
        private set

    private var core: VeltaCore? = null
    private var transport: RpcTransport? = null
    private var accountId: Long? = null

    /** An account that exists but is not configured — reused by the next login attempt. */
    private var unconfiguredAccountId: Long? = null

    fun connect() {
        scope.launch {
            status = "spawning core"
            val dir = platform.accountsDir()
            val spawned = platform.spawnRpcServer(dir)
            if (spawned == null) {
                status = platform.connectHint()
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

                veltaCore.startEventLoop(scope) { event ->
                    handleEvent(event)
                }

                resumeSession(veltaCore)
            } catch (t: Throwable) {
                status = "connect failed: ${t.message}"
            }
        }
    }

    /**
     * P2 persistence: the core's accounts dir already holds every account.
     * Resume the first configured one straight into the chat list; keep an
     * unconfigured one around so a login retry doesn't create duplicates.
     */
    private suspend fun resumeSession(veltaCore: VeltaCore) {
        status = "looking for accounts"
        val ids = veltaCore.allAccountIds()
        var configured: org.velta.kmp.core.Account? = null
        var unconfigured: Long? = null
        for (id in ids) {
            val info = runCatching { veltaCore.accountInfo(id) }.getOrNull() ?: continue
            if (configured == null && info.isConfigured == true) {
                configured = info
            } else if (unconfigured == null && info.isConfigured != true) {
                unconfigured = id
            }
        }
        unconfiguredAccountId = unconfigured
        val account = configured
        if (account != null) {
            accountId = account.id
            accountAddr = account.addr
            // Sequential on purpose: the chat list is loaded BEFORE the screen
            // switches, so resume never flashes an empty list.
            loadChats()
            screen = Screen.ChatList
            status = "resumed ${account.addr ?: ""}".trim()
        } else {
            status = "connected"
            screen = Screen.Login
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
                val id = accountId
                    ?: unconfiguredAccountId
                    ?: veltaCore.addAccount().also {
                        accountId = it
                    }
                unconfiguredAccountId = null
                veltaCore.addTransport(id, addr.trim(), password)
                status = "configuring"
                veltaCore.configure(id)
                veltaCore.startIoForAllAccounts()
                accountAddr = veltaCore.accountInfo(id).addr
                loadChats()
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
        scope.launch { loadChats() }
    }

    private suspend fun loadChats() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
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

    fun openChat(item: ChatListItem) {
        screen = Screen.Chat(item.id, item.name, item.isGroup)
        scope.launch {
            val veltaCore = core
            val id = accountId
            if (veltaCore != null && id != null) {
                try {
                    veltaCore.marknoticedChat(id, item.id)
                } catch (t: Throwable) {
                    println("velta-kmp: marknoticed failed: $t")
                }
            }
        }
        loadMessages(item.id)
        refreshChats()
    }

    fun backToChatList() {
        screen = Screen.ChatList
        refreshChats()
    }

    private fun loadMessages(chatId: Long, isGroup: Boolean = false) {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            chatLoading = true
            try {
                val ids = veltaCore.messageIds(id, chatId)
                val messages = veltaCore.messages(id, ids)
                chatMessages = messages.sortedBy { it.sortTimestamp ?: it.timestamp }
                if (isGroup) loadSenderNames(veltaCore, id, messages)
            } catch (t: Throwable) {
                println("velta-kmp: loadMessages failed: $t")
            } finally {
                chatLoading = false
            }
        }
    }

    private suspend fun loadSenderNames(veltaCore: VeltaCore, accountId: Long, messages: List<MessageObject>) {
        val names = mutableMapOf<Long, String>()
        for (fromId in messages.map { it.fromId }.distinct()) {
            if (fromId <= 1L) continue // 0/1: special (self/system)
            val contact: Contact? = runCatching { veltaCore.contact(accountId, fromId) }.getOrNull()
            val name = contact?.displayName?.ifBlank { contact.name }?.ifBlank { null } ?: continue
            names[fromId] = name
        }
        senderNames = names
    }

    private suspend fun handleEvent(event: CoreEvent) {
        when (event.kind) {
            "ConfigureProgress" -> {
                val comment = event.event?.get("comment")?.toString()?.trim('"')
                if (!comment.isNullOrBlank()) loginProgress = comment
            }
            "MsgsChanged", "IncomingMsg", "MsgsNoticed", "MsgDelivered" -> {
                when (val current = screen) {
                    is Screen.Chat -> {
                        if (current.chatId == event.chatId()) {
                            loadMessages(current.chatId, current.isGroup)
                        }
                    }
                    Screen.ChatList -> refreshChats()
                    else -> {}
                }
            }
        }
    }

    private fun CoreEvent.chatId(): Long? =
        (event?.get("chatId")?.toString())?.trim('"')?.toLongOrNull()
            ?: (event?.get("chat_id")?.toString())?.trim('"')?.toLongOrNull()
}
