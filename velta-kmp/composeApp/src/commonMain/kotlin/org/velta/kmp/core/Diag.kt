package org.velta.kmp.core

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue

/**
 * In-app diagnostics ring buffer (#516): the last [MAX] leveled lines, kept
 * in memory so failures are diagnosable without adb. Every entry is ALSO
 * printed in the historic `velta-kmp: …` stdout format — logcat greps and
 * the documented debugging flows keep working unchanged.
 *
 * commonMain stays java-free, so the wall clock is injected (`ui` wires it
 * to wallClockSeconds() at model init); entries recorded before wiring get
 * timestamp 0 and render without a time.
 */
object Diag {

    data class Entry(val atSeconds: Long, val level: Char, val text: String)

    const val MAX = 300

    var clockSeconds: () -> Long = { 0L }

    private val lock = Any()
    private val ring = ArrayDeque<Entry>(MAX)

    /** Bumped on every entry so an open diagnostics screen recomposes. */
    var version by mutableIntStateOf(0)
        private set

    fun log(text: String, level: Char = 'w') {
        println("velta-kmp: $text")
        synchronized(lock) {
            if (ring.size >= MAX) ring.removeFirst()
            ring.addLast(Entry(clockSeconds(), level, text))
        }
        version++
    }

    /** Failures and suspicious states — the default for the old printlns. */
    fun w(text: String) = log(text, 'w')

    /** Lifecycle milestones worth keeping (connect ok, core restart). */
    fun i(text: String) = log(text, 'i')

    /** Oldest first. */
    fun snapshot(): List<Entry> = synchronized(lock) { ring.toList() }

    fun clear() {
        synchronized(lock) { ring.clear() }
        version++
    }
}
