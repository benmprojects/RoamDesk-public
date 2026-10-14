package au.com.roamdesk.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.RestartAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.protocol.Session
import au.com.roamdesk.ui.AppActions
import au.com.roamdesk.ui.theme.LocalStateColours

@Composable
fun SessionsScreen(state: DriveUiState, actions: AppActions) {
    var showNew by remember { mutableStateOf(false) }
    var resetTarget by remember { mutableStateOf<Session?>(null) }
    var showContinue by remember { mutableStateOf(false) }
    var releaseTarget by remember { mutableStateOf<Session?>(null) }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Text(
                "Sessions",
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 4.dp),
            )
            Text(
                if (state.driveActive) "Tap to make a session active." else "Start a Drive session to switch, create or reset sessions.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            OutlinedButton(
                onClick = { showContinue = true },
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp).fillMaxWidth(),
            ) {
                Icon(Icons.Rounded.History, null)
                Spacer(Modifier.width(8.dp))
                Text("Continue a session from your PC")
            }
            if (state.sessions.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        if (state.link == au.com.roamdesk.drive.LinkStatus.Online) "No sessions on your PC yet." else "Connect to your PC to see sessions.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    Modifier.weight(1f),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 96.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.sessions, key = { it.id }) { s ->
                        SessionRow(
                            session = s,
                            active = s.id == state.activeSessionId,
                            onSelect = { actions.selectSession(s.id) },
                            onReset = { resetTarget = s },
                            onRelease = if (state.sessions.size > 1 && s.claudeSessionId != null) ({ releaseTarget = s }) else null,
                        )
                    }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { showNew = true },
            icon = { Icon(Icons.Rounded.Add, null) },
            text = { Text("New session") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
        )
    }

    if (showContinue) {
        ContinueSessionSheet(state, actions, onDismiss = { showContinue = false })
    }
    if (showNew) {
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showNew = false },
            title = { Text("New session") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(40) },
                    singleLine = true,
                    label = { Text("Name, e.g. home") },
                )
            },
            confirmButton = {
                Button(onClick = { actions.newSession(name); showNew = false }, enabled = name.isNotBlank()) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { showNew = false }) { Text("Cancel") } },
        )
    }
    releaseTarget?.let { s ->
        AlertDialog(
            onDismissRequest = { releaseTarget = null },
            icon = { Icon(Icons.Rounded.Computer, null) },
            title = { Text("Hand “${s.name}” back to your PC?") },
            text = { Text("The phone lets go of this conversation and it shows as a desktop session again. Open it in Claude on your PC to carry on. You can continue it from the phone again later.") },
            confirmButton = { Button(onClick = { actions.releaseSession(s.id); releaseTarget = null }) { Text("Hand back") } },
            dismissButton = { TextButton(onClick = { releaseTarget = null }) { Text("Cancel") } },
        )
    }
    resetTarget?.let { s ->
        AlertDialog(
            onDismissRequest = { resetTarget = null },
            title = { Text("Reset “${s.name}”?") },
            text = { Text("Starts a fresh conversation in this session. Claude forgets what was said before.") },
            confirmButton = { Button(onClick = { actions.resetSession(s.id); resetTarget = null }) { Text("Reset") } },
            dismissButton = { TextButton(onClick = { resetTarget = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SessionRow(session: Session, active: Boolean, onSelect: () -> Unit, onReset: () -> Unit, onRelease: (() -> Unit)?) {
    val sc = LocalStateColours.current
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = if (active) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surfaceContainer,
        border = if (active) BorderStroke(1.5.dp, MaterialTheme.colorScheme.primary) else null,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onSelect),
    ) {
        Row(Modifier.padding(start = 18.dp, top = 14.dp, bottom = 14.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(session.name.ifBlank { session.id }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (active) {
                        Spacer(Modifier.width(8.dp))
                        Icon(Icons.Rounded.CheckCircle, "Active", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                    }
                }
                val meta = listOf(session.cwd, session.model).filter { it.isNotBlank() }.joinToString(" · ")
                if (meta.isNotBlank()) {
                    Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (session.busy) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.5.dp, color = sc.thinking)
                Spacer(Modifier.width(6.dp))
            }
            if (onRelease != null) IconButton(onClick = onRelease) { Icon(Icons.Rounded.Computer, "Hand back to PC") }
            IconButton(onClick = onReset) { Icon(Icons.Rounded.RestartAlt, "Reset session") }
        }
    }
}
