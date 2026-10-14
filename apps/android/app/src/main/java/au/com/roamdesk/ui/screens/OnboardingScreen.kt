package au.com.roamdesk.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material.icons.rounded.BatteryChargingFull
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.DirectionsCar
import androidx.compose.material.icons.rounded.RecordVoiceOver
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.DrivePhase
import au.com.roamdesk.pairing.PairResult
import au.com.roamdesk.ui.AppActions
import au.com.roamdesk.ui.PermissionState
import au.com.roamdesk.ui.components.StateRing
import kotlinx.coroutines.launch

enum class OnboardingStep { Welcome, Pair, Permissions }

/** First launch: explain → pair → permissions. After an unpair it starts at Pair. */
@Composable
fun OnboardingScreen(
    startAt: OnboardingStep,
    paired: Boolean,
    permissions: PermissionState,
    actions: AppActions,
) {
    var step by rememberSaveable { mutableStateOf(startAt) }
    AnimatedContent(step, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "onboarding") { s ->
        Column(
            Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 28.dp),
        ) {
            when (s) {
                OnboardingStep.Welcome -> Welcome { step = OnboardingStep.Pair }
                OnboardingStep.Pair -> PairStep(paired, actions) { step = OnboardingStep.Permissions }
                OnboardingStep.Permissions -> PermissionsStep(permissions, actions)
            }
        }
    }
}

@Composable
private fun Welcome(onNext: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(12.dp))
        StateRing(DrivePhase.Idle, size = 180.dp)
        Spacer(Modifier.height(20.dp))
        Text("Roam Desk", style = MaterialTheme.typography.displayMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "Talk to Claude on your PC, hands-free, while you drive.",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    Spacer(Modifier.height(28.dp))
    Feature(Icons.Rounded.DirectionsCar, "Press to talk", "Use your steering-wheel or headset button, or the big Talk button.")
    Feature(Icons.Rounded.RecordVoiceOver, "Short spoken replies", "Claude works on your PC and tells you what it's doing.")
    Feature(Icons.Rounded.Security, "You stay in charge", "Risky actions need a spoken confirmation phrase. Stop everything is always one press away.")
    Spacer(Modifier.height(28.dp))
    Button(onClick = onNext, modifier = Modifier.fillMaxWidth().height(64.dp), shape = RoundedCornerShape(22.dp)) {
        Text("Pair with my PC", style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun Feature(icon: ImageVector, title: String, body: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(16.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PairStep(paired: Boolean, actions: AppActions, onNext: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var success by remember { mutableStateOf<String?>(null) }
    var showPaste by rememberSaveable { mutableStateOf(false) }
    var pasted by rememberSaveable { mutableStateOf("") }

    fun runPair(json: String) {
        busy = true; error = null
        scope.launch {
            when (val r = actions.pair(json)) {
                is PairResult.Success -> success = r.helperName
                is PairResult.Failure -> error = r.message
            }
            busy = false
        }
    }

    Text("Pair with your PC", style = MaterialTheme.typography.headlineLarge)
    Spacer(Modifier.height(10.dp))
    Text(
        "On your PC, open the Roam Desk helper dashboard (http://127.0.0.1:8787) and scan the QR code it shows. " +
            "Both devices need Tailscale switched on.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(24.dp))

    if (success != null || (paired && !busy && error == null && success == null && !showPaste)) {
        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.CheckCircle, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(32.dp))
                Spacer(Modifier.width(14.dp))
                Text("Paired with ${success ?: "your PC"}", style = MaterialTheme.typography.titleLarge)
            }
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = onNext, modifier = Modifier.fillMaxWidth().height(64.dp), shape = RoundedCornerShape(22.dp)) {
            Text("Continue", style = MaterialTheme.typography.titleMedium)
        }
        return
    }

    Button(
        onClick = {
            error = null
            scope.launch {
                val text = runCatching { actions.scanQr() }.getOrElse {
                    error = "The scanner couldn't start: ${it.message ?: "Google Play services error"}. Paste the pairing text instead."
                    null
                }
                if (text != null) runPair(text)
            }
        },
        enabled = !busy,
        modifier = Modifier.fillMaxWidth().height(72.dp),
        shape = RoundedCornerShape(24.dp),
    ) {
        Icon(Icons.Rounded.QrCodeScanner, null, Modifier.size(28.dp))
        Spacer(Modifier.width(12.dp))
        Text("Scan QR code", style = MaterialTheme.typography.titleLarge)
    }
    Spacer(Modifier.height(12.dp))
    OutlinedButton(
        onClick = { showPaste = !showPaste },
        enabled = !busy,
        modifier = Modifier.fillMaxWidth().height(56.dp),
        shape = RoundedCornerShape(20.dp),
    ) {
        Icon(Icons.Rounded.ContentPaste, null)
        Spacer(Modifier.width(10.dp))
        Text("Paste pairing text instead")
    }
    if (showPaste) {
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = pasted,
            onValueChange = { pasted = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            placeholder = { Text("{\"v\":1,\"kind\":\"claude-anywhere-pair\", …}") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        )
        Spacer(Modifier.height(8.dp))
        Button(onClick = { runPair(pasted) }, enabled = !busy && pasted.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            Text("Pair")
        }
    }
    if (busy) {
        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 3.dp)
            Spacer(Modifier.width(12.dp))
            Text("Contacting your PC…", style = MaterialTheme.typography.bodyLarge)
        }
    }
    error?.let {
        Spacer(Modifier.height(20.dp))
        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
            Text(it, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(16.dp))
        }
    }
}

@Composable
private fun PermissionsStep(permissions: PermissionState, actions: AppActions) {
    Text("Permissions", style = MaterialTheme.typography.headlineLarge)
    Spacer(Modifier.height(10.dp))
    Text(
        "Android will ask for these next.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(16.dp))
    PermissionRow(Icons.Rounded.Mic, "Microphone", "Only opens when you press Talk or a confirmation is being asked. Speech is recognised on the phone.", permissions.mic)
    PermissionRow(Icons.Rounded.Notifications, "Notifications", "Shows the Drive session with Talk and Stop buttons, and keeps it running with the screen off.", permissions.notifications)
    PermissionRow(
        Icons.Rounded.BatteryChargingFull, "Keep running in the car",
        "Samsung and other phones put apps to sleep to save battery, which can cut off a Drive session. Allow Roam Desk to run unrestricted. The mic still only opens when you press Talk.",
        permissions.batteryExempt,
    )
    if (!permissions.batteryExempt) {
        OutlinedButton(onClick = actions::requestBatteryExemption, modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
            Text("Allow unrestricted battery use")
        }
    }
    Spacer(Modifier.height(28.dp))
    val allGranted = permissions.mic && permissions.notifications
    if (!allGranted) {
        Button(onClick = actions::requestPermissions, modifier = Modifier.fillMaxWidth().height(64.dp), shape = RoundedCornerShape(22.dp)) {
            Text("Allow", style = MaterialTheme.typography.titleMedium)
        }
        TextButton(onClick = actions::finishOnboarding, modifier = Modifier.fillMaxWidth()) { Text("Not now") }
    } else {
        Button(onClick = actions::finishOnboarding, modifier = Modifier.fillMaxWidth().height(64.dp), shape = RoundedCornerShape(22.dp)) {
            Text("Done", style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
private fun PermissionRow(icon: ImageVector, title: String, body: String, granted: Boolean) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(Modifier.padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (granted) Icon(Icons.Rounded.CheckCircle, "Allowed", tint = MaterialTheme.colorScheme.primary)
        }
    }
}
