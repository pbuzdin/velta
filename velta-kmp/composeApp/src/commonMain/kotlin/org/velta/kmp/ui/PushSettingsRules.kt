package org.velta.kmp.ui

/**
 * Settings › Push notifications (#358 Background delivery, item 4) — a pure
 * port of stable's push-settings.js (#140/#204) over the Android bridge
 * state (stable UnifiedPushBridge.status): installed distributors with app
 * labels, the saved one, an explicit Off, last push time and the
 * registration outcome. PushSettingsRulesTest pins every line.
 */
data class PushApp(val pkg: String, val label: String)

data class PushStatus(
    val distributors: List<PushApp> = emptyList(),
    val saved: String = "",
    val savedLabel: String = "",
    val optedOut: Boolean = false,
    /** Epoch millis of the last push message; 0 = never. */
    val lastPush: Long = 0L,
    /** "ok" | "failed" | "none". */
    val registration: String = "none",
    val registrationError: String = "",
)

/** Platform side (Android: AndroidPushBridge); desktop has none. */
interface PushBridge {
    fun status(): PushStatus
    /** Use this distributor now: save + register, clears Off and a failure. */
    fun select(pkg: String)
    /** Explicit Off: unregister, forget the distributor, remember the choice. */
    fun off()
}

const val PUSH_OFF_VALUE = "__off__"
const val PUSH_APP_URL = "https://ntfy.sh/"

/** stable registration: a failure wins over an older endpoint. */
fun pushRegistration(lastEndpoint: Long, failed: String): String = when {
    failed.isNotEmpty() -> "failed"
    lastEndpoint > 0L -> "ok"
    else -> "none"
}

/** Picker rows: every distributor, then Off; none installed = no picker. */
fun pushOptions(s: PushStatus): List<Pair<String, String>> =
    if (s.distributors.isEmpty()) emptyList()
    else s.distributors.map { it.pkg to it.label } + (PUSH_OFF_VALUE to "Off")

/** Which row is selected: a package, Off, or "" (no picker). */
fun pushSelectedValue(s: PushStatus): String =
    if (s.distributors.isEmpty()) "" else s.saved.ifEmpty { PUSH_OFF_VALUE }

/** One-line state, localized through [t]. */
fun describePushState(s: PushStatus, t: (String) -> String = { it }): String = when {
    s.distributors.isEmpty() -> t("No push app installed — using periodic background checks")
    s.registration == "failed" ->
        if (s.registrationError.isNotEmpty()) t("Registration failed: {reason}").replace("{reason}", s.registrationError)
        else t("Registration failed")
    s.saved.isNotEmpty() -> {
        val app = s.distributors.firstOrNull { it.pkg == s.saved }?.label ?: s.savedLabel.ifEmpty { s.saved }
        t("Using {app}").replace("{app}", app)
    }
    s.optedOut -> t("Off — using periodic background checks")
    else -> t("Off — pick a push app below")
}

/** Relay line from the relays' own supports_push metadata (null = not
 *  known yet). Stable reads the core's registration diagnostics instead. */
fun describeRelaySupport(flags: List<Boolean?>, t: (String) -> String = { it }): String {
    if (flags.isEmpty() || flags.all { it == null }) return t("Relay push support: unknown")
    val ok = flags.count { it == true }
    return when {
        ok == flags.size -> if (flags.size == 1) t("Your relay supports push") else t("All your relays support push")
        ok == 0 -> t("Relay push support not confirmed yet (needs a registered push app)")
        else -> t("{n} of {total} relays support push").replace("{n}", ok.toString()).replace("{total}", flags.size.toString())
    }
}

/** "Last push: 14:05" today, else "Last push: 3 Nov 2026 14:05";
 *  [day] and [hm] format epoch seconds (platform formatters). */
fun describeLastPush(
    tsMillis: Long,
    nowMillis: Long,
    day: (Long) -> String,
    hm: (Long) -> String,
    t: (String) -> String = { it },
): String {
    if (tsMillis <= 0L) return t("No push received yet")
    val ts = tsMillis / 1000
    val sameDay = day(ts) == day(nowMillis / 1000)
    val whenText = if (sameDay) hm(ts) else "${day(ts)} ${hm(ts)}"
    return t("Last push: {when}").replace("{when}", whenText)
}
