package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.velta.kmp.ui.ConnectivityParse
import org.velta.kmp.ui.RelaySeg
import org.velta.kmp.ui.parseConnectivityHtml
import org.velta.kmp.ui.relaySegmentDisplayState
import org.velta.kmp.ui.relaySeverity

/**
 * Vectors for the per-relay strip port (web app.js parseConnectivityHtml
 * 1141-1176 + the #76 probe downgrade 1124-1133). The fixture mirrors the
 * core's connectivity HTML shape (scheduler/connectivity.rs: one
 * `<li class="transport">` per relay with colored dots, a nested quota
 * `<ul>`, the SMTP dot OUTSIDE the list, the #79 smtp-via span).
 */
class RelayStatesTest {

    private val html = """
        <h3>Connectivity</h3>
        <ul>
        <li class="transport"><span class="green dot"></span> <b>d13.buro.dev:</b> Connected <br>
        <ul class="quota-list"><li>1.3 GiB of 2 GiB used</li><li>67%</li></ul>
        </li>
        <li class="transport"><span class="green dot"></span><span class="yellow dot"></span> <b>backup.example:</b> Connecting…<br></li>
        <li class="transport unpublished"><span class="red dot"></span> <b>old.example:</b> Unpublished</li>
        <li class="transport"><span class="red dot"></span> <b>down.example:</b> Not connected <br></li>
        </ul>
        <p>Outgoing messages <span class="yellow dot"></span></p>
        <span class="smtp-via">d13.buro.dev</span>
    """

    @Test
    fun parsesPerTransportSegments() {
        val p = parseConnectivityHtml(html)
        assertEquals(3, p.segs.size)
        assertEquals("d13.buro.dev", p.segs[0].domain)
        assertEquals("ok", p.segs[0].state)
        assertTrue(p.segs[0].quota.contains("67%"))
        // Worst dot wins (green+yellow → connecting).
        assertEquals("connecting", p.segs[1].state)
        assertEquals("down.example", p.segs[2].domain)
        assertEquals("down", p.segs[2].state)
        // Unpublished relay skipped.
        assertTrue(p.segs.none { it.domain == "old.example" })
    }

    @Test
    fun smtpDotLivesOutsideTheList() {
        val p = parseConnectivityHtml(html)
        assertEquals("connecting", p.smtpState) // the last span-dot in the document
        assertEquals("d13.buro.dev", p.smtpVia) // #79 sending attribution
    }

    @Test
    fun emptyOrForeignHtmlYieldsNoSegments() {
        assertEquals(ConnectivityParse(emptyList(), null, null), parseConnectivityHtml(""))
        assertNull(parseConnectivityHtml("<body>nothing</body>").smtpState)
    }

    @Test
    fun probeDowngradeVectors() {
        // No probe data → core state untouched.
        assertEquals("ok", relaySegmentDisplayState("ok", null, null, 0))
        assertEquals("connecting", relaySegmentDisplayState("connecting", true, null, 0))
        // Probe failing while core green → unreachable.
        assertEquals("unreachable", relaySegmentDisplayState("ok", false, 1000, 2000))
        // Failing while core amber stays amber (grace period).
        assertEquals("connecting", relaySegmentDisplayState("connecting", false, 1000, 2000))
        // Failing ≥10 min → offline grey, regardless.
        assertEquals("offline", relaySegmentDisplayState("ok", false, 0, 11 * 60 * 1000L))
        assertEquals("offline", relaySegmentDisplayState("connecting", false, 0, 11 * 60 * 1000L))
    }

    @Test
    fun severityOrdering() {
        assertTrue(relaySeverity("down") > relaySeverity("offline"))
        assertTrue(relaySeverity("offline") > relaySeverity("connecting"))
        assertTrue(relaySeverity("connecting") > relaySeverity("ok"))
        assertEquals(0, relaySeverity(null))
    }

    @Test
    fun htmlWithoutTransportLiStillFindsSmtpDot() {
        // Web app.js:1144 — no transport <li> means an EARLY RETURN with a
        // null SMTP state (the dot is never looked at without transports).
        val p = parseConnectivityHtml("<p>Outgoing <span class=\"green dot\"></span></p>")
        assertEquals(emptyList<RelaySeg>(), p.segs)
        assertNull(p.smtpState)
    }
}
