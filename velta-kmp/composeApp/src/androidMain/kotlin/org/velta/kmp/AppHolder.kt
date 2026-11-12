package org.velta.kmp

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.velta.kmp.core.AndroidIncomingNotifier
import org.velta.kmp.ui.AppModel

/**
 * Process-wide AppModel holder. The UI and the foreground service share ONE
 * model — one core, one event loop, one source of truth. When the system
 * kills the process, the sticky service restarts into a fresh process and
 * [obtain] + [AppModel.connect] rebuild the shim, client and event loop
 * without the UI ever being involved.
 */
object AppHolder {

    @Volatile
    private var model: AppModel? = null

    fun obtain(context: Context): AppModel =
        model ?: synchronized(this) {
            model ?: AppModel(
                AndroidCorePlatform(context.applicationContext),
                CoroutineScope(SupervisorJob() + Dispatchers.Default),
            ).also { created ->
                created.notifier = AndroidIncomingNotifier(context.applicationContext)
                model = created
            }
        }
}
