package au.com.roamdesk.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.DrivePhase
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.drive.LinkStatus
import au.com.roamdesk.ui.AppActions
import au.com.roamdesk.ui.components.ConnectionPill
import au.com.roamdesk.ui.components.SessionChip
import au.com.roamdesk.ui.components.StateRing
import au.com.roamdesk.ui.components.StopEverythingButton
import au.com.roamdesk.ui.theme.LocalStateColours

/** Glanceable: ring, one line of context, a big Talk button and Stop everything. Nothing to read while moving. */
@Composable
fun DriveScreen(state: DriveUiState, actions: AppActions, onOpenSessions: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            SessionChip(
                name = state.activeSession?.name,
                busy = state.pcBusy,
                onClick = onOpenSessions,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.weight(1f).width(8.dp))
            ConnectionPill(state.link, state.helperName)
        }

        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                StateRing(state.phase)
                Spacer(Modifier.height(16.dp))
                ContextLine(state)
            }
        }

        if (state.offlineQueued > 0) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 10.dp)) {
                Icon(Icons.Rounded.Schedule, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                Text(
                    "${state.offlineQueued} held until your PC is back",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (state.driveActive) {
            TalkButton(state.phase, onClick = actions::talk)
            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.LockOpen, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "Unlocked · ends after ${state.idleTimeoutMin} min idle",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row {
                    if (state.phase == DrivePhase.Thinking && state.link == LinkStatus.Online) {
                        TextButton(onClick = actions::cancelTurn) { Text("Cancel task") }
                    }
                    TextButton(onClick = actions::endDrive) { Text("End drive") }
                }
            }
        } else {
            Button(
                onClick = actions::startDrive,
                enabled = state.paired,
                modifier = Modifier.fillMaxWidth().height(88.dp),
                shape = RoundedCornerShape(28.dp),
            ) {
                Icon(Icons.Rounded.Lock, null, Modifier.size(26.dp))
                Spacer(Modifier.width(12.dp))
                Text("Start Drive session", style = MaterialTheme.typography.titleLarge)
            }
            Text(
                "Unlock with your fingerprint, face or PIN. Commands only go to your PC during a Drive session.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
            )
        }
        Spacer(Modifier.height(12.dp))
        StopEverythingButton(onKill = actions::kill)
    }
}

@Composable
private fun ContextLine(state: DriveUiState) {
    val (text, emphasise) = when {
        state.phase == DrivePhase.Listening -> (state.partialTranscript.ifBlank { "Go ahead…" }) to true
        state.queueQuestion != null -> "Still want me to: ${state.queueQuestion}?" to true
        state.phase == DrivePhase.Thinking && state.progressLabel != null -> state.progressLabel to false
        state.phase == DrivePhase.Offline && state.link != LinkStatus.Online -> state.linkDetail to false
        state.lastReply.isNotBlank() -> state.lastReply to false
        state.driveActive -> "Press your steering-wheel button or Talk." to false
        else -> "" to false
    }
    AnimatedVisibility(text.isNotBlank(), enter = fadeIn(), exit = fadeOut()) {
        Text(
            text,
            style = if (emphasise) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.titleMedium,
            color = if (emphasise) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 12.dp).heightIn(min = 56.dp),
        )
    }
}

@Composable
private fun TalkButton(phase: DrivePhase, onClick: () -> Unit) {
    val sc = LocalStateColours.current
    val listening = phase == DrivePhase.Listening
    val speaking = phase == DrivePhase.Speaking
    val container = if (listening) sc.listening else MaterialTheme.colorScheme.primary
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().height(96.dp),
        shape = RoundedCornerShape(32.dp),
        colors = ButtonDefaults.buttonColors(containerColor = container),
    ) {
        Icon(if (listening) Icons.Rounded.Stop else Icons.Rounded.Mic, null, Modifier.size(34.dp))
        Spacer(Modifier.width(12.dp))
        Text(
            when {
                listening -> "Done"
                speaking -> "Interrupt & talk"
                else -> "Talk"
            },
            style = MaterialTheme.typography.headlineSmall,
        )
    }
}
