/*
 * Parity vectors for Velta Prism + the fingerprint identity matrix, pinned
 * against the web app (app/js/name-color.js + app/js/avatar.js) — the same
 * vectors rust-ui/preview/src/{prism,identity}.rs pin. The identity vector
 * "0E69…BED9" is a real profile's key: its legend read Lavender/Khaki/Coral/
 * Green/SteelBlue/Chocolate/Magenta/Lime/Thistle/Olive on the web.
 */
package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.velta.kmp.ui.identityCells
import org.velta.kmp.ui.identityContrastText
import org.velta.kmp.ui.identityGroups
import org.velta.kmp.ui.identityMonoFill
import org.velta.kmp.ui.prismFill
import org.velta.kmp.ui.prismHueOf
import org.velta.kmp.ui.prismInitials
import org.velta.kmp.ui.prismReadableOn

class PrismIdentityTest {

    // nameColor(name) from name-color.js, parsed to RGB. Several dropped
    // from l=55 to 39/40/41 to reach 3:1 on ink — the loop is pinned too.
    @Test
    fun prismFillMatchesWeb() {
        val vectors: List<Pair<String, IntArray>> = listOf(
            "Alice" to intArrayOf(103, 154, 45),
            "bob" to intArrayOf(46, 158, 115),
            "Владимир" to intArrayOf(47, 152, 162),
            "Zoë" to intArrayOf(46, 158, 132),
            "群组" to intArrayOf(203, 77, 144),
            "Relay User" to intArrayOf(203, 77, 90),
            "chatmail.uk" to intArrayOf(46, 158, 100),
            // Astral code point: JS hashes only the high surrogate.
            "🚀rocket" to intArrayOf(79, 77, 203),
            "Alice Bob" to intArrayOf(77, 100, 203),
            "" to intArrayOf(141, 146, 42), // JS `name || "?"` → hashes "?"
        )
        for ((name, rgb) in vectors) {
            assertContentEquals(rgb, prismFill(name), "prismFill($name)")
        }
    }

    @Test
    fun prismHueIsStable() {
        assertEquals(prismHueOf("Alice"), prismHueOf("Alice"))
        kotlin.test.assertNotEquals(prismHueOf("Alice"), prismHueOf("Bob"))
        assertEquals(prismHueOf(""), prismHueOf("?"))
    }

    // readableOn(nameColor(name), bg, 4.6, dir) from the web module.
    @Test
    fun prismReadableOnMatchesWeb() {
        val dark = intArrayOf(0x1C, 0x1F, 0x26)
        val white = intArrayOf(244, 244, 244)
        // Already ≥ 4.6:1 on the dark bubble: unchanged.
        assertContentEquals(intArrayOf(103, 154, 45), prismReadableOn(prismFill("Alice"), dark, 4.6, 1))
        assertContentEquals(intArrayOf(46, 158, 115), prismReadableOn(prismFill("bob"), intArrayOf(0x10, 0x13, 0x1A), 4.6, -1))
        // Lightness walked up 1% at a time until it reads.
        assertContentEquals(intArrayOf(209, 97, 156), prismReadableOn(prismFill("群组"), dark, 4.6, 1))
        assertContentEquals(intArrayOf(211, 105, 116), prismReadableOn(prismFill("Relay User"), dark, 4.6, 1))
        // Falls off the light end → ink.
        assertContentEquals(intArrayOf(244, 244, 244), prismReadableOn(prismFill("Alice"), white, 4.6, 1))
    }

    // components.js #initials semantics, incl. the #151 non-Latin cases.
    @Test
    fun prismInitialsMatchWeb() {
        assertEquals("A", prismInitials("Alice"))
        assertEquals("A", prismInitials("alice"))
        assertEquals("AB", prismInitials("Alice Bob"))
        assertEquals("CA", prismInitials("  carol   anne "))
        assertEquals("АП", prismInitials("Алиса Петрова"))
        assertEquals("群", prismInitials("群组"))
        // Two words → first letters ("12" is one word).
        assertEquals("1G", prismInitials("123 go"))
        assertEquals("ZC", prismInitials("Zoë Chùchò"))
        assertEquals("SSB", prismInitials("ß bc")) // ß uppercases to SS, joined by word
        assertEquals("?", prismInitials("🚀"))
        assertEquals("?", prismInitials(""))
        assertEquals("?", prismInitials("   "))
        assertEquals("?", prismInitials("--- ??"))
    }

    // buildAvatarSvg cell fills (badge=false, mono=false) from avatar.js.
    @Test
    fun identityCellsMatchWeb() {
        val vectors: List<Pair<String, List<String>>> = listOf(
            "0E692C68104336C210093DD12D4021C2591ABED9" to
                listOf("Lavender", "Khaki", "Coral", "Green", "SteelBlue", "Chocolate", "Magenta", "Lime", "Thistle", "Olive"),
            "0123456789ABCDEF0123456789ABCDEF01234567" to
                listOf("Plum", "Yellow", "Coral", "Cyan", "Green", "Orchid", "Olive", "Blue", "SteelBlue", "Turquoise"),
            "0000000000000000000000000000000000000000" to
                listOf("Crimson", "Yellow", "Orchid", "Turquoise", "Indigo", "Beige", "Salmon", "Lavender", "Lime", "SkyBlue"),
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" to
                listOf("Fuchsia", "Aquamarine", "Purple", "Coral", "Thistle", "Olive", "CadetBlue", "Gainsboro", "Maroon", "Peru"),
        )
        for ((fpr, names) in vectors) {
            val cells = identityCells(fpr) ?: error("no cells for $fpr")
            names.forEachIndexed { i, expected -> assertEquals(expected, cells[i].first, "cell $i of $fpr") }
        }
    }

    @Test
    fun identityGroupsRequire40Hex() {
        assertContentEquals(intArrayOf(0x0E69, 0x2C68, 0x1043, 0x36C2, 0x1009, 0x3DD1, 0x2D40, 0x21C2, 0x591A, 0xBED9),
            identityGroups("0E69 2C68 1043 36C2 1009 3DD1 2D40 21C2 591A BED9"))
        assertNull(identityGroups("0E692C68"))
        assertNull(identityGroups(""))
        assertNull(identityCells("nokey"))
    }

    @Test
    fun identityMonoFillAndCaptions() {
        assertContentEquals(intArrayOf(76, 76, 76), identityMonoFill(intArrayOf(255, 0, 0)))
        assertContentEquals(intArrayOf(0, 0, 0), identityMonoFill(intArrayOf(0, 0, 0)))
        assertContentEquals(intArrayOf(255, 255, 255), identityMonoFill(intArrayOf(255, 255, 255)))
        assertContentEquals(intArrayOf(28, 28, 28), identityContrastText(intArrayOf(255, 255, 0))) // Yellow: dark text
        assertContentEquals(intArrayOf(244, 244, 244), identityContrastText(intArrayOf(0, 0, 128))) // Navy: light text
    }
}
