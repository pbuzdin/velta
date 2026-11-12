package org.velta.kmp.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Port of app/js/i18n.js (#321 step 5): the English string IS the key — a
 * missing pack value falls back to English itself (t(), i18n.js:41-47).
 * Packs are GENERATED from app/locales/{ru,fr}.json by
 * tools/gen-kmp-strings.mjs, filtered to the keys this client uses.
 * Unlike the web there is no location.reload(): [lang] is compose state, so
 * switching the language re-renders live.
 */
object L {
    /** Web LANG_KEY "velta-lang" values: en/fr/ru (i18n.js:9 LANGS). */
    var lang by mutableStateOf("en")

    val LANGS = listOf("en" to "English", "fr" to "Français", "ru" to "Русский")

    fun t(en: String): String = when (lang) {
        "ru" -> LangRu.MAP[en] ?: en
        "fr" -> LangFr.MAP[en] ?: en
        else -> en
    }
}
