package au.com.roamdesk.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import au.com.roamdesk.ui.AppActions
import au.com.roamdesk.update.UpdateState

/** Shown above every tab while an update from the PC is available, downloading or ready to install. */
@Composable
fun UpdateBanner(state: UpdateState, actions: AppActions) {
    val text = when (state) {
        is UpdateState.Available -> "Update available (${state.versionName})"
        is UpdateState.Downloading -> "Downloading update…"
        is UpdateState.Ready -> "Update ready to install"
        else -> return
    }
    Surface(color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.SystemUpdate, null, Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                when (state) {
                    is UpdateState.Available -> {
                        TextButton(onClick = actions::dismissUpdate) { Text("Later") }
                        Button(onClick = actions::downloadUpdate) { Text("Update") }
                    }
                    is UpdateState.Ready -> Button(onClick = actions::installUpdate) { Text("Install") }
                    else -> Unit
                }
            }
            if (state is UpdateState.Downloading) {
                if (state.total > 0) LinearProgressIndicator(progress = { (state.bytes.toFloat() / state.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                else LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

/** Settings row: current version, status and the matching action. */
@Composable
fun UpdateSettingsRow(currentVersion: String, state: UpdateState, actions: AppActions) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Version $currentVersion", style = MaterialTheme.typography.titleMedium)
        if (!au.com.roamdesk.BuildConfig.SELF_UPDATE) {
            Text("Updates for this app come through Google Play.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val status = if (!au.com.roamdesk.BuildConfig.SELF_UPDATE) null else when (state) {
            UpdateState.UpToDate -> "Up to date with your PC."
            UpdateState.Checking -> "Checking…"
            is UpdateState.Available -> "Version ${state.versionName} is available."
            is UpdateState.Downloading -> "Downloading…"
            is UpdateState.Ready -> "Version ${state.versionName} is ready to install."
            is UpdateState.Failed -> state.message
        }
        if (status != null) {
            Text(
                status,
                style = MaterialTheme.typography.bodyMedium,
                color = if (state is UpdateState.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                when (state) {
                    is UpdateState.Available -> Button(onClick = actions::downloadUpdate) { Text("Update") }
                    is UpdateState.Ready -> Button(onClick = actions::installUpdate) { Text("Install") }
                    else -> Unit
                }
                OutlinedButton(onClick = actions::checkForUpdate, enabled = state !is UpdateState.Downloading) { Text("Check for updates") }
            }
        }
        Text("PC helper", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
        Text(
            "Rebuilds the helper on your PC from its latest code and restarts it. Takes about a minute; the app reconnects by itself.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(onClick = actions::updateHelper) { Text("Update PC helper") }
    }
}
