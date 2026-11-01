package org.velta.kmp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.velta.kmp.ui.App
import org.velta.kmp.ui.AppModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val model = AppModel(
            AndroidCorePlatform(applicationContext),
            CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
        setContent {
            App(model)
            androidx.compose.runtime.LaunchedEffect(Unit) { model.connect() }
        }
    }
}
