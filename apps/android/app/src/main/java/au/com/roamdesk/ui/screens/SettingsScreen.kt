package au.com.roamdesk.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.RadioButton
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import au.com.roamdesk.BuildConfig
import au.com.roamdesk.data.Pairing
import au.com.roamdesk.data.UserPrefs
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.ui.AppActions
import au.com.roamdesk.ui.components.ConnectionPill
import java.util.Locale

@Composable
fun SettingsScreen(
    state: DriveUiState,
    pairing: Pairing?,
    batteryExempt: Boolean,
    keepScreenOn: Boolean,
    update: au.com.roamdesk.update.UpdateState,
    actions: AppActions,
) {
    var confirmUnpair by remember { mutableStateOf(false) }
    var showVoices by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(Unit) { actions.loadVoices() }
    if (showVoices) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showVoices = false },
            title = { Text("Choose a voice") },
            text = {
                androidx.compose.foundation.lazy.LazyColumn(Modifier.heightIn(max = 460.dp)) {
                    item { VoiceRow("Automatic", "Best offline Australian voice", state.voiceName == null) { actions.setVoice(null) } }
                    items(state.voices.size) { i ->
                        val v = state.voices[i]
                        VoiceRow(v.label, if (v.online) "Online · sounds better, needs mobile data" else "On the phone", v.name == state.voiceName) {
                            actions.setVoice(v.name)
                        }
                    }
                    if (state.voices.isEmpty()) item {
                        Text("Loading voices…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                    }
                }
            },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { showVoices = false }) { Text("Done") } },
        )
    }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(horizontal = 4.dp))

        Section("App") {
            au.com.roamdesk.ui.components.UpdateSettingsRow(BuildConfig.VERSION_NAME, update, actions)
        }

        Section("Paired PC") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Computer, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Text(state.helperName.ifBlank { "Not paired" }, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                ConnectionPill(state.link, "Online")
            }
            if (state.linkDetail.isNotBlank()) {
                Text(state.linkDetail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            pairing?.let {
                KeyValue("Addresses", it.hosts.joinToString(", ") + " · port ${it.port}")
                KeyValue("Device ID", it.deviceId)
                KeyValue("Helper ID", it.helperId)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = actions::reconnect, enabled = pairing != null) {
                    Icon(Icons.Rounded.Refresh, null); Spacer(Modifier.width(6.dp)); Text("Reconnect")
                }
                Button(
                    onClick = { confirmUnpair = true },
                    enabled = pairing != null,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                ) { Icon(Icons.Rounded.LinkOff, null); Spacer(Modifier.width(6.dp)); Text("Unpair") }
            }
        }

        Section("Voice") {
            var rate by remember(state.speechRate) { mutableFloatStateOf(state.speechRate) }
            Text("Speaking speed  ${String.format(Locale.ROOT, "%.1f", rate)}×", style = MaterialTheme.typography.titleMedium)
            Slider(
                value = rate,
                onValueChange = { rate = (it * 10).toInt() / 10f },
                onValueChangeFinished = { actions.setSpeechRate(rate) },
                valueRange = 0.7f..1.5f,
                steps = 7,
            )
            val current = state.voices.firstOrNull { it.name == state.voiceName }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Voice", style = MaterialTheme.typography.titleMedium)
                    Text(
                        current?.let { it.label + if (it.online) " · online" else "" } ?: "Automatic (best Australian voice)",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedButton(onClick = { showVoices = true }) { Text("Change") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = actions::testVoice) {
                    Icon(Icons.AutoMirrored.Rounded.VolumeUp, null); Spacer(Modifier.width(6.dp)); Text("Test voice")
                }
                androidx.compose.material3.TextButton(onClick = actions::openSpeechSettings) { Text("Get more voices") }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Plain updates", style = MaterialTheme.typography.titleMedium)
                    Text(
                        if (state.plainUpdates) "On. Spoken updates use everyday words, with no file names or code, and your PC doesn't read out each step. Steps still show in the conversation."
                        else "Off. Your PC reads out each step, and Claude may mention file names, commands and tools.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = state.plainUpdates,
                    enabled = state.link == au.com.roamdesk.drive.LinkStatus.Online,
                    onCheckedChange = actions::setPlainUpdates,
                )
            }
        }

        Section("Display") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Keep screen on", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "While Roam Desk is open. Your normal timeout applies when you leave the app.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(checked = keepScreenOn, onCheckedChange = actions::setKeepScreenOn)
            }
        }

        Section("Permissions") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Skip confirmations", style = MaterialTheme.typography.titleMedium)
                    Text(
                        if (state.skipConfirmations) "On. Risky and normally blocked actions run without asking. Credentials, keys and the helper's own files stay off limits. You can turn this off here."
                        else "Off. Risky actions wait for you to say \"confirm …\". For safety, this can only be turned on from the dashboard on your PC.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (state.skipConfirmations) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = state.skipConfirmations,
                    // The phone can only switch it off; turning it on is a PC dashboard job.
                    enabled = state.link == au.com.roamdesk.drive.LinkStatus.Online && state.skipConfirmations,
                    onCheckedChange = { on -> if (!on) actions.setSkipConfirmations(false) },
                )
            }
        }

        Section("Drive session") {
            Text("End automatically after this long idle", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                UserPrefs.IDLE_TIMEOUT_CHOICES.forEach { min ->
                    FilterChip(
                        selected = state.idleTimeoutMin == min,
                        onClick = { actions.setIdleTimeout(min) },
                        label = { Text("$min min") },
                    )
                }
            }
            if (!batteryExempt) {
                Text(
                    "Battery optimisation is on. Samsung may put the app to sleep mid-drive and cut off the Drive session.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                OutlinedButton(onClick = actions::requestBatteryExemption) { Text("Allow unrestricted battery use") }
            }
            Text(
                "While a Drive session is on, voice commands reach your PC. It ends when idle, when you tap End drive, or from the notification.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            "Roam Desk ${BuildConfig.VERSION_NAME}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
        )
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = { Text("Deletes this phone's key for ${state.helperName.ifBlank { "your PC" }}. You'll need a new QR code from the PC to pair again. Held requests are discarded.") },
            confirmButton = {
                Button(
                    onClick = { confirmUnpair = false; actions.unpair() },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("Unpair") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title.uppercase(Locale.ROOT), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            content()
        }
    }
}

@Composable
private fun KeyValue(key: String, value: String) {
    Column {
        Text(key, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(2.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun VoiceRow(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Spacer(Modifier.width(8.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
