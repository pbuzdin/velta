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
        data object Relays : Screen
        data object Join : Screen
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

    // ---- Relay management (P4) ----
    var relays by mutableStateOf<List<org.velta.kmp.core.RelayCard>>(emptyList())
    var relaysLoading by mutableStateOf(false)
        private set
    var chatMessages by mutableStateOf<List<MessageObject>>(emptyList())
    var chatLoading by mutableStateOf(false)
        private set
    var senderNames by mutableStateOf<Map<Long, String>>(emptyMap())
        private set

    // ---- Composer (P3) ----
    var composerText by mutableStateOf("")
    var replyTo by mutableStateOf<MessageObject?>(null)
    var sending by mutableStateOf(false)
        private set
    var sendError by mutableStateOf<String?>(null)

    /** Message whose action bar (react / reply) is open; null = hidden. */
    var messageActions by mutableStateOf<MessageObject?>(null)

    /** (picked path, display name) awaiting send; the core dedups it into its blobdir. */
    var pendingAttachment by mutableStateOf<Pair<String, String>?>(null)

    /** Platform-injected file-picker launcher (desktop FileDialog / Android SAF). */
    var attachmentPicker: (() -> Unit)? = null

    fun attach() {
        attachmentPicker?.invoke()
    }

    // ---- Invite / join (P4) ----
    var joinText by mutableStateOf("")
    var joinChecked by mutableStateOf<org.velta.kmp.core.CoreQr?>(null)
    var joinBusy by mutableStateOf(false)
        private set
    var joinError by mutableStateOf<String?>(null)

    /** Parse what the user pasted; surface the kind so the UI can explain it. */
    fun checkJoin() {
        val veltaCore = core
        val id = accountId ?: unconfiguredAccountId
        val qr = joinText.trim()
        if (veltaCore == null || qr.isEmpty()) return
        scope.launch {
            joinBusy = true
            joinError = null
            try {
                joinChecked = veltaCore.checkQr(id ?: veltaCore.addAccount().also { accountId = it }, qr)
            } catch (t: Throwable) {
                joinError = t.message ?: t.toString()
            } finally {
                joinBusy = false
            }
        }
    }

    /**
     * Route on the checked kind: "account" = relay onboarding (transport +
     * configure, mirroring login), "ask*" = secure-join (the chat appears and
     * the protocol runs in the background).
     */
    fun join() {
        val veltaCore = core
        val qr = joinChecked ?: return
        val raw = joinText.trim()
        if (veltaCore == null || raw.isEmpty() || joinBusy) return
        scope.launch {
            joinBusy = true
            joinError = null
            try {
                val id = accountId
                    ?: unconfiguredAccountId
                    ?: veltaCore.addAccount().also { accountId = it }
                when {
                    qr.isAccountInvite -> {
                        veltaCore.addTransportFromQr(id, raw)
                        status = "configuring"
                        veltaCore.configure(id)
                        veltaCore.startIoForAllAccounts()
                        accountAddr = veltaCore.accountInfo(id).addr
                        loadChats()
                        screen = Screen.ChatList
                    }
                    qr.isSecureJoin -> {
                        veltaCore.startIoForAllAccounts()
                        veltaCore.secureJoin(id, raw)
                        loadChats()
                        screen = Screen.ChatList
                    }
                    else -> joinError = "this QR is not an invite (kind: ${qr.kind})"
                }
            } catch (t: Throwable) {
                joinError = t.message ?: t.toString()
            } finally {
                joinBusy = false
            }
        }
    }

    fun closeJoin() {
        joinText = ""
        joinChecked = null
        joinError = null
        screen = if (accountId != null) Screen.ChatList else Screen.Login
    }

    /** Called by the platform after a file was picked and staged readable. */
    fun onAttachmentPicked(path: String, displayName: String?) {
        pendingAttachment = path to (displayName ?: path.substringAfterLast('/'))
    }

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
        composerText = ""
        replyTo = null
        sendError = null
        senderNames = emptyMap()
        pendingAttachment = null
        messageActions = null
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
        // Draft restore rides its own coroutine — it must not wait behind
        // marknoticed (which can be slow or, in tests, never answer).
        scope.launch {
            val veltaCore = core
            val id = accountId
            if (veltaCore != null && id != null) {
                veltaCore.draft(id, item.id)?.let { saved ->
                    if (composerText.isBlank()) composerText = saved.text ?: ""
                    val quotedId = saved.quotedMessageId
                    if (quotedId != null && replyTo == null) {
                        replyTo = veltaCore.messages(id, listOf(quotedId)).firstOrNull { it.id == quotedId }
                    }
                }
            }
        }
        loadMessages(item.id)
        refreshChats()
    }

    /** Persist or clear the draft of the open chat when leaving it. */
    fun backToChatList() {
        val chat = screen as? Screen.Chat
        val veltaCore = core
        val id = accountId
        if (chat != null && veltaCore != null && id != null) {
            val text = composerText
            val attachment = pendingAttachment
            scope.launch {
                try {
                    if (text.isNotBlank() || attachment != null) {
                        veltaCore.setDraft(
                            id,
                            chat.chatId,
                            text,
                            replyTo?.id,
                            file = attachment?.first,
                            filename = attachment?.second,
                        )
                    } else {
                        veltaCore.removeDraft(id, chat.chatId)
                    }
                } catch (t: Throwable) {
                    println("velta-kmp: draft save failed: $t")
                }
            }
        }
        composerText = ""
        replyTo = null
        sendError = null
        pendingAttachment = null
        screen = Screen.ChatList
        refreshChats()
    }

    // ---- Relays (P4) ----

    fun openRelays() {
        screen = Screen.Relays
        refreshRelays()
    }

    fun backFromRelays() {
        screen = Screen.ChatList
    }

    fun refreshRelays() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            relaysLoading = true
            try {
                relays = veltaCore.relayCards(id)
            } catch (t: Throwable) {
                println("velta-kmp: refreshRelays failed: $t")
            } finally {
                relaysLoading = false
            }
        }
    }

    fun removeRelay(addr: String) {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                veltaCore.deleteTransport(id, addr)
            } catch (t: Throwable) {
                println("velta-kmp: removeRelay failed: $t")
            }
            refreshRelays()
        }
    }

    /**
     * P3 send: `misc_set_draft` (text + optional quote) then `misc_send_draft`.
     * After the send returns, the message exists in the db with real
     * OutPending state — reload immediately so the bubble shows with ⏳
     * instead of waiting for the event echo.
     */
    fun send() {
        val chat = screen as? Screen.Chat ?: return
        val veltaCore = core
        val id = accountId
        val text = composerText.trim()
        val attachment = pendingAttachment
        if (veltaCore == null || id == null || sending) return
        if (text.isEmpty() && attachment == null) return
        val quote = replyTo?.id
        composerText = ""
        replyTo = null
        sendError = null
        sending = true
        scope.launch {
            try {
                veltaCore.setDraft(
                    id,
                    chat.chatId,
                    text,
                    quote,
                    file = attachment?.first,
                    filename = attachment?.second,
                )
                veltaCore.sendDraft(id, chat.chatId)
                pendingAttachment = null
                loadMessages(chat.chatId, chat.isGroup)
            } catch (t: Throwable) {
                sendError = t.message ?: t.toString()
                // Restore what the user composed so nothing is lost.
                if (composerText.isBlank()) composerText = text
                if (pendingAttachment == null) pendingAttachment = attachment
            } finally {
                sending = false
            }
        }
    }

    // ---- Message actions: reactions + reply (P3) ----

    fun toggleMessageActions(message: MessageObject) {
        messageActions = if (messageActions?.id == message.id) null else message
    }

    fun react(message: MessageObject, emoji: String) {
        val veltaCore = core
        val id = accountId
        messageActions = null
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                veltaCore.sendReaction(id, message.id, listOf(emoji))
                if (screen is Screen.Chat) loadMessages((screen as Screen.Chat).chatId, (screen as Screen.Chat).isGroup)
            } catch (t: Throwable) {
                println("velta-kmp: react failed: $t")
            }
        }
    }

    fun startReply(message: MessageObject) {
        replyTo = message
        messageActions = null
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
