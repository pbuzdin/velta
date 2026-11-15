package org.velta.kmp

import org.velta.kmp.ui.decodeExtraHosts
import org.velta.kmp.ui.encodeExtraHosts
import org.velta.kmp.ui.findShortInviteLinks
import org.velta.kmp.ui.firstInviteIn
import org.velta.kmp.ui.inviteCandidates
import org.velta.kmp.ui.inviteLabel
import org.velta.kmp.ui.isShortInviteLink
import org.velta.kmp.ui.normalizeInviteHost
import org.velta.kmp.ui.parseInviteLink
import org.velta.kmp.ui.recognizedExtraHosts
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #324 surface: extra hosts, card labels, deltachat.id short links. */
class InviteSurfaceTest {

    @AfterTest
    fun clearHosts() {
        recognizedExtraHosts = emptySet()
    }

    @Test
    fun registryLabelsAndShortLinks() {
        val fp = "0123456789abcdef0123456789abcdef01234567"
        assertEquals("mirror.example.org", normalizeInviteHost("HTTPS://Mirror.Example.org/join"))
        assertNull(normalizeInviteHost("localhost"))
        assertNull(normalizeInviteHost("not a host"))
        assertEquals("""["mirror.example.org"]""", encodeExtraHosts(listOf("mirror.example.org")))
        assertNull(encodeExtraHosts(emptyList()))
        assertEquals(listOf("mirror.example.org"), decodeExtraHosts("""["Mirror.Example.org"]"""))
        assertEquals(emptyList(), decodeExtraHosts("nope"))

        recognizedExtraHosts = setOf("mirror.example.org")
        assertEquals(
            "https://i.delta.chat/#$fp&n=Ada",
            parseInviteLink("https://mirror.example.org/#$fp&n=Ada"),
        )
        assertNull(parseInviteLink("https://github.com/a/b/commit/$fp"))
        recognizedExtraHosts = emptySet()
        assertNull(parseInviteLink("https://mirror.example.org/#$fp"))

        val group = inviteLabel("https://i.delta.chat/#$fp&n=Ada&g=Chat+RU&a=ada@example.org")
        assertEquals("Ada invited you to a Chat RU group", group.title)
        assertEquals("ada@example.org", group.sub)
        assertEquals(
            "Subscribe to News",
            inviteLabel("https://i.delta.chat/#$fp&b=News").title,
        )
        assertEquals("Chat with Bob", inviteLabel("https://i.delta.chat/#$fp&n=Bob").title)
        assertEquals("", inviteLabel("https://i.delta.chat/#$fp&n=Bob").sub)
        assertEquals("Chat with Someone", inviteLabel("https://i.delta.chat/#$fp").title)

        assertTrue(isShortInviteLink("https://deltachat.id/ada"))
        assertTrue(isShortInviteLink("https://deltachat.id/ada?x=1"))
        assertEquals(false, isShortInviteLink("https://deltachat.id/ada/no"))
        assertEquals(false, isShortInviteLink("http://deltachat.id/ada"))
        assertEquals(listOf("https://deltachat.id/ada"), findShortInviteLinks("see https://deltachat.id/ada. and `https://deltachat.id/hidden`"))

        val html = """<a href="https://i.delta.chat/#$fp&amp;n=Ada">x</a> https://example.com/no"""
        assertEquals(
            "https://i.delta.chat/#$fp&n=Ada",
            firstInviteIn(inviteCandidates(html)),
        )
    }
}
