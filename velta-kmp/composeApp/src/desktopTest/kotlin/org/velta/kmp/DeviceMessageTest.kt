package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaCore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #442: a received second-device profile starts with an empty device chat, so
 * the model posts a transfer note through add_device_message — label once per
 * account (core-side), text payload {text}, like the web's addDeviceMessage.
 */
class DeviceMessageTest {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun transferNoteRidesAddDeviceMessageWithTextPayload() = runBlocking {
        val transport = ScriptedRpcTransport(mapOf("add_device_message" to "null"))
        val core = VeltaCore(RpcClient(transport))
        try {
            core.addDeviceMessage(1, "velta-transfer", "Profile transferred from another Velta device")
            withTimeout(10_000) {
                while (transport.requests.none { "\"add_device_message\"" in it }) yield()
            }
            val line = transport.requests.first { "\"add_device_message\"" in it }
            assertTrue(line.contains("\"velta-transfer\""), "label must ride the method: $line")
            assertTrue(
                line.contains("\"text\"") && line.contains("Profile transferred from another Velta device"),
                "text payload must ride the method: $line",
            )
            assertEquals(1, transport.requests.count { "\"add_device_message\"" in it }, "exactly one call")
        } finally {
            core.close()
            scope.cancel()
        }
    }
}
