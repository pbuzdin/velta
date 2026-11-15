package org.velta.kmp

import org.velta.kmp.core.Contact
import org.velta.kmp.ui.MentionMember
import org.velta.kmp.ui.SenderFace
import org.velta.kmp.ui.senderFace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Group bubbles keep the sender contact's color, photo, and member fingerprint. */
class GroupAvatarTest {
    @Test
    fun senderFaceKeepsContactColorPhotoAndFingerprint() {
        val fpr = "AB" + "C".repeat(38)
        val member = MentionMember(
            id = 7,
            name = "Ada Lovelace",
            code = "ABCC",
            color = "#445566",
            avatarPath = "/members/ada.jpg",
            fingerprint = fpr,
        )
        val wire = senderFace(
            Contact(
                id = 7,
                displayName = "Ada",
                name = "Ada Lovelace",
                address = "ada@example.org",
                color = "#112233",
                profileImage = "/blobs/ada.jpg",
            ),
            member,
            cachedName = "cached",
            fallbackName = "Unknown",
        )
        assertEquals("Ada", wire.name)
        assertEquals("#112233", wire.colorHex)
        assertEquals("/blobs/ada.jpg", wire.avatarPath)
        assertEquals(fpr, wire.fingerprint)

        val fromMember = senderFace(
            Contact(id = 7, color = "nope", profileImage = "  "),
            member,
            cachedName = null,
            fallbackName = "Unknown",
        )
        assertEquals("Ada Lovelace", fromMember.name)
        assertEquals("#445566", fromMember.colorHex)
        assertEquals("/members/ada.jpg", fromMember.avatarPath)
        assertEquals(fpr, fromMember.fingerprint)

        val addr = senderFace(
            Contact(address = "ada@example.org"),
            member = null,
            cachedName = null,
            fallbackName = "Unknown",
        )
        assertEquals("ada@example.org", addr.name)
        assertEquals("#888888", addr.colorHex)
        assertNull(addr.avatarPath)
        assertNull(addr.fingerprint)

        val missing = senderFace(null, null, null, "Unknown")
        assertEquals("Unknown", missing.name)
        assertEquals("#888888", missing.colorHex)
        assertNull(missing.avatarPath)

        val kept = senderFace(
            null,
            null,
            cachedName = null,
            fallbackName = "Unknown",
            cached = SenderFace("Pat", "#ABCDEF", "/cache/pat.jpg", "FF".repeat(20)),
        )
        assertEquals("Pat", kept.name)
        assertEquals("#abcdef", kept.colorHex)
        assertEquals("/cache/pat.jpg", kept.avatarPath)
        assertEquals("FF".repeat(20), kept.fingerprint)
    }
}
