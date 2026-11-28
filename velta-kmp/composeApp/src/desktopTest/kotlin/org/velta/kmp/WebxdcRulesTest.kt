package org.velta.kmp

import org.velta.kmp.ui.WEBXDC_CSP
import org.velta.kmp.ui.webxdcArchivePath
import org.velta.kmp.ui.webxdcHost
import org.velta.kmp.ui.webxdcLinkLeaves
import org.velta.kmp.ui.webxdcOrigin
import org.velta.kmp.ui.webxdcRequestAllowed
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** KMP webxdc: per-instance origin, request filter, link rules. */
class WebxdcRulesTest {

    @Test
    fun everyInstanceHasItsOwnOrigin() {
        assertEquals("a1m42.xdc.local", webxdcHost(1, 42))
        assertEquals("https://a1m42.xdc.local/", webxdcOrigin(1, 42))
        assertNotEquals(webxdcHost(1, 42), webxdcHost(1, 43))
        // The same message id in another account is another origin too.
        assertNotEquals(webxdcHost(1, 42), webxdcHost(2, 42))
        // "a1m23" must never collide with "a12m3": the digits are delimited.
        assertNotEquals(webxdcHost(1, 23), webxdcHost(12, 3))
    }

    @Test
    fun onlyTheAppsOwnHostIsServed() {
        val own = webxdcHost(1, 42)
        assertTrue(webxdcRequestAllowed("https", own, own))
        assertTrue(webxdcRequestAllowed("HTTPS", own.uppercase(), own))
        assertTrue(webxdcRequestAllowed("data", null, own))
        assertTrue(webxdcRequestAllowed("blob", null, own))
        assertFalse(webxdcRequestAllowed("https", webxdcHost(1, 43), own), "another app's origin")
        assertFalse(webxdcRequestAllowed("https", "example.org", own))
        assertFalse(webxdcRequestAllowed("http", own, own), "no cleartext on the app host")
        assertFalse(webxdcRequestAllowed("wss", own, own))
        assertFalse(webxdcRequestAllowed("file", null, own))
        assertFalse(webxdcRequestAllowed("content", "media", own))
        assertFalse(webxdcRequestAllowed("intent", null, own))
        assertFalse(webxdcRequestAllowed(null, null, own))
    }

    @Test
    fun linksLeaveOnlyOnAUserTapOnHttp() {
        assertTrue(webxdcLinkLeaves("https", true))
        assertTrue(webxdcLinkLeaves("http", true))
        assertFalse(webxdcLinkLeaves("https", false), "script or redirect")
        for (s in listOf("intent", "file", "content", "tel", "sms", "mailto", "javascript", "market", null)) {
            assertFalse(webxdcLinkLeaves(s, true), "$s")
        }
    }

    @Test
    fun archivePathDefaultsToIndex() {
        assertEquals("index.html", webxdcArchivePath(emptyList()))
        assertEquals("js/app.js", webxdcArchivePath(listOf("js", "app.js")))
    }

    @Test
    fun policyBlocksOtherHosts() {
        assertTrue(WEBXDC_CSP.contains("connect-src 'self' data: blob:"))
        assertTrue(WEBXDC_CSP.contains("form-action 'none'"))
        assertFalse(WEBXDC_CSP.contains("http:") || WEBXDC_CSP.contains("https:") || WEBXDC_CSP.contains("*"))
    }
}
