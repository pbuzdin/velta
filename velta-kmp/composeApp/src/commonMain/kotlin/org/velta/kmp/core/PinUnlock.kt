package org.velta.kmp.core

/** Opening an app-lock PIN wrap. Same outcomes as the Tauri `PinOpen`. */
sealed class PinUnlock {
    data class Dek(val hex: String) : PinUnlock()
    data class Wrong(val delaySecs: Long) : PinUnlock()
    data object Corrupt : PinUnlock()
    data object Unsupported : PinUnlock()
}
