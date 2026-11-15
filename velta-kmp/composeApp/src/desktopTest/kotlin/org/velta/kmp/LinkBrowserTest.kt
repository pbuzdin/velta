package org.velta.kmp

import org.velta.kmp.ui.pickCustomTabProvider
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Stable InAppBrowser: default browser beats service order. */
class LinkBrowserTest {
    @Test
    fun defaultBrowserWinsWhenItHostsTabs() {
        assertEquals(
            "com.microsoft.emmx",
            pickCustomTabProvider(
                defaultBrowser = "com.microsoft.emmx",
                servicePackages = listOf("com.chrome.dev", "com.microsoft.emmx"),
                candidate = "com.android.chrome",
            ),
        )
    }

    @Test
    fun firstServiceWhenDefaultCannotHost() {
        assertEquals(
            "com.android.chrome",
            pickCustomTabProvider("com.vivo.browser", listOf("com.android.chrome"), null),
        )
    }

    @Test
    fun candidateThenNothing() {
        assertEquals("org.mozilla.firefox", pickCustomTabProvider(null, emptyList(), "org.mozilla.firefox"))
        assertNull(pickCustomTabProvider(null, emptyList(), null))
    }
}
