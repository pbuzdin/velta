package org.velta.kmp.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.velta.kmp.AndroidCorePlatform
import org.velta.kmp.ui.BACKGROUND_CONNECTION_KEY
import org.velta.kmp.ui.BOOT_ACTIONS
import org.velta.kmp.ui.backgroundConnectionOn
import org.velta.kmp.ui.bootStartsSync

/**
 * Boot / app update (#358 Background delivery, item 2; stable
 * ScheduledAlarmReceiver's boot branch): nothing else brings background
 * delivery back until the app is opened. Re-arms the periodic catch-up and
 * starts the sync service (allowed from these broadcasts; remoteMessaging
 * is not on Android 15's boot-start deny list), which builds a headless
 * model and core.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action !in BOOT_ACTIONS) return
        BackgroundFetchJob.schedule(context)
        val platform = AndroidCorePlatform(context.applicationContext)
        val bg = backgroundConnectionOn(platform.pref(BACKGROUND_CONNECTION_KEY))
        if (bootStartsSync(action, platform.isAppLocked(), bg)) {
            Log.d(TAG, "$action: starting background sync")
            VeltaForegroundService.start(context)
        } else {
            Log.d(TAG, "$action: background connection off or app lock on, no sync")
        }
    }

    private companion object {
        const val TAG = "BootReceiver"
    }
}
