package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.canDeleteProfile
import org.velta.kmp.ui.deleteAddressMatches
import org.velta.kmp.ui.profileAfterDelete
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #358 C: delete the current profile, and the account lock plus sync-only. */
class DeleteProfileRulesTest {

    @Test
    fun addressMatchAndWhoRemains() {
        assertFalse(canDeleteProfile(0))
        assertFalse(canDeleteProfile(1))
        assertTrue(canDeleteProfile(2))
        assertFalse(deleteAddressMatches("a@example.org", ""))
        assertFalse(deleteAddressMatches("nope", "a@example.org"))
        assertTrue(deleteAddressMatches("  A@Example.ORG ", "a@example.org"))
        assertNull(profileAfterDelete(listOf(1), 1, 1))
        assertEquals(2L, profileAfterDelete(listOf(1, 2), 1, 1))
        assertEquals(3L, profileAfterDelete(listOf(2, 3), 3, 1))
        assertEquals(2L, profileAfterDelete(listOf(2, 3), null, 1))
    }

    @Test
    fun deleteSwitchesToTheOtherProfile() = runBlocking {
        val h = harness(
            """[{"id":1,"addr":"a@example.org","isConfigured":true},{"id":2,"addr":"b@example.org","displayName":"Bee","isConfigured":true}]""",
            "[1,2]",
        )
        try {
            h.model.connect()
            withTimeout(10_000) { while (h.model.screen != AppModel.Screen.ChatList) yield() }
            h.model.openAccounts()
            withTimeout(10_000) { while (h.model.accounts.size < 2) yield() }
            h.model.deleteCurrentProfile("nope")
            yield()
            assertFalse(h.transport.requests.any { "\"remove_account\"" in it })

            h.model.deleteCurrentProfile("A@Example.ORG")
            withTimeout(10_000) {
                while (h.model.accountId != 2L || h.model.toast == null) yield()
            }
            val reqs = h.transport.requests
            val removeAt = reqs.indexOfFirst { "\"remove_account\"" in it && "[1]" in it }
            val selectAt = reqs.indexOfLast { "\"select_account\"" in it && "[2]" in it }
            assertTrue(removeAt >= 0, "remove: $reqs")
            assertTrue(selectAt > removeAt, "select after remove: $reqs")
            assertTrue(reqs.drop(removeAt).any { "\"start_io_for_all_accounts\"" in it })
            assertEquals(AppModel.Screen.ChatList, h.model.screen)
            assertEquals("Profile deleted — switched to Bee", h.model.toast)
            assertFalse(h.model.deleteProfileOpen)
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun lastProfileIsNotRemoved() = runBlocking {
        val h = harness("""[{"id":1,"addr":"a@example.org","isConfigured":true}]""", "[1]")
        try {
            h.model.connect()
            withTimeout(10_000) { while (h.model.screen != AppModel.Screen.ChatList) yield() }
            h.model.openAccounts()
            withTimeout(10_000) { while (h.model.accounts.size != 1) yield() }
            h.model.deleteCurrentProfile("a@example.org")
            yield()
            assertFalse(h.transport.requests.any { "\"remove_account\"" in it })
            assertEquals(1L, h.model.accountId)
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun exportBlocksDelete() = runBlocking {
        val h = ready()
        try {
            h.model.backupExportDir = { "/tmp/velta-kmp-export" }
            h.model.exportBackup()
            assertTrue(h.model.backupBusy)
            h.model.deleteCurrentProfile("A@Example.ORG")
            yield()
            assertFalse(h.transport.requests.any { "\"remove_account\"" in it })
            assertEquals(
                "Another account operation is running — try again in a moment",
                h.model.toast,
            )
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun deleteBlocksExport() = runBlocking {
        val h = ready(scriptRemove = false)
        try {
            h.model.backupExportDir = { "/tmp/velta-kmp-export" }
            h.model.deleteCurrentProfile("A@Example.ORG")
            assertTrue(h.model.deleteProfileBusy)
            h.model.exportBackup()
            yield()
            assertFalse(h.transport.requests.any { "\"export_backup\"" in it })
            assertEquals(
                "Another account operation is running — try again in a moment",
                h.model.toast,
            )
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun syncOnlyKeepsBackgroundProfilesPaused() = runBlocking {
        val prefs = mutableMapOf<String, String?>("velta-sync-only-active" to "1")
        val h = ready(prefs = prefs)
        try {
            assertFalse(h.transport.requests.any { "\"start_io_for_all_accounts\"" in it })
            assertTrue(h.transport.requests.any { "\"start_io\"" in it && "[1]" in it })

            val switched = h.transport.requests.size
            h.model.switchAccount(2)
            withTimeout(10_000) {
                while (true) {
                    val tail = h.transport.requests.drop(switched)
                    val stop = tail.indexOfFirst { "\"stop_io\"" in it && "[1]" in it }
                    val start = tail.indexOfFirst { "\"start_io\"" in it && "[2]" in it }
                    if (stop >= 0 && start > stop) break
                    yield()
                }
            }

            val off = h.transport.requests.size
            h.model.setSyncOnly(false)
            withTimeout(10_000) {
                while (!h.transport.requests.drop(off).any { "\"start_io_for_all_accounts\"" in it }) yield()
            }
            assertEquals("0", prefs["velta-sync-only-active"])
            assertFalse(h.model.syncOnlyActive)

            val on = h.transport.requests.size
            h.model.setSyncOnly(true)
            withTimeout(10_000) {
                while (!h.transport.requests.drop(on).any { "\"stop_io\"" in it && "[1]" in it }) yield()
            }
            assertFalse(h.transport.requests.drop(on).any { "\"stop_io\"" in it && "[2]" in it })
            assertEquals("1", prefs["velta-sync-only-active"])
            assertTrue(h.model.syncOnlyActive)
        } finally {
            h.scope.cancel()
        }
    }

    @Test
    fun failedSwitchDoesNotStopIo() = runBlocking {
        val prefs = mutableMapOf<String, String?>("velta-sync-only-active" to "1")
        val h = ready(extra = mapOf("select_account" to "ERROR:nope"), prefs = prefs)
        try {
            val mark = h.transport.requests.size
            h.model.switchAccount(2)
            withTimeout(10_000) {
                while (true) {
                    val tail = h.transport.requests.drop(mark)
                    val sel = tail.indexOfFirst { "\"select_account\"" in it }
                    if (sel >= 0 && tail.drop(sel + 1).any { "\"get_account_info\"" in it }) break
                    yield()
                }
            }
            val tail = h.transport.requests.drop(mark)
            assertFalse(tail.any { "\"stop_io\"" in it })
            assertFalse(tail.any { "\"start_io\"" in it && "[2]" in it })
        } finally {
            h.scope.cancel()
        }
    }

    private suspend fun ready(
        extra: Map<String, String> = emptyMap(),
        prefs: MutableMap<String, String?> = mutableMapOf(),
        scriptRemove: Boolean = true,
    ): Harness {
        val two = """[{"id":1,"addr":"a@example.org","isConfigured":true},{"id":2,"addr":"b@example.org","displayName":"Bee","isConfigured":true}]"""
        val h = harness(two, "[1,2]", extra, prefs, scriptRemove)
        h.model.connect()
        withTimeout(10_000) { while (h.model.screen != AppModel.Screen.ChatList) yield() }
        h.model.openAccounts()
        withTimeout(10_000) { while (h.model.accounts.size < 2) yield() }
        return h
    }

    private fun harness(
        accountsJson: String,
        ids: String,
        extra: Map<String, String> = emptyMap(),
        prefs: MutableMap<String, String?> = mutableMapOf(),
        scriptRemove: Boolean = true,
    ): Harness {
        val script = mutableMapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to ids,
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
            "get_all_accounts" to accountsJson,
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "start_io" to "null",
            "stop_io" to "null",
            "get_chatlist_entries" to "[]",
        )
        if (scriptRemove) script["remove_account"] = "null"
        script.putAll(extra)
        val transport = ScriptedRpcTransport(script)
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-delete-profile-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
            override fun pref(key: String): String? = prefs[key]
            override fun setPref(key: String, value: String?) {
                if (value == null) prefs.remove(key) else prefs[key] = value
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        return Harness(transport, scope, AppModel(platform, scope))
    }

    private class Harness(
        val transport: ScriptedRpcTransport,
        val scope: CoroutineScope,
        val model: AppModel,
    )
}
