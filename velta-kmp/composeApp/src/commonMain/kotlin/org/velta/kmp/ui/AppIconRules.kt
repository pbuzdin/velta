package org.velta.kmp.ui

/**
 * Launcher-icon choice: the default two-tone ice icon, the previous
 * Kotlin-coloured "Classic KMP" icon, or the #382 "K badge" icon.
 * Android applies this with activity-aliases; the rule is kept pure so
 * a desktop unit test can pin "exactly one alias enabled".
 */
enum class AppIconChoice {
    Default,
    Badge,
    Classic,
    ;

    val prefValue: String
        get() = when (this) {
            Default -> "default"
            Badge -> "badge"
            Classic -> "classic"
        }

    companion object {
        /** Absent or unknown pref = the default (ice short-stroke) icon. */
        fun fromPref(value: String?): AppIconChoice = when (value) {
            Badge.prefValue -> Badge
            Classic.prefValue -> Classic
            else -> Default
        }
    }
}

/** The settings label; the state word in "App icon: K badge". */
internal fun appIconLabel(c: AppIconChoice): String = when (c) {
    AppIconChoice.Default -> "Default"
    AppIconChoice.Badge -> "K badge"
    AppIconChoice.Classic -> "Classic KMP"
}

const val LAUNCHER_ALIAS_DEFAULT = "org.velta.kmp.MainActivityDefault"
const val LAUNCHER_ALIAS_BADGE = "org.velta.kmp.MainActivityBadge"
const val LAUNCHER_ALIAS_CLASSIC = "org.velta.kmp.MainActivityClassic"

val LAUNCHER_ALIASES = listOf(
    LAUNCHER_ALIAS_DEFAULT,
    LAUNCHER_ALIAS_BADGE,
    LAUNCHER_ALIAS_CLASSIC,
)

/** The pref key behind the choice (AppModel + the android notification glyph). */
const val APP_ICON_PREF = "velta-app-icon"

/** Status-bar glyph per choice — generated white vectors (ic_notify_*.xml). */
val AppIconChoice.notificationIconName: String
    get() = "ic_notify_${prefValue}"


/** The alias that must be enabled, and the ones that must be disabled. */
data class LauncherAliasState(val enabled: String, val disabled: List<String>)

fun launcherAliasState(choice: AppIconChoice): LauncherAliasState {
    val enabled = when (choice) {
        AppIconChoice.Default -> LAUNCHER_ALIAS_DEFAULT
        AppIconChoice.Badge -> LAUNCHER_ALIAS_BADGE
        AppIconChoice.Classic -> LAUNCHER_ALIAS_CLASSIC
    }
    return LauncherAliasState(enabled, LAUNCHER_ALIASES.filter { it != enabled })
}
