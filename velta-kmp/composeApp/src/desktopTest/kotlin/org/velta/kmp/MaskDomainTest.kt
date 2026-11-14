package org.velta.kmp

import org.velta.kmp.ui.maskRelayDomain
import kotlin.test.Test
import kotlin.test.assertEquals

/** Relay detail chips (web pull-open): the masked-domain vectors. */
class MaskDomainTest {

    @Test
    fun masksLikeWebMaskRelayDomain() {
        // app.js:1266 — first 3 chars + "*" + ONLY the last dot label
        // (d13.buro.dev → "d13*.dev", not the full second-level label).
        assertEquals("d13*.dev", maskRelayDomain("d13.buro.dev"))
        assertEquals("cha*.uk", maskRelayDomain("chatmail.uk"))
        // Single-label host: no dot → first 3 chars + "*".
        assertEquals("loc*", maskRelayDomain("localhost"))
        // Degenerate inputs keep the web's fallbacks.
        assertEquals("relay", maskRelayDomain(""))
        assertEquals("relay", maskRelayDomain(null))
    }
}
