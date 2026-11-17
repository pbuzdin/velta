package org.velta.kmp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val FAILED = Color(0xFFE0685D)

/**
 * The "Welcome to Velta" splash (#334): port of stable's showSplash
 * (app/js/app.js) and its .splash CSS — 132 px logo, 30 px title, dim
 * tagline, a 420 px action column (Create an account / Add as a second
 * device / Restore from a backup), the create form with the relay field,
 * QR scan, Create account and "Autopick the fastest relay" (core
 * init_transports over its public relay pool), the ob-steps list driven by
 * ConfigureProgress, the version line and the collapsed App log footer.
 */
@Composable
internal fun WelcomeScreen(model: AppModel) {
    val tokens = Velta.tokens
    PlatformBackHandler(enabled = model.welcomeMode != AppModel.WelcomeMode.Actions && !model.obBusy) {
        model.welcomeShowActions()
    }
    Column(Modifier.fillMaxSize().background(tokens.bg).windowInsetsPadding(WindowInsets.systemBars)) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val minH = maxHeight
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = minH)
                    .padding(start = 24.dp, end = 24.dp, top = 32.dp, bottom = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                VeltaLogomark(
                    model.appIconChoice,
                    modifier = Modifier.size(132.dp),
                    contentDescription = L.t("Velta logo"),
                )
                Spacer(Modifier.size(18.dp))
                Text(
                    L.t("Welcome to Velta"),
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                    color = tokens.text,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.size(10.dp))
                Text(
                    L.t("End-to-end encrypted messaging built on Delta Chat — no phone number, no central server. Pick how to set up your profile:"),
                    fontSize = 14.5.sp,
                    lineHeight = (14.5 * 1.55).sp,
                    color = tokens.textDim,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.widthIn(max = 420.dp),
                )
                Spacer(Modifier.size(26.dp))
                Column(
                    Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    if (!model.connected) {
                        // Boot surface: actions wait for the core.
                        StepList(listOf(ObStep(L.t("Connecting to the encryption core…"), ObStep.State.Active)))
                    } else {
                        when (model.welcomeMode) {
                            AppModel.WelcomeMode.Actions -> if (!model.obBusy) ActionButtons(model)
                            AppModel.WelcomeMode.Create -> CreateForm(model)
                            AppModel.WelcomeMode.SecondDevice -> SecondDeviceForm(model)
                        }
                    }
                    model.welcomeNotice?.let {
                        Text(it, color = FAILED, fontSize = 13.5.sp, textAlign = TextAlign.Center)
                    }
                }
                if (model.connected && model.obSteps.isNotEmpty()) {
                    Spacer(Modifier.size(14.dp))
                    StepList(model.obSteps)
                }
            }
        }
        Text(
            Onboarding.versionLine(model.appVersion, model.coreVersion),
            fontSize = 12.sp,
            lineHeight = (12 * 1.4).sp,
            color = tokens.textDim,
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 6.dp),
        )
        AppLogFooter(model)
    }
    if (model.askNickname) NicknameDialog(model)
}

@Composable
private fun PrimaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    val tokens = Velta.tokens
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        contentPadding = PaddingValues(horizontal = 22.dp, vertical = 11.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = tokens.accent,
            contentColor = tokens.onAccent,
            disabledContainerColor = tokens.accent.copy(alpha = 0.5f),
            disabledContentColor = tokens.onAccent,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun SplashTextButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    val tokens = Velta.tokens
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        colors = ButtonDefaults.textButtonColors(
            contentColor = tokens.accentText,
            disabledContentColor = tokens.accentText.copy(alpha = 0.55f),
        ),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun ActionButtons(model: AppModel) {
    PrimaryButton(L.t("Create an account")) { model.welcomeShowCreate() }
    SplashTextButton(L.t("Add as a second device…")) { model.welcomeShowSecondDevice() }
    if (model.backupPicker != null) {
        SplashTextButton(L.t("Restore from a backup…")) { model.welcomeRestore() }
    }
}

/** "<b>…</b>" in the stable hint strings → bold spans. */
private fun boldTags(s: String): AnnotatedString = buildAnnotatedString {
    var rest = s
    while (true) {
        val a = rest.indexOf("<b>")
        val b = rest.indexOf("</b>")
        if (a < 0 || b < a) {
            append(rest)
            break
        }
        append(rest.substring(0, a))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(rest.substring(a + 3, b)) }
        rest = rest.substring(b + 4)
    }
}

@Composable
private fun CreateForm(model: AppModel) {
    val tokens = Velta.tokens
    Text(
        boldTags(L.t("Enter a <b>chatmail</b> relay address — an instant end-to-end encrypted profile will be created for you. No email or password needed.")),
        fontSize = 14.5.sp,
        lineHeight = (14.5 * 1.5).sp,
        color = tokens.text,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(bottom = 4.dp),
    )
    OutlinedTextField(
        value = model.relayInput,
        onValueChange = {
            model.relayInput = it
            model.welcomeNotice = null
        },
        placeholder = { Text(L.t("Relay address — e.g. nine.testrun.org")) },
        singleLine = true,
        enabled = !model.obBusy,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
    if (model.requestQrScan != null) {
        SplashTextButton(L.t("Scan a QR code"), enabled = !model.obBusy) { model.requestQrScan?.invoke() }
    }
    val okLabel = when {
        model.obBusy && model.obTrigger == "ok" -> L.t("Creating…")
        model.obFailed && model.obTrigger == "ok" -> L.t("Retry")
        else -> L.t("Create account")
    }
    PrimaryButton(okLabel, enabled = !model.obBusy) { model.welcomeSubmit() }
    val autoLabel = when {
        model.obBusy && model.obTrigger == "auto" -> L.t("Creating…")
        model.obFailed && model.obTrigger == "auto" -> L.t("Retry")
        else -> L.t("Autopick the fastest relay")
    }
    SplashTextButton(autoLabel, enabled = !model.obBusy) { model.welcomeAutopick() }
}

@Composable
private fun SecondDeviceForm(model: AppModel) {
    val tokens = Velta.tokens
    Text(L.t("Receive a profile"), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = tokens.text)
    Text(
        L.t("Scan or paste the code shown on the other device (DCBACKUP2:…). A copy of that profile is created here; the other device stays signed in."),
        fontSize = 14.5.sp,
        lineHeight = (14.5 * 1.5).sp,
        color = tokens.textDim,
        textAlign = TextAlign.Center,
    )
    OutlinedTextField(
        value = model.backupInput,
        onValueChange = {
            model.backupInput = it
            model.welcomeNotice = null
        },
        placeholder = { Text("DCBACKUP2:…") },
        singleLine = true,
        enabled = !model.obBusy,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
    if (model.requestQrScan != null) {
        SplashTextButton(L.t("Scan a QR code"), enabled = !model.obBusy) { model.requestQrScan?.invoke() }
    }
    PrimaryButton(if (model.obFailed) L.t("Retry") else L.t("Continue"), enabled = !model.obBusy) { model.welcomeReceive() }
}

/** ul.ob-steps, splash variant: icon stacked above its text, centered. */
@Composable
private fun StepList(steps: List<ObStep>) {
    val tokens = Velta.tokens
    Column(
        Modifier.widthIn(max = 420.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        for (step in steps) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (step.state) {
                    ObStep.State.Active -> CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = tokens.accent,
                    )
                    ObStep.State.Done -> Box(
                        Modifier.size(18.dp).background(tokens.accent, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Text("✓", fontSize = 11.sp, color = tokens.onAccent) }
                    ObStep.State.Failed -> Box(
                        Modifier.size(18.dp).background(FAILED, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Text("✕", fontSize = 10.sp, color = Color(0xFFF4F4F4)) }
                }
                Text(
                    step.text,
                    fontSize = 13.5.sp,
                    textAlign = TextAlign.Center,
                    color = when (step.state) {
                        ObStep.State.Active -> tokens.text
                        ObStep.State.Done -> tokens.textDim
                        ObStep.State.Failed -> FAILED
                    },
                )
            }
        }
    }
}

/** Collapsed "App log — errors & debug" footer (stable details.splash-log). */
@Composable
private fun AppLogFooter(model: AppModel) {
    val tokens = Velta.tokens
    var open by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier
            .fillMaxWidth()
            .background(tokens.bgSidebar)
            .border(width = 1.dp, color = tokens.border, shape = RoundedCornerShape(0.dp)),
    ) {
        Text(
            L.t("App log ({n}) — errors & debug").replace("{n}", model.appLog.size.toString()),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            color = tokens.textDim,
            modifier = Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = 16.dp, vertical = 10.dp),
        )
        if (open) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = {
                    clipboard.setText(AnnotatedString(model.appLog.joinToString("\n")))
                    model.welcomeNotice = L.t("Log copied")
                }) { Text(L.t("Copy log"), color = tokens.accentText, fontWeight = FontWeight.SemiBold) }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 14.dp),
            ) {
                Text(
                    model.appLog.joinToString("\n"),
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = tokens.textDim,
                )
            }
        }
    }
}

/** Issue #6: once the account exists, offer a nickname — skippable. */
@Composable
private fun NicknameDialog(model: AppModel) {
    AlertDialog(
        onDismissRequest = { model.finishNickname(false) },
        title = { Text(L.t("Welcome to Velta")) },
        text = {
            OutlinedTextField(
                value = model.nicknameInput,
                onValueChange = { if (it.length <= 64) model.nicknameInput = it },
                placeholder = { Text(L.t("How should we call you?")) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = { TextButton(onClick = { model.finishNickname(true) }) { Text(L.t("Save name")) } },
        dismissButton = { TextButton(onClick = { model.finishNickname(false) }) { Text(L.t("Skip")) } },
    )
}

/** "Account created on {host}" — stable's 3 s toast after onboarding. */
@Composable
internal fun CreatedNotice(model: AppModel) {
    val text = model.createdNotice ?: return
    val tokens = Velta.tokens
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(3000)
        model.createdNotice = null
    }
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars).padding(bottom = 88.dp), contentAlignment = Alignment.BottomCenter) {
        Text(
            text,
            color = tokens.text,
            fontSize = 14.sp,
            modifier = Modifier
                .background(tokens.bgElev, RoundedCornerShape(10.dp))
                .padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}
