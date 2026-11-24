package org.velta.kmp.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.runner.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #507: the two scroll surfaces the issue ranks first (chat list, message
 * history) plus cold startup. On a device with a configured profile the app
 * boots to the chat list; the history benchmark opens the first chat row.
 * On a fresh device the scroll benchmarks still run (over the splash) —
 * sign in first for numbers that mean something.
 */
@RunWith(AndroidJUnit4::class)
class ScrollBenchmarks {

    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun startupCold() = rule.measureRepeated(
        packageName = "org.velta.kmp",
        metrics = listOf(StartupTimingMetric()),
        compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        iterations = 10,
        startupMode = StartupMode.COLD,
    ) {
        pressHome()
        startActivityAndWait()
    }

    @Test
    fun scrollChatList() = rule.measureRepeated(
        packageName = "org.velta.kmp",
        metrics = listOf(FrameTimingMetric()),
        compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        iterations = 5,
        startupMode = StartupMode.WARM,
    ) {
        startActivityAndWait()
        flingVertical(times = 3)
    }

    @Test
    fun scrollMessageHistory() = rule.measureRepeated(
        packageName = "org.velta.kmp",
        metrics = listOf(FrameTimingMetric()),
        compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        iterations = 5,
        startupMode = StartupMode.WARM,
    ) {
        startActivityAndWait()
        // Open the first chat row, then scroll its history both ways.
        device.findObject(By.clickable(true))?.click()
        device.waitForIdle()
        flingVertical(times = 3)
    }

    private fun androidx.benchmark.macro.MacrobenchmarkScope.flingVertical(times: Int) {
        val list = device.findObject(By.scrollable(true)) ?: return
        list.setGestureMargin(device.displayWidth / 5)
        repeat(times) { list.fling(Direction.DOWN); device.waitForIdle() }
        repeat(times) { list.fling(Direction.UP); device.waitForIdle() }
    }
}
