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
                val appContext = context.applicationContext
                // Calls (P1b): WebRTC media + audio routing + mic FGS.
                created.callMedia = org.velta.kmp.calls.CallMediaAndroid(
                    appContext,
                    iceServers = { created.callIceServers() },
                    micPermission = { created.callMicPermission?.invoke() ?: true },
                )
                created.callSpeakerToggle = { org.velta.kmp.calls.CallAudioManager.toggleSpeaker(appContext) }
                created.callAudioStart = { org.velta.kmp.calls.CallAudioManager.start(appContext) }
                created.callAudioStop = { org.velta.kmp.calls.CallAudioManager.stop(appContext) }
                created.callForeground = { on, video ->
                    if (on) org.velta.kmp.calls.CallForegroundService.start(appContext, video)
                    else org.velta.kmp.calls.CallForegroundService.stop(appContext)
                }
                org.velta.kmp.calls.CallNotifications.register(appContext)
                created.callNotifyIncoming = { name ->
                    org.velta.kmp.calls.CallNotifications.showIncoming(appContext, name)
                }
                created.callNotifyIncomingCancel = {
                    org.velta.kmp.calls.CallNotifications.cancel(appContext)
                }
                created.callCameraPermission = { created.cameraPermissionHook?.invoke() ?: true }
                model = created
            }
        }
}
