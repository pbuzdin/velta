package org.velta.kmp.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * Isolated mail HTML. Not the webxdc WebView: no JS bridge, and the page
 * cannot reach the app or the network. JS stays off (stricter than the web
 * iframe's allow-scripts); the CSP is the same block on remote images.
 * [HTML_VIEW_ORIGIN] is not a host this app uses, so the process-wide
 * cookie jar does not share the mail with anything else.
 */
internal const val HTML_VIEW_ORIGIN = "https://html-view.invalid/"

internal const val HTML_VIEW_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;"

/** True when this subresource may load. Everything else is refused. */
internal fun htmlSubresourceAllowed(scheme: String?, host: String?): Boolean =
    host.equals("html-view.invalid", ignoreCase = true) ||
        scheme.equals("data", ignoreCase = true) ||
        scheme.equals("about", ignoreCase = true)

/** A user click on http(s) leaves the viewer. A script or meta refresh does not. */
internal fun htmlLinkLeavesViewer(scheme: String?, userGesture: Boolean): Boolean =
    userGesture && (scheme.equals("http", ignoreCase = true) || scheme.equals("https", ignoreCase = true))

/** Color-scheme, system font, and CSP, inserted where the web overlay inserts them. */
internal fun prepareHtmlView(html: String, dark: Boolean): String {
    val scheme = if (dark) "dark" else "light"
    val inject = """<meta http-equiv="Content-Security-Policy" content="$HTML_VIEW_CSP">""" +
        """<style>html{color-scheme:$scheme}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}</style>"""
    val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
        ?: Regex("<html[^>]*>", RegexOption.IGNORE_CASE).find(html)
    return if (head != null) {
        html.substring(0, head.range.last + 1) + inject + html.substring(head.range.last + 1)
    } else {
        inject + html
    }
}

@Composable
internal expect fun HtmlBody(model: AppModel, screen: AppModel.Screen.Html, modifier: Modifier)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HtmlScreen(model: AppModel, screen: AppModel.Screen.Html) {
    PlatformBackHandler { model.closeHtml() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(screen.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    TextButton(onClick = { model.closeHtml() }) {
                        Icon(
                            VeltaIcons.chevronLeft,
                            contentDescription = L.t("Back"),
                            modifier = Modifier.size(26.dp),
                            tint = Velta.tokens.textDim,
                        )
                    }
                },
            )
        },
    ) { inner ->
        HtmlBody(model, screen, Modifier.padding(inner).fillMaxSize())
    }
}
