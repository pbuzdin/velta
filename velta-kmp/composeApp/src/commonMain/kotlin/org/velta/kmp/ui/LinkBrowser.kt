package org.velta.kmp.ui

/**
 * Which package hosts the in-app tab (stable InAppBrowser.open).
 * The user's default browser wins when it offers Custom Tabs. Otherwise
 * the first discovered service. Otherwise the candidate probe.
 * Package-manager order is not a preference: Chrome Dev used to beat
 * the default browser just by sorting first.
 */
fun pickCustomTabProvider(
    defaultBrowser: String?,
    servicePackages: List<String>,
    candidate: String?,
): String? = when {
    defaultBrowser != null && defaultBrowser in servicePackages -> defaultBrowser
    servicePackages.isNotEmpty() -> servicePackages.first()
    else -> candidate
}
