package org.velta.kmp.ui

/**
 * Stable's welcome splash (app/js/app.js showSplash, #334): pure helpers so
 * node-parity behaviour is unit-tested. Automatic relay picking is the
 * core's init_transports (public pool in core/src/autorelay.rs: parallel
 * TCP probes, configure in answer order, skip failures) — the client adds
 * no hostnames of its own.
 */
object Onboarding {
    /** A relay invite link https://<host>/i/<token> (invite-cards.js). */
    data class RelayInvite(val host: String, val token: String)

    data class Creds(val email: String, val password: String)

    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    private val TOKEN = Regex("^[A-Za-z0-9_-]{8,128}$")
    private const val LINK_MAX = 512

    /** invite-cards.js validRelayHost: dotted DNS name, alphabetic TLD. */
    fun validRelayHost(h: String): Boolean {
        if (h.isEmpty() || h.length > 253) return false
        val labels = h.split(".")
        return labels.size >= 2 && labels.all { LABEL.matches(it) } && Regex("^[a-z]{2,63}$").matches(labels.last())
    }

    /** parseRelayInviteInput: scheme optional, http accepted. */
    fun parseRelayInvite(raw: String): RelayInvite? {
        val s = raw.trim().replace(Regex("^https?://", RegexOption.IGNORE_CASE), "")
        val link = "https://$s"
        if (s.isEmpty() || link.length > LINK_MAX) return null
        val m = Regex("^https://([^/?#\\s]+)/i/([^/?#\\s]+)/?$", RegexOption.IGNORE_CASE).find(link) ?: return null
        val host = m.groupValues[1].lowercase().removeSuffix(".")
        val token = m.groupValues[2]
        if (!validRelayHost(host) || !TOKEN.matches(token) || token == "claim") return null
        return RelayInvite(host, token)
    }

    /** app.js normalizeRelayLink: "example.com", "https://example.com",
     * "example.com/new" or a full dcaccount: link → dcaccount:https://<host>/new. */
    fun normalizeRelayLink(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (s.startsWith("dcaccount:", ignoreCase = true)) return s
        s = s.replace(Regex("^https?://", RegexOption.IGNORE_CASE), "").replace(Regex("/.*$"), "").trim()
        if (!Regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}(:\\d+)?$", RegexOption.IGNORE_CASE).matches(s)) return null
        return "dcaccount:https://$s/new"
    }

    fun hostOfLink(link: String): String =
        link.replace(Regex("^dcaccount:https://", RegexOption.IGNORE_CASE), "").replace(Regex("/new.*$"), "")

    /** Core backup QRs are "DCBACKUP" + version digits + ":" (qr.rs). */
    fun isBackupCode(c: String): Boolean = Regex("^dcbackup\\d*:", RegexOption.IGNORE_CASE).containsMatchIn(c.trim())

    /** invite-cards.js relayClaimResult. */
    fun relayClaimResult(status: Int, email: String?, password: String?): Creds {
        if (status == 200 && email != null && password != null && "@" in email && password.isNotEmpty()) {
            return Creds(email, password)
        }
        if (status == 200) throw IllegalStateException(L.t("The relay's answer had no account details. Try again later."))
        val why = when (status) {
            400 -> L.t("The invite link is damaged.")
            403 -> L.t("This invite is not valid. Ask for a new one.")
            404 -> L.t("This relay doesn't accept invites.")
            409 -> L.t("This invite has already been used. Ask for a new one.")
            410 -> L.t("This invite has expired. Ask for a new one.")
            503 -> L.t("The relay can't create accounts right now. Try again later; the invite was not used.")
            else -> L.t("The relay answered with an error ({status}). Try again later.")
                .replace("{status}", if (status > 0) status.toString() else "?")
        }
        throw IllegalStateException(why)
    }

    /** Friendly phase lines on ConfigureProgress (0..1000), per create path. */
    fun phasesForRelay(host: String) = listOf(
        1 to L.t("Relay found at {host}").replace("{host}", host),
        200 to L.t("Requesting new account credentials"),
        450 to L.t("Generating encryption keys"),
        750 to L.t("Finalizing account"),
    )

    fun phasesForInvite(host: String) = listOf(
        1 to L.t("Invite accepted at {host}").replace("{host}", host),
        200 to L.t("Setting up your profile"),
        750 to L.t("Finalizing account"),
    )

    fun phasesForAutopick() = listOf(
        1 to L.t("Found a relay that answers fast"),
        200 to L.t("Requesting new account credentials"),
        450 to L.t("Generating encryption keys"),
        750 to L.t("Finalizing account"),
    )

    /** stable velta-strings.js SUPPRESSED_DEVICE_LABELS. */
    val SUPPRESSED_DEVICE_LABELS = listOf("core-welcome-image")

    /** Splash version line (format.js formatSplashVersion, KMP shell). */
    fun versionLine(app: String, core: String) = "Velta $app (Chatmail core $core, KMP)"
}

/** One line of the splash step list (ul.ob-steps). */
data class ObStep(val text: String, val state: State) {
    enum class State { Active, Done, Failed }
}

/** Plain HTTPS GET → (status, body); the relay invite claim (stable fetches
 * https://<host>/i/claim?t=<token> — GET, fcgiwrap 502s request bodies). */
expect suspend fun httpGetText(url: String): Pair<Int, String>
