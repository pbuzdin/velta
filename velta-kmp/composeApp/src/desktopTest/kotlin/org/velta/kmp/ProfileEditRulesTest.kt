package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.AvatarChange
import org.velta.kmp.ui.ProfileEdit
import org.velta.kmp.ui.clampProfileName
import org.velta.kmp.ui.previewAvatar
import org.velta.kmp.ui.profileConfigWrites
import org.velta.kmp.ui.profileEditOf
import org.velta.kmp.ui.showsEditProfile
import org.velta.kmp.ui.showsRemovePhoto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #358 C: stable showEditProfile + editProfileFlow. */
class ProfileEditRulesTest {

    @Test
    fun editResultTrimsAndPicksTheAvatarChange() {
        assertEquals(ProfileEdit("Ann", "hi", AvatarChange.Keep), profileEditOf("  Ann ", " hi ", null, false))
        assertEquals(AvatarChange.Picked("/p.jpg"), profileEditOf("a", "", "/p.jpg", false).avatar)
        assertEquals(AvatarChange.Remove, profileEditOf("a", "", "/p.jpg", true).avatar)
        assertEquals(64, clampProfileName("x".repeat(80)).length)
    }

    @Test
    fun previewAndRemoveButton() {
        assertEquals("/old.jpg", previewAvatar("/old.jpg", null, false))
        assertEquals("/new.jpg", previewAvatar("/old.jpg", "/new.jpg", false))
        assertNull(previewAvatar("/old.jpg", null, true))
        assertFalse(showsRemovePhoto(null, null, false))
        assertFalse(showsRemovePhoto("", null, false))
        assertTrue(showsRemovePhoto(null, "/new.jpg", false))
    }

    @Test
    fun configWritesFollowEditProfileFlow() {
        assertEquals(
            listOf("displayname" to "Ann"),
            profileConfigWrites(ProfileEdit("Ann", "same", AvatarChange.Keep), "same"),
        )
        assertEquals(
            listOf("displayname" to null, "selfavatar" to null, "selfstatus" to null),
            profileConfigWrites(ProfileEdit("", "", AvatarChange.Remove), "old"),
        )
        assertEquals(
            listOf("displayname" to "A", "selfavatar" to "/p.jpg", "selfstatus" to "new bio"),
            profileConfigWrites(ProfileEdit("A", "new bio", AvatarChange.Picked("/p.jpg")), ""),
        )
        assertTrue(showsEditProfile(1))
        assertFalse(showsEditProfile(7))
        assertFalse(showsEditProfile(null))
    }

    private fun transport(set: String = "null") = ScriptedRpcTransport(
        mapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to "[1]",
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"a@relay.example.dev","displayName":"Ann","isConfigured":true}""",
            "get_all_accounts" to """[{"id":1,"addr":"a@relay.example.dev","isConfigured":true}]""",
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "get_chatlist_entries" to "[5]",
            "get_chatlist_items_by_entries" to
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
            "get_contact" to """{"id":1,"name":"Ann","displayName":"Ann","address":"a@relay.example.dev","status":"old bio","color":"#5aa2e6"}""",
            "set_config" to set,
            "list_transports" to """[{"addr":"a@relay.example.dev"}]""",
            "get_server_metadata" to "{}",
        ),
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-profile-edit-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = t
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            until { model.screen == AppModel.Screen.ChatList && model.chats.isNotEmpty() }
            block(model)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun saveWritesNameAvatarAndChangedStatus() {
        val t = transport()
        run(t) { m ->
            var picks = 0
            m.attachmentPicker = { picks++ }
            m.openProfileEditor()
            until { m.profileEditor != null }
            assertEquals("Ann", m.profileEditor!!.name)
            assertEquals("old bio", m.profileEditor!!.description)
            m.editProfileName(" Ann B ")
            m.editProfileDescription("new bio")
            m.pickProfilePhoto()
            assertEquals(1, picks)
            m.onAttachmentPicked("/tmp/pick.jpg", "pick.jpg")
            assertEquals("/tmp/pick.jpg", m.profileEditor!!.picked)
            assertNull(m.pendingAttachment, "the picture is not an attachment")
            m.saveProfileEditor()
            until { m.profileEditor == null }
            val sets = t.requests.filter { "\"set_config\"" in it }
            assertTrue(sets[0].contains("""[1,"displayname","Ann B"]"""), sets[0])
            assertTrue(sets[1].contains("""[1,"selfavatar","/tmp/pick.jpg"]"""), sets[1])
            assertTrue(sets[2].contains("""[1,"selfstatus","new bio"]"""), sets[2])
            assertEquals("Profile updated", m.toast)
        }
    }

    @Test
    fun aFailedSaveStaysOpenWithTheError() {
        run(transport(set = "ERROR:disk full")) { m ->
            m.openProfileEditor()
            until { m.profileEditor != null }
            m.saveProfileEditor()
            until { m.profileEditor?.error != null }
            assertTrue(m.profileEditor!!.error!!.startsWith("Couldn't update profile: "))
            assertFalse(m.profileEditor!!.busy)
        }
    }
}
