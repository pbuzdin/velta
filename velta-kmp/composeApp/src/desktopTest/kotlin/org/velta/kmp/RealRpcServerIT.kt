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

                // NOTE (P3): the write-path e2e ("send lands in another
                // client") needs a CONFIGURED account — `add_device_message`
                // accepts writes unconfigured but the message is NOT visible
                // via get_messages (async materialization requires a self
                // addr), so there is no no-network round-trip to assert here.
                // The send flow is covered by the scripted SendFlowTest.
            }
        } finally {
            core.close()
        }
    }
}
