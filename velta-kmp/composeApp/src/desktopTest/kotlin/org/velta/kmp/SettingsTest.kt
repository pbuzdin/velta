package org.velta.kmp

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.ui.Accent
import org.velta.kmp.ui.L
import org.velta.kmp.ui.VeltaThemeChoice
import org.velta.kmp.ui.VeltaThemeMode
import org.velta.kmp.ui.VeltaTokenSets
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.veltaEffectiveMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #321 step 5: appearance + language settings. */
class SettingsTest {

    /** In-memory prefs platform: same seam the real impls fill. */
    private class MemPrefsPlatform : CorePlatform {
        val store = mutableMapOf<String, String>()
        override fun accountsDir() = "."
        override fun spawnRpcServer(accountsDir: String) = null
        override fun pref(key: String): String? = store[key]
        override fun setPref(key: String, value: String?) {
            if (value == null) store.remove(key) else store[key] = value
        }
    }

    @Test
    fun effectiveModeLayersAmoledOnDarkOnly() {
        assertEquals(VeltaThemeMode.Dark, veltaEffectiveMode(VeltaThemeChoice.Auto, amoled = false, systemDark = true))
        assertEquals(VeltaThemeMode.Light, veltaEffectiveMode(VeltaThemeChoice.Auto, amoled = false, systemDark = false))
        assertEquals(VeltaThemeMode.Amoled, veltaEffectiveMode(VeltaThemeChoice.Dark, amoled = true, systemDark = false))
        assertEquals(VeltaThemeMode.Dark, veltaEffectiveMode(VeltaThemeChoice.Dark, amoled = false, systemDark = false))
        // AMOLED never applies outside dark (web app.js applyTheme).
        assertEquals(VeltaThemeMode.Light, veltaEffectiveMode(VeltaThemeChoice.Light, amoled = true, systemDark = false))
        assertEquals(VeltaThemeMode.Brutal, veltaEffectiveMode(VeltaThemeChoice.Brutal, amoled = true, systemDark = true))
    }

    @Test
    fun normHexExpandsAndRejects() {
        assertEquals("#aabbcc", Accent.normHex("#ABC"))
        assertEquals("#1fa69a", Accent.normHex(" #1FA69A "))
        assertNull(Accent.normHex("1fa69a"))
        assertNull(Accent.normHex("#12345"))
        assertNull(Accent.normHex("#12zzzz"))
    }

    @Test
    fun contrastMathMatchesWcag() {
        // Black on white is 21:1 by definition.
        assertEquals(21.0, Accent.contrast("#000000", "#ffffff"), 0.01)
        // The stock accent clears 4.5 on the dark bubble.
        assertTrue(Accent.contrast("#5aa2e6", "#1c1c26") >= 4.5)
    }

    @Test
    fun deriveKeepsEveryGuarantee() {
        val base = VeltaTokenSets.Dark
        val out = Accent.derive(base, "#ee8a1f")
        val hexOf = { c: Color -> "#%06x".format(c.toArgb() and 0xFFFFFF) }
        val accentHex = hexOf(out.accent)
        // accent on the incoming bubble and the chat surface >= 4.5:1
        assertTrue(Accent.contrast(accentHex, hexOf(base.bgBubbleIn)) >= 4.5, "accent vs bubbleIn")
        assertTrue(Accent.contrast(accentHex, hexOf(base.bgChat)) >= 4.5, "accent vs chat")
        // body text on the derived own bubble >= 7:1 (meta/link headroom)
        assertTrue(Accent.contrast(hexOf(base.text), hexOf(out.bgBubbleOut)) >= 7.0, "text vs bubbleOut")
        assertTrue(Accent.contrast(hexOf(out.textMetaOut), hexOf(out.bgBubbleOut)) >= 4.5, "metaOut vs bubbleOut")
        assertTrue(Accent.contrast(hexOf(out.outLink), hexOf(out.bgBubbleOut)) >= 4.5, "outLink vs bubbleOut")
        assertTrue(Accent.contrast(hexOf(out.ticksRead), hexOf(out.bgBubbleOut)) >= 3.0, "ticksRead vs bubbleOut")
        // accent text on every app surface >= 4.6:1 — the alpha-carrying
        // tokens composite over their real backdrops (same rule as Accent).
        val surfaces = listOf(
            base.bgSidebar,
            base.bgBubbleIn,
            Accent.opaque(base.bgReply, base.bgBubbleIn),
            Accent.opaque(base.bgHover, base.bg),
        )
        for (bg in surfaces) {
            assertTrue(Accent.contrast(hexOf(out.accentText), hexOf(bg)) >= 4.6, "accentText vs ${hexOf(bg)}")
        }
    }

    @Test
    fun invalidAccentReturnsBaseBrutalTouchesFillsOnly() {
        val dark = VeltaTokenSets.Dark
        assertEquals(dark, Accent.derive(dark, "junk"))
        assertEquals(dark, Accent.derive(dark, null))
        val brutal = VeltaTokenSets.Brutal
        val out = Accent.derive(brutal, "#3fa34d", brutal = true)
        // BRUTAL_KEYS: accent fills + accent text; own bubble/selection stay stock.
        assertTrue(out.accent != brutal.accent)
        assertEquals(brutal.bgBubbleOut, out.bgBubbleOut)
        assertEquals(brutal.selectionBg, out.selectionBg)
        assertEquals(brutal.textMetaOut, out.textMetaOut)
        assertTrue(out.accentText != brutal.accentText)
    }

    @Test
    fun settingsPersistThroughThePlatformSeam() {
        val platform = MemPrefsPlatform()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.onSetTheme(VeltaThemeChoice.Brutal)
            model.onSetAmoled(true)
            model.onSetAccent("#3fa34d")
            model.onSetLang("ru")
            assertEquals("brutal", platform.store["dw-theme"])
            assertEquals("1", platform.store["velta-amoled"])
            assertEquals("#3fa34d", platform.store["velta-accent"])
            assertEquals("ru", platform.store["velta-lang"])
            // A NEW model resumes every setting (web localStorage semantics).
            val model2 = AppModel(platform, scope)
            assertEquals(VeltaThemeChoice.Brutal, model2.themeChoice)
            assertEquals(true, model2.amoled)
            assertEquals("#3fa34d", model2.accentHex)
            assertEquals("ru", model2.lang)
            // Stock accent + English remove their keys (web write()/setLang).
            model2.onSetAccent(null)
            model2.onSetLang("en")
            assertNull(platform.store["velta-accent"])
            assertNull(platform.store["velta-lang"])
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun translationFallsBackToEnglishAndSwitches() {
        val english = L.t("Search chats")
        assertEquals("Search chats", english)
        L.lang = "ru"
        try {
            assertEquals("Поиск чатов", L.t("Search chats"))
            assertEquals("Сообщение", L.t("Message"))
            assertEquals("Totally not a pack key", L.t("Totally not a pack key"), "missing keys stay English")
        } finally {
            L.lang = "en"
        }
    }
}
