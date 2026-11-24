package org.velta.kmp.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.runner.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #507: startup baseline profile. Covers process start + first composition;
 * run on a device with a configured profile to also cover the chat-list
 * first frame. Output: composeApp/src/release/generated/baselineProfiles/.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(
        packageName = "org.velta.kmp",
        includeInStartupProfile = true,
    ) {
        pressHome()
        startActivityAndWait()
    }
}
