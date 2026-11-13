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

/**
 * Bubble media cards ride wire fields the UI chips need: `fileBytes` (size
 * chip), `duration` in ms (m:ss chip), `dimensionsWidth/Height` (image box
 * reservation) and `quote` (in-bubble reply strip). All camelCase on the
 * same snapshot the web's rpc-core.js maps from (`fileSize: m.fileBytes`,
 * `duration: Math.round(m.duration / 1000)`).
 */
class MediaMetaParseTest {

    @Test
    fun messageParsesAttachmentMetaFromTheWire() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_messages" to
                    """{"10":{"kind":"message","id":10,"chatId":10,"fromId":0,"text":"","state":26,"viewType":"Video","file":"/tmp/v.mp4","fileName":"clip.mp4","fileBytes":1572864,"duration":94000,"dimensionsWidth":720,"dimensionsHeight":1280,"quote":{"kind":"WithMessage","text":"earlier","messageId":9}}}""",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-media-meta-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val core = VeltaCore(org.velta.kmp.core.RpcClient(transport))
        try {
            val messages = core.messages(1, listOf(10))
            assertEquals(1, messages.size)
            val msg = messages.first()
            assertEquals(1572864L, msg.fileBytes)
            assertEquals(94000L, msg.duration)
            assertEquals(720, msg.dimensionsWidth)
            assertEquals(1280, msg.dimensionsHeight)
            assertEquals("clip.mp4", msg.fileName)
            assertEquals("earlier", msg.quote?.text)
            assertEquals(9L, msg.quote?.messageId)
        } finally {
            core.close()
            scope.cancel()
        }
    }
}
