package org.velta.kmp

import org.velta.kmp.ui.AppIconChoice
import org.velta.kmp.ui.LAUNCHER_ALIASES
import org.velta.kmp.ui.LAUNCHER_ALIAS_BADGE
import org.velta.kmp.ui.LAUNCHER_ALIAS_CLASSIC
import org.velta.kmp.ui.LAUNCHER_ALIAS_DEFAULT
import org.velta.kmp.ui.launcherAliasState
import org.velta.kmp.ui.notificationIconName
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/** Exactly one launcher activity-alias is enabled for a given icon choice. */
class AppIconRulesTest {

    @Test
    fun defaultEnablesTheIceAliasAndDisablesTheOthers() {
        val state = launcherAliasState(AppIconChoice.Default)
        assertEquals(LAUNCHER_ALIAS_DEFAULT, state.enabled)
        assertEquals(listOf(LAUNCHER_ALIAS_BADGE, LAUNCHER_ALIAS_CLASSIC), state.disabled)
    }

    @Test
    fun badgeEnablesTheKBadgeAliasAndDisablesTheOthers() {
        val state = launcherAliasState(AppIconChoice.Badge)
        assertEquals(LAUNCHER_ALIAS_BADGE, state.enabled)
        assertEquals(listOf(LAUNCHER_ALIAS_DEFAULT, LAUNCHER_ALIAS_CLASSIC), state.disabled)
    }

    @Test
    fun classicEnablesTheKotlinAliasAndDisablesTheOthers() {
        val state = launcherAliasState(AppIconChoice.Classic)
        assertEquals(LAUNCHER_ALIAS_CLASSIC, state.enabled)
        assertEquals(listOf(LAUNCHER_ALIAS_DEFAULT, LAUNCHER_ALIAS_BADGE), state.disabled)
    }

    @Test
    fun absentPrefIsTheDefaultIcon() {
        assertEquals(AppIconChoice.Default, AppIconChoice.fromPref(null))
        assertEquals(AppIconChoice.Default, AppIconChoice.fromPref("default"))
        assertEquals(AppIconChoice.Default, AppIconChoice.fromPref("nope"))
        assertEquals(AppIconChoice.Badge, AppIconChoice.fromPref("badge"))
        assertEquals(AppIconChoice.Classic, AppIconChoice.fromPref("classic"))
    }

    @Test
    fun eachChoiceEnablesExactlyOneKnownAlias() {
        val aliases = LAUNCHER_ALIASES.toSet()
        for (choice in AppIconChoice.entries) {
            val state = launcherAliasState(choice)
            assertFalse(state.enabled in state.disabled, "choice $choice enabled is also disabled")
            assertEquals(aliases, setOf(state.enabled) + state.disabled, "choice $choice")
            assertEquals(aliases.size - 1, state.disabled.distinct().size, "choice $choice")
        }
    }

    @Test
    fun notificationGlyphNameFollowsTheChoice() {
        assertEquals("ic_notify_default", AppIconChoice.Default.notificationIconName)
        assertEquals("ic_notify_badge", AppIconChoice.Badge.notificationIconName)
        assertEquals("ic_notify_classic", AppIconChoice.Classic.notificationIconName)
    }
}
