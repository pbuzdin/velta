package org.velta.kmp.ui

/**
 * Webxdc app isolation rules (platform-free, unit-tested in desktopTest).
 *
 * Every app instance loads from its own origin, `https://a<account>m<msg>.xdc.local/`,
 * so localStorage, IndexedDB and cookies of one app are not visible to another
 * (account ids repeat message ids, so both are part of the host). The host is
 * served only by the request interceptor; nothing resolves it on the network.
 */
internal const val WEBXDC_HOST_SUFFIX = "xdc.local"

internal fun webxdcHost(accountId: Long, msgId: Long): String = "a${accountId}m${msgId}.$WEBXDC_HOST_SUFFIX"

internal fun webxdcOrigin(accountId: Long, msgId: Long): String = "https://${webxdcHost(accountId, msgId)}/"

/**
 * Policy sent with every served response: the app and its own files, inline
 * script/style (bundled apps rely on them), data:/blob: media, and no
 * connection to any other host (fetch, XHR, WebSocket, frames, forms).
 */
internal const val WEBXDC_CSP =
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "connect-src 'self' data: blob:; frame-src 'self'; form-action 'none'; base-uri 'self'"

/** True when this request may be served or loaded. Everything else is refused. */
internal fun webxdcRequestAllowed(scheme: String?, host: String?, expectedHost: String): Boolean =
    (scheme.equals("https", ignoreCase = true) && host.equals(expectedHost, ignoreCase = true)) ||
        scheme.equals("data", ignoreCase = true) ||
        scheme.equals("blob", ignoreCase = true) ||
        scheme.equals("about", ignoreCase = true)

/** Path inside the archive for a request on the app's own host. */
internal fun webxdcArchivePath(segments: List<String>): String =
    segments.joinToString("/").ifEmpty { "index.html" }

/**
 * A link tap the app may hand to the system chooser: a user gesture on an
 * http(s) URL. Scripts, redirects and every other scheme (intent:, file:,
 * content:, tel:, …) never leave the app.
 */
internal fun webxdcLinkLeaves(scheme: String?, userGesture: Boolean): Boolean =
    htmlLinkLeavesViewer(scheme, userGesture)
