package org.velta.kmp.ui

/**
 * Launcher-icon choice (default badge icon vs the previous Kotlin-coloured
 * "Classic KMP" icon). Android applies this with activity-aliases; the rule
 * is kept pure so a desktop unit test can pin "exactly one alias enabled".
 */
enum class AppIconChoice {
    Default,
    Classic,
    ;

    val prefValue: String
        get() = when (this) {
            Default -> "default"
            Classic -> "classic"
        }

    companion object {
        /** Absent or unknown pref = the default (new) icon. */
        fun fromPref(value: String?): AppIconChoice =
            if (value == Classic.prefValue) Classic else Default
    }
}

const val LAUNCHER_ALIAS_DEFAULT = "org.velta.kmp.MainActivityDefault"
const val LAUNCHER_ALIAS_CLASSIC = "org.velta.kmp.MainActivityClassic"

/** The alias that must be enabled, then the one that must be disabled. */
fun launcherAliasState(choice: AppIconChoice): Pair<String, String> = when (choice) {
    AppIconChoice.Default -> LAUNCHER_ALIAS_DEFAULT to LAUNCHER_ALIAS_CLASSIC
    AppIconChoice.Classic -> LAUNCHER_ALIAS_CLASSIC to LAUNCHER_ALIAS_DEFAULT
}
