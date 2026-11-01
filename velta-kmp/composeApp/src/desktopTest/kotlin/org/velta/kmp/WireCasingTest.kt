package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaCore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Wire-casing regression: `MessageLoadResult` is enum-level camelCase-tagged,
 * so real core responses carry `kind:"message"` (lowercase) — a PascalCase
 * filter silently dropped EVERY real message once a configured account was
 * in play (the scripted fixtures had the same wrong casing, hiding it).
 * This test pins the casing probed against core 2.66.
 */
class WireCasingTest {

    @Test
    fun messagesAcceptRealLowercaseKindAndDropLoadingErrors() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_messages" to
                    """{"10":{"kind":"message","id":10,"chatId":10,"fromId":5,"text":"real wire message","state":10},"11":{"kind":"loadingError","error":"Message does not exist"}}""",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-casing-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val core = VeltaCore(org.velta.kmp.core.RpcClient(transport))
        try {
            val messages = core.messages(1, listOf(10, 11))
            assertEquals(1, messages.size, "only the kind=message entry survives")
            assertEquals("real wire message", messages.first().text)
            assertEquals(10L, messages.first().id)
        } finally {
            core.close()
            scope.cancel()
        }
    }
}
