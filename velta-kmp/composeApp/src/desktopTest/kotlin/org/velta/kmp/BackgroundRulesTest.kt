package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.BackgroundPolicy
import org.velta.kmp.ui.CatchUp
import org.velta.kmp.ui.backgroundConnectionOn
import org.velta.kmp.ui.bootStartsSync
import org.velta.kmp.ui.syncServiceRuns
import org.velta.kmp.ui.catchUpDecision
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #358 Background delivery: periodic catch-up (stable BackgroundFetchJob). */
class BackgroundRulesTest {

    @Test
    fun policyMatchesStable() {
        assertEquals(15 * 60 * 1000L, BackgroundPolicy.PERIODIC_MS)
        assertEquals(0x564C, BackgroundPolicy.JOB_ID)
        assertEquals(30.0, BackgroundPolicy.FETCH_SECS)
        assertTrue(BackgroundPolicy.JOB_MAX_MS > BackgroundPolicy.FETCH_SECS * 1000)
    }

    @Test
    fun lockedColdCoreIsSkipped() {
        assertEquals(CatchUp.SkipLocked, catchUpDecision(appLocked = true, connected = false))
        assertEquals(CatchUp.Fetch, catchUpDecision(appLocked = true, connected = true))
        assertEquals(CatchUp.Fetch, catchUpDecision(appLocked = false, connected = false))
    }

    @Test
    fun bootAndUpdateRestartSync() {
        assertTrue(bootStartsSync("android.intent.action.BOOT_COMPLETED", appLocked = false))
        assertTrue(bootStartsSync("android.intent.action.MY_PACKAGE_REPLACED", appLocked = false))
        assertFalse(bootStartsSync("android.intent.action.BOOT_COMPLETED", appLocked = true), "lock waits for the user")
        assertFalse(bootStartsSync("android.intent.action.TIME_SET", appLocked = false))
        assertFalse(bootStartsSync(null, appLocked = false))
    }

    @Test
    fun backgroundConnectionGatesEveryWake() {
        assertTrue(backgroundConnectionOn(null))
        assertFalse(backgroundConnectionOn("0"))
        assertEquals(CatchUp.SkipOff, catchUpDecision(appLocked = false, connected = true, backgroundConnection = false))
        assertEquals(CatchUp.SkipForeground, catchUpDecision(appLocked = false, connected = true, uiVisible = true))
        assertFalse(bootStartsSync("android.intent.action.BOOT_COMPLETED", appLocked = false, backgroundConnection = false))
        assertTrue(syncServiceRuns(backgroundConnection = true, appLocked = false, connected = false))
        assertFalse(syncServiceRuns(backgroundConnection = false, appLocked = false, connected = true))
        assertFalse(syncServiceRuns(backgroundConnection = true, appLocked = true, connected = false))
        assertTrue(syncServiceRuns(backgroundConnection = true, appLocked = true, connected = true))
    }

    @Test
    fun toggleOffSkipsTheFetchAndPersists() = runBlocking {
        val prefs = HashMap<String, String?>()
        var spawned = false
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-bg-off-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport {
                spawned = true
                return ScriptedRpcTransport(answers())
            }
            override fun pref(key: String): String? = prefs[key]
            override fun setPref(key: String, value: String?) { prefs[key] = value }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val model = AppModel(platform, scope)
            var applied: Boolean? = null
            model.onBackgroundConnectionChanged = { applied = it }
            model.onSetBackgroundConnection(false)
            assertEquals("0", prefs["velta-notify-bg"])
            assertEquals(false, applied)
            assertEquals("Background connection off — messages arrive when you open Velta", model.toast)
            assertFalse(model.catchUpFetch("push"))
            assertFalse(spawned)
            model.onSetBackgroundConnection(true)
            assertEquals(null, prefs["velta-notify-bg"])
            assertFalse(AppModel(platform, scope).backgroundConnection.not())
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun visibleUiDoesNotCompete() = runBlocking {
        val transport = ScriptedRpcTransport(answers())
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-bg-visible-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val model = AppModel(platform, scope)
            model.onAppForeground(true)
            assertFalse(model.catchUpFetch("scheduled"))
            assertTrue(transport.requests.none { "\"background_fetch\"" in it })
        } finally {
            scope.cancel()
        }
    }

    private fun answers() = mapOf(
        "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
        "get_all_account_ids" to "[1]",
        "get_selected_account_id" to "1",
        "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
        "select_account" to "null",
        "start_io_for_all_accounts" to "null",
        "get_chatlist_entries" to "[]",
        "background_fetch" to "null",
    )

    @Test
    fun scheduledFetchStartsAHeadlessCore() = runBlocking {
        val transport = ScriptedRpcTransport(answers())
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-bg-fetch-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            // No connect() first: the job wakes a process with no UI.
            val model = AppModel(platform, scope)
            assertTrue(model.catchUpFetch("scheduled"))
            val fetchIdx = transport.requests.indexOfFirst { "\"background_fetch\"" in it }
            assertTrue(fetchIdx >= 0, "fetched")
            assertTrue(transport.requests[fetchIdx].contains("30"), transport.requests[fetchIdx])
            assertTrue(transport.requests.lastIndexOf(transport.requests.last { "\"start_io_for_all_accounts\"" in it }) < fetchIdx)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun lockedAppNeverSpawnsACore() = runBlocking {
        var spawned = false
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-bg-locked-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport {
                spawned = true
                return ScriptedRpcTransport(answers())
            }
            override fun isAppLocked(): Boolean = true
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val model = AppModel(platform, scope)
            assertFalse(model.catchUpFetch("scheduled"))
            assertFalse(spawned, "no key without the user: no core")
        } finally {
            scope.cancel()
        }
    }
}
