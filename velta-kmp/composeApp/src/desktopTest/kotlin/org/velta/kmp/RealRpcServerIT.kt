package org.velta.kmp

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.ProcessRpcTransport
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaCore

/**
 * End-to-end check against a REAL `deltachat-rpc-server`.
 *
 * Runs only when `VELTA_KMP_RPC_SERVER` points at a binary (CI skips it —
 * the fake-transport suite above covers the client logic there). This is the
 * P1 "hello inbox" gate: handshake, account creation, empty chatlist.
 *
 * runBlocking on purpose: the responses come from a real process on real
 * threads — the test scheduler's virtual time would fire the timeout early.
 */
class RealRpcServerIT {

    @Test
    fun handshakeAccountAndEmptyChatlist() = runBlocking {
        val binary = System.getenv("VELTA_KMP_RPC_SERVER")
        if (binary.isNullOrEmpty()) {
            println("RealRpcServerIT: VELTA_KMP_RPC_SERVER not set — skipping")
            return@runBlocking
        }

        val accountsDir = Files.createTempDirectory("velta-kmp-it")
        val platform = object : CorePlatform {
            override fun accountsDir(): String = accountsDir.toString()
            override fun spawnRpcServer(accountsDir: String): RpcTransport =
                ProcessRpcTransport(
                    ProcessBuilder(binary)
                        .apply {
                            environment()["DC_ACCOUNTS_PATH"] = accountsDir
                            redirectErrorStream(false)
                        }
                        .start(),
                )
        }

        val core = VeltaCore(RpcClient(platform.spawnRpcServer(platform.accountsDir())!!))
        try {
            withTimeout(60_000) {
                val info = core.systemInfo()
                val version = info["deltachat_core_version"]
                assertNotNull(version, "system_info should report deltachat_core_version, got: $info")
                println("RealRpcServerIT: core $version")

                val accountId = core.addAccount()
                assertEquals(1L, accountId, "fresh accounts dir → first account is 1")

                val entries = core.chatlistEntries(accountId)
                assertTrue(entries.isEmpty(), "fresh account has an empty chatlist")

                // Relay surface (P4): a fresh account has no transports and
                // an empty metadata map — both calls answer for real.
                val relays = core.relayCards(accountId)
                assertTrue(relays.isEmpty(), "fresh account has no relay cards")

                // P3 write-path round-trip WITHOUT network: a device message
                // is created locally and read back through the client models.
                val msgData = kotlinx.serialization.json.buildJsonObject {
                    put("text", kotlinx.serialization.json.JsonPrimitive("hello from the kmp IT"))
                }
                val msgId = core.raw
                    .call(
                        "add_device_message",
                        org.velta.kmp.core.RpcClient.params(
                            org.velta.kmp.core.RpcClient.param(accountId),
                            org.velta.kmp.core.RpcClient.param("kmp-it"),
                            msgData,
                        ),
                    )
                    .toString().toLong()
                assertTrue(msgId > 0, "add_device_message returns a message id")

                val readBack = core.messages(accountId, listOf(msgId))
                assertTrue(
                    readBack.any { it.text == "hello from the kmp IT" },
                    "device message round-trips through get_messages: $readBack",
                )

                // Attachment round-trip: the core dedups the file into its
                // blobdir at message-creation time (set_file_and_deduplicate).
                val attachment = java.nio.file.Files.createTempFile("kmp-it", ".txt")
                java.nio.file.Files.write(attachment, "attachment payload".toByteArray())
                val attachMsgData = kotlinx.serialization.json.buildJsonObject {
                    put("text", kotlinx.serialization.json.JsonPrimitive("with attachment"))
                    put("file", kotlinx.serialization.json.JsonPrimitive(attachment.toString()))
                    put("filename", kotlinx.serialization.json.JsonPrimitive("payload.txt"))
                }
                val attachMsgId = core.raw
                    .call(
                        "add_device_message",
                        org.velta.kmp.core.RpcClient.params(
                            org.velta.kmp.core.RpcClient.param(accountId),
                            org.velta.kmp.core.RpcClient.param("kmp-it-attachment"),
                            attachMsgData,
                        ),
                    )
                    .toString().toLong()
                val attachBack = core.messages(accountId, listOf(attachMsgId))
                val withFile = attachBack.firstOrNull { it.text == "with attachment" }
                assertTrue(withFile != null, "attachment message read back: $attachBack")
                assertTrue(
                    !withFile.file.isNullOrBlank() && withFile.fileName == "payload.txt",
                    "file must be deduplicated into the blobdir with its name: ${withFile.file}/${withFile.fileName}",
                )
                assertTrue(
                    java.io.File(withFile.file!!).isFile,
                    "the blob file must physically exist: ${withFile.file}",
                )
            }
        } finally {
            core.close()
        }
    }
}
