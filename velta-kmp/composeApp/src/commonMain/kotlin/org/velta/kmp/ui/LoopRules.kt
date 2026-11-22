package org.velta.kmp.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import org.velta.kmp.core.RpcClient

/** Web `localStorage` key. Absent is off: the engine never binds. */
const val LOOP_PREF = "velta-p2p"

/** Web key. Absent is on; `"0"` sends and shows nothing. */
const val LOOP_TYPING_PREF = "velta-p2p-typing"

/** Web key. Absent seals Loop blobs at rest; `"0"` stores them plaintext. */
const val LOOP_SEAL_PREF = "velta-p2p-seal"

const val LOOP_NAME_MAX = 64
const val LOOP_GROUP_MAX_OTHERS = 4
const val LOOP_MSG_LIMIT = 200
const val TYPING_REPEAT_MS = 3_000L
const val TYPING_IDLE_MS = 5_000L
const val TYPING_SHOW_TTL_MS = 6_000L

data class LoopPeer(
    val id: String,
    val name: String,
    val online: Boolean,
    val queued: Int,
    val lastTs: Long,
)

data class LoopNearby(val id: String, val name: String)

data class LoopMember(val id: String, val name: String, val self: Boolean, val online: Boolean)

data class LoopGroup(
    val gid: String,
    val name: String,
    val removed: Boolean,
    val members: List<LoopMember>,
    val canManage: Boolean = false,
    val closed: Boolean = false,
)

data class LoopStatus(
    val nodeId: String,
    val name: String,
    val peers: List<LoopPeer>,
    val nearby: List<LoopNearby>,
    val groups: List<LoopGroup>,
)

data class LoopMessage(
    val id: String,
    val text: String,
    val incoming: Boolean,
    val system: Boolean,
    val author: String,
    val filePath: String = "",
    val fileName: String = "",
)

data class LoopRow(
    val id: String,
    val title: String,
    val preview: String,
    val group: Boolean,
    val typing: Boolean,
    val ts: Long,
)

fun loopPeerChatId(id: String) = "p2p:$id"
fun loopGroupChatId(gid: String) = "p2pg:$gid"

fun loopPeerOf(chatId: String): String? =
    if (chatId.startsWith("p2pg:")) null
    else if (chatId.startsWith("p2p:")) chatId.removePrefix("p2p:")
    else null

fun loopGroupOf(chatId: String): String? =
    if (chatId.startsWith("p2pg:")) chatId.removePrefix("p2pg:") else null

fun loopGroupNameOk(name: String): Boolean {
    val trimmed = name.trim()
    return trimmed.isNotEmpty() && trimmed.length <= LOOP_NAME_MAX
}

fun loopGroupMembersOk(count: Int): Boolean = count in 1..LOOP_GROUP_MAX_OTHERS

fun loopTypingWanted(pref: String?): Boolean = pref != "0"

fun loopSealWanted(pref: String?): Boolean = pref != "0"

enum class LoopMenu { Rename, Leave, Disband, Delete, Unpair }

sealed class LoopAsk {
    data class Unpair(val peerId: String, val body: String) : LoopAsk()
    data class Leave(val gid: String, val disband: Boolean) : LoopAsk()
    data class Delete(val gid: String, val name: String) : LoopAsk()
    /** gid null renames this device. */
    data class Rename(val gid: String?, val name: String) : LoopAsk()
}

/** 1:1 unpairs. A live group renames (creator) or leaves. A finished group deletes. */
fun loopChatMenu(group: Boolean, canManage: Boolean, removed: Boolean): List<LoopMenu> {
    if (!group) return listOf(LoopMenu.Unpair)
    if (removed) return listOf(LoopMenu.Delete)
    return if (canManage) listOf(LoopMenu.Rename, LoopMenu.Disband) else listOf(LoopMenu.Leave)
}

fun loopMenuLabel(item: LoopMenu): String = when (item) {
    LoopMenu.Rename -> L.t("Rename")
    LoopMenu.Leave -> L.t("Leave group")
    LoopMenu.Disband -> L.t("Disband group")
    LoopMenu.Delete -> L.t("Delete chat")
    LoopMenu.Unpair -> L.t("Remove device")
}

fun loopUnpairBody(name: String, created: List<String>, member: List<String>): String {
    var text = L.t("Forget \"{name}\"? Its chat history and received files will be deleted. The device can re-pair with a new invite.")
        .replace("{name}", name)
    if (created.size == 1) {
        text += " " + L.t("{name} created {groups}: that group will be deleted from this device too.")
            .replace("{name}", name)
            .replace("{groups}", created.joinToString(", ") { "\"$it\"" })
    } else if (created.size > 1) {
        text += " " + L.t("{name} created {groups}: those groups will be deleted from this device too.")
            .replace("{name}", name)
            .replace("{groups}", created.joinToString(", ") { "\"$it\"" })
    }
    if (member.isNotEmpty()) {
        text += " " + L.t("{name} is also in {groups}: it stays there as a member you can't message directly any more. To take it out of a group you created, remove it from the group first.")
            .replace("{name}", name)
            .replace("{groups}", member.joinToString(", ") { "\"$it\"" })
    }
    return text
}

data class TypingSendState(
    val active: Boolean = false,
    val lastSent: Long = 0,
    val idleDeadline: Long = 0,
)

/** Composer side of typing.js. The second value is the hint to send, or null. */
fun typingOnKey(state: TypingSendState, hasText: Boolean, now: Long): Pair<TypingSendState, Boolean?> {
    if (!hasText) {
        return if (state.active) TypingSendState() to false else TypingSendState() to null
    }
    val repeat = !state.active || now - state.lastSent >= TYPING_REPEAT_MS
    val next = TypingSendState(
        active = true,
        lastSent = if (repeat) now else state.lastSent,
        idleDeadline = now + TYPING_IDLE_MS,
    )
    return next to if (repeat) true else null
}

fun typingOnIdle(state: TypingSendState, now: Long): Pair<TypingSendState, Boolean?> {
    if (!state.active || now < state.idleDeadline) return state to null
    return TypingSendState() to false
}

class TypingBoard {
    private val until = HashMap<String, HashMap<String, Long>>()

    fun note(chatId: String, sender: String, on: Boolean, now: Long) {
        val chat = until.getOrPut(chatId) { HashMap() }
        if (on) chat[sender] = now + TYPING_SHOW_TTL_MS else chat.remove(sender)
    }

    fun active(chatId: String, now: Long): List<String> {
        val chat = until[chatId] ?: return emptyList()
        chat.entries.filter { it.value <= now }.map { it.key }.forEach { chat.remove(it) }
        return chat.keys.toList()
    }
}

fun loopTypingLine(names: List<String>): String {
    val n = names.filter { it.isNotBlank() }
    if (n.isEmpty()) return ""
    if (n.size == 1) return L.t("{name} is typing…").replace("{name}", n[0])
    return L.t("{a} and {b} are typing…")
        .replace("{a}", n.dropLast(1).joinToString(", "))
        .replace("{b}", n.last())
}

fun loopListRows(
    status: LoopStatus,
    previews: Map<String, String>,
    typing: Map<String, String>,
): List<LoopRow> {
    val groups = status.groups.map { g ->
        val id = loopGroupChatId(g.gid)
        val typed = typing[id]
        LoopRow(
            id = id,
            title = g.name.ifBlank { g.gid },
            preview = typed ?: previews[id].orEmpty(),
            group = true,
            typing = typed != null,
            ts = 0,
        )
    }
    val peers = status.peers.map { p ->
        val id = loopPeerChatId(p.id)
        val typed = typing[id]
        LoopRow(
            id = id,
            title = p.name.ifBlank { p.id.take(8) },
            preview = typed ?: previews[id].orEmpty(),
            group = false,
            typing = typed != null,
            ts = p.lastTs,
        )
    }.sortedByDescending { it.ts }
    return groups + peers
}

private val loopJson = Json { ignoreUnknownKeys = true; isLenient = true }

fun parseLoopStatus(el: JsonElement): LoopStatus {
    val o = el as? JsonObject ?: error("loop status")
    return LoopStatus(
        nodeId = o.str("nodeId"),
        name = o.str("name"),
        peers = o.objs("peers").map { p ->
            LoopPeer(p.str("id"), p.str("name"), p.bool("online"), p.long("queued").toInt(), p.long("lastTs"))
        },
        nearby = o.objs("nearby").map { n -> LoopNearby(n.str("id"), n.str("name")) },
        groups = o.objs("groups").map { g ->
            LoopGroup(
                gid = g.str("gid"),
                name = g.str("name"),
                removed = g.bool("removed"),
                members = g.objs("members").map { m ->
                    LoopMember(m.str("id"), m.str("name"), m.bool("self"), m.bool("online"))
                },
                canManage = g.bool("canManage"),
                closed = g.bool("closed"),
            )
        },
    )
}

fun parseLoopMessages(el: JsonElement): List<LoopMessage> {
    val arr = el as? JsonArray ?: return emptyList()
    return arr.mapNotNull { it as? JsonObject }.map { o ->
        val dir = o.str("dir")
        val file = o["file"] as? JsonObject
        val fileName = file?.str("name").orEmpty()
        LoopMessage(
            id = o.str("id").ifBlank { o.str("seq") },
            text = o.str("text").ifBlank { fileName },
            incoming = dir == "in",
            system = dir == "sys",
            author = o.str("from"),
            filePath = file?.str("path").orEmpty(),
            fileName = fileName,
        )
    }
}

sealed interface LoopEvent {
    data class Typing(val chatId: String, val sender: String, val on: Boolean) : LoopEvent
    data class PairRequest(val peerId: String, val name: String) : LoopEvent
    data class Refresh(val chatId: String?) : LoopEvent
    data object Ignore : LoopEvent
}

fun parseLoopPush(line: String): LoopEvent {
    val obj = try {
        loopJson.parseToJsonElement(line) as? JsonObject
    } catch (_: Throwable) {
        null
    } ?: return LoopEvent.Ignore
    if (obj.str("method") != "p2p-event") return LoopEvent.Ignore
    val p = obj["params"] as? JsonObject ?: return LoopEvent.Ignore
    return when (p.str("kind")) {
        "typing" -> LoopEvent.Typing(loopPeerChatId(p.str("peerId")), p.str("peerId"), p.bool("on"))
        "group-typing" -> LoopEvent.Typing(loopGroupChatId(p.str("gid")), p.str("from"), p.bool("on"))
        "pair-request" -> LoopEvent.PairRequest(p.str("peerId"), p.str("name"))
        "message", "msg-state", "presence", "pairing",
        "group-state", "group-deleted", "group-removed", "group-ack",
        -> {
            val chat = when {
                p.str("gid").isNotEmpty() -> loopGroupChatId(p.str("gid"))
                p.str("peerId").isNotEmpty() -> loopPeerChatId(p.str("peerId"))
                else -> null
            }
            LoopEvent.Refresh(chat)
        }
        else -> LoopEvent.Ignore
    }
}

/** Text, files, pairing, and local groups. */
class VeltaLoop(private val client: RpcClient) : AutoCloseable {
    val pushes = client.pushes

    suspend fun status(): LoopStatus = parseLoopStatus(client.call("p2p_status"))

    suspend fun history(chatId: String, limit: Int): List<LoopMessage> {
        val el = when {
            loopPeerOf(chatId) != null ->
                client.call("p2p_messages", RpcClient.params(RpcClient.param(loopPeerOf(chatId)), RpcClient.param(limit)))
            loopGroupOf(chatId) != null ->
                client.call("p2p_group_messages", RpcClient.params(RpcClient.param(loopGroupOf(chatId)), RpcClient.param(limit)))
            else -> return emptyList()
        }
        return parseLoopMessages(el)
    }

    suspend fun sendPeer(peer: String, text: String) {
        client.call("p2p_send", RpcClient.params(RpcClient.param(peer), RpcClient.param(text)))
    }

    suspend fun sendGroup(gid: String, text: String) {
        client.call("p2p_group_send", RpcClient.params(RpcClient.param(gid), RpcClient.param(text)))
    }

    suspend fun typingPeer(peer: String, on: Boolean) {
        client.call("p2p_typing_peer", RpcClient.params(RpcClient.param(peer), RpcClient.param(on)))
    }

    suspend fun typingGroup(gid: String, on: Boolean) {
        client.call("p2p_typing_group", RpcClient.params(RpcClient.param(gid), RpcClient.param(on)))
    }

    suspend fun invite(): String =
        (client.call("p2p_create_invite") as? JsonPrimitive)?.content ?: error("no invite")

    suspend fun accept(ticket: String) {
        client.call("p2p_accept_invite", RpcClient.params(RpcClient.param(ticket)))
    }

    suspend fun pairNearby(peer: String) {
        client.call("p2p_pair_nearby", RpcClient.params(RpcClient.param(peer)))
    }

    suspend fun approve(peer: String, accept: Boolean) {
        client.call("p2p_approve_pair", RpcClient.params(RpcClient.param(peer), RpcClient.param(accept)))
    }

    suspend fun createGroup(name: String, memberIds: List<String>) {
        client.call(
            "p2p_group_create",
            RpcClient.params(RpcClient.param(name), JsonArray(memberIds.map { JsonPrimitive(it) })),
        )
    }

    suspend fun setName(name: String) {
        client.call("p2p_set_name", RpcClient.params(RpcClient.param(name)))
    }

    suspend fun setSeal(on: Boolean) {
        client.call("p2p_set_seal", RpcClient.params(RpcClient.param(on)))
    }

    suspend fun peerImpact(peer: String): Pair<List<String>, List<String>> {
        val el = client.call("p2p_peer_groups", RpcClient.params(RpcClient.param(peer))) as? JsonObject
            ?: return emptyList<String>() to emptyList()
        fun names(key: String) = el.objs(key).map { it.str("name") }.filter { it.isNotBlank() }
        return names("created") to names("member")
    }

    suspend fun removePeer(peer: String) {
        client.call("p2p_remove_peer", RpcClient.params(RpcClient.param(peer)))
    }

    suspend fun sendPeerFile(peer: String, path: String, name: String, caption: String) {
        client.call(
            "p2p_send_file",
            RpcClient.params(RpcClient.param(peer), RpcClient.param(path), RpcClient.param(name), RpcClient.param(caption)),
        )
    }

    suspend fun sendGroupFile(gid: String, path: String, name: String, caption: String) {
        client.call(
            "p2p_group_send_file",
            RpcClient.params(RpcClient.param(gid), RpcClient.param(path), RpcClient.param(name), RpcClient.param(caption)),
        )
    }

    suspend fun renameGroup(gid: String, name: String) {
        client.call("p2p_group_rename", RpcClient.params(RpcClient.param(gid), RpcClient.param(name)))
    }

    suspend fun leaveGroup(gid: String) {
        client.call("p2p_group_leave", RpcClient.params(RpcClient.param(gid)))
    }

    suspend fun disbandGroup(gid: String) {
        client.call("p2p_group_disband", RpcClient.params(RpcClient.param(gid)))
    }

    suspend fun deleteGroup(gid: String) {
        client.call("p2p_group_delete", RpcClient.params(RpcClient.param(gid)))
    }

    override fun close() {
        client.close()
    }
}

private fun JsonObject.str(key: String): String =
    (this[key] as? JsonPrimitive)?.content ?: ""

private fun JsonObject.bool(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.booleanOrNull == true

private fun JsonObject.long(key: String): Long =
    (this[key] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L

private fun JsonObject.objs(key: String): List<JsonObject> =
    (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
