package org.velta.kmp

import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.VeltaTokenSets
import org.velta.kmp.ui.bubbleRadiusPref
import org.velta.kmp.ui.clampMsgFont
import org.velta.kmp.ui.detectTextLang
import org.velta.kmp.ui.fontPrefValue
import org.velta.kmp.ui.hyphenFallback
import org.velta.kmp.ui.pxLabel
import org.velta.kmp.ui.showStickersInMenu
import org.velta.kmp.ui.storedBubbleRadius
import org.velta.kmp.ui.withBubbleRadius
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Web chat-appearance.js write() + text-lang.js detectTextLang. */
class ChatAppearanceTest {

    private class MemPrefs : CorePlatform {
        val store = mutableMapOf<String, String>()
        override fun accountsDir() = "."
        override fun spawnRpcServer(accountsDir: String) = null
        override fun pref(key: String) = store[key]
        override fun setPref(key: String, value: String?) {
            if (value == null) store.remove(key) else store[key] = value
        }
    }

    @Test
    fun clampsRadiiLangAndPrefsMatchTheWeb() {
        assertEquals(15.5f, clampMsgFont(null as String?))
        assertEquals(15.5f, clampMsgFont("nope"))
        assertEquals(10f, clampMsgFont("1"))
        assertEquals(22f, clampMsgFont("30"))
        assertEquals(16f, clampMsgFont("15.8"))
        assertNull(fontPrefValue(15.5f))
        assertEquals("16", fontPrefValue(16f))
        assertEquals("16.5", fontPrefValue(16.5f))
        assertEquals("15.5 px", pxLabel(15.5f))
        assertEquals("14 px", pxLabel(14f))

        assertNull(storedBubbleRadius(null))
        assertEquals(14, storedBubbleRadius("nope"))
        assertEquals(0, storedBubbleRadius("-3"))
        assertEquals(14, storedBubbleRadius("20"))
        assertEquals(7, storedBubbleRadius("7.4"))
        assertNull(bubbleRadiusPref(14, themeRadiusPx = 14))
        assertNull(bubbleRadiusPref(6, themeRadiusPx = 6))
        assertEquals(10, bubbleRadiusPref(10, themeRadiusPx = 14))

        val dark = VeltaTokenSets.Dark
        assertSame(dark, withBubbleRadius(dark, null))
        val square = withBubbleRadius(dark, 0)
        assertEquals(0.dp, square.radiusBubble)
        assertEquals(0.dp, square.radiusTail)
        assertEquals(0.dp, square.radiusQuote)
        assertEquals(0.dp, square.radiusMedia)
        val ten = withBubbleRadius(dark, 10)
        assertEquals(10.dp, ten.radiusBubble)
        assertEquals(6.dp, ten.radiusTail)
        assertEquals(6.dp, ten.radiusQuote)
        assertEquals(6.dp, ten.radiusMedia)
        // Brutal's stock media corner stays 10 when the radius key is absent.
        assertEquals(10.dp, withBubbleRadius(VeltaTokenSets.Brutal, null).radiusMedia)

        assertEquals("ru", detectTextLang("Открой Velta и…", "en"))
        assertEquals("en", detectTextLang("hello world", "ru"))
        assertEquals("ru", detectTextLang("да ok", "ru"))
        assertEquals("en", detectTextLang("https://example.com/very/long", "en"))
        assertEquals("ru", detectTextLang("Привет https://example.com/latin/path", "en"))
        assertEquals("en", hyphenFallback("fr"))
        assertEquals("ru", hyphenFallback("ru"))

        // Stickers live in the attach menu only; no pref, no composer button.
        assertTrue(showStickersInMenu(p2pGroup = false))
        assertFalse(showStickersInMenu(p2pGroup = true))

        val platform = MemPrefs()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            assertEquals(15.5f, model.msgFont)
            assertNull(model.bubbleRadius)
            assertEquals(true, model.hyphensOn)
            assertEquals(false, model.glassComposer)
            model.onSetMsgFont(18f)
            model.onSetBubbleRadius(10, themeRadiusPx = 14)
            model.onSetHyphens(false)
            model.onSetGlassComposer(true)
            assertEquals("18", platform.store["velta-msg-font-size"])
            assertEquals("10", platform.store["velta-bubble-radius"])
            assertEquals("0", platform.store["velta-hyphens"])
            assertEquals("1", platform.store["velta-glass-composer"])
            val resumed = AppModel(platform, scope)
            assertEquals(18f, resumed.msgFont)
            assertEquals(10, resumed.bubbleRadius)
            assertEquals(false, resumed.hyphensOn)
            assertEquals(true, resumed.glassComposer)
            resumed.onSetMsgFont(15.5f)
            resumed.onSetBubbleRadius(14, themeRadiusPx = 14)
            resumed.onSetHyphens(true)
            resumed.onSetGlassComposer(false)
            assertNull(platform.store["velta-msg-font-size"])
            assertNull(platform.store["velta-bubble-radius"])
            assertNull(platform.store["velta-hyphens"])
            assertEquals("0", platform.store["velta-glass-composer"])
            assertEquals(false, resumed.glassComposer)
        } finally {
            scope.cancel()
        }
    }
}
