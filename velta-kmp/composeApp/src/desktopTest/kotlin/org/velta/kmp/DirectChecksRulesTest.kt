package org.velta.kmp

import org.velta.kmp.ui.directChecksAllowed
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DirectChecksRulesTest {
    @Test
    fun checksRunDirectOnlyWithoutProxy() {
        assertTrue(directChecksAllowed(null))
        assertTrue(directChecksAllowed(""))
        assertTrue(directChecksAllowed("  "))
        assertFalse(directChecksAllowed("socks5://127.0.0.1:1080"))
        assertFalse(directChecksAllowed("http://proxy.example:3128"))
    }
}
