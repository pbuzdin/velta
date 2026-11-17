package org.velta.kmp

import org.velta.kmp.ui.AppIconChoice
import org.velta.kmp.ui.LAUNCHER_ALIAS_CLASSIC
import org.velta.kmp.ui.LAUNCHER_ALIAS_DEFAULT
import org.velta.kmp.ui.launcherAliasState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/** Exactly one launcher activity-alias is enabled for a given icon choice. */
class AppIconRulesTest {

    @Test
    fun defaultEnablesTheBadgeAliasAndDisablesClassic() {
        val (enabled, disabled) = launcherAliasState(AppIconChoice.Default)
        assertEquals(LAUNCHER_ALIAS_DEFAULT, enabled)
        assertEquals(LAUNCHER_ALIAS_CLASSIC, disabled)
        assertNotEquals(enabled, disabled)
    }

    @Test
    fun classicEnablesTheKotlinAliasAndDisablesDefault() {
        val (enabled, disabled) = launcherAliasState(AppIconChoice.Classic)
        assertEquals(LAUNCHER_ALIAS_CLASSIC, enabled)
        assertEquals(LAUNCHER_ALIAS_DEFAULT, disabled)
        assertNotEquals(enabled, disabled)
    }

    @Test
    fun absentPrefIsTheDefaultIcon() {
        assertEquals(AppIconChoice.Default, AppIconChoice.fromPref(null))
        assertEquals(AppIconChoice.Default, AppIconChoice.fromPref("default"))
        assertEquals(AppIconChoice.Default, AppIconChoice.fromPref("nope"))
        assertEquals(AppIconChoice.Classic, AppIconChoice.fromPref("classic"))
    }

    @Test
    fun eachChoiceEnablesExactlyOneKnownAlias() {
        val aliases = setOf(LAUNCHER_ALIAS_DEFAULT, LAUNCHER_ALIAS_CLASSIC)
        for (choice in AppIconChoice.entries) {
            val (enabled, disabled) = launcherAliasState(choice)
            assertEquals(aliases, setOf(enabled, disabled), "choice $choice")
        }
    }
}
