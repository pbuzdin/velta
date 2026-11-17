package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/**
 * A running webxdc app (P3a). androidMain hosts the archive in a WebView
 * with an injected `window.webxdc` backed by the core RPCs; desktop has no
 * webxdc apps (the desktop client is the web app).
 */
@Composable
expect fun WebxdcScreen(model: AppModel, screen: AppModel.Screen.Webxdc)
