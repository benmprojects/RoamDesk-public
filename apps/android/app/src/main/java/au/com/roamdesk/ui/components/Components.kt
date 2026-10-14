package au.com.roamdesk.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.LinkStatus
import au.com.roamdesk.drive.PendingConfirm
import au.com.roamdesk.ui.theme.LocalStateColours
import kotlinx.coroutines.delay

@Composable
fun ConnectionPill(link: LinkStatus, helperName: String, modifier: Modifier = Modifier) {
    val sc = LocalStateColours.current
    val (dot, text) = when (link) {
        LinkStatus.Online -> sc.speaking to (helperName.ifBlank { "PC" })
        LinkStatus.Connecting -> sc.confirming to "Connecting…"
        LinkStatus.Offline -> sc.offline to "Offline"
        LinkStatus.Rejected -> sc.danger to "Rejected"
        LinkStatus.NotPaired -> sc.offline to "Not paired"
    }
    Row(
        modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun SessionChip(name: String?, busy: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .clip(CircleShape)
            .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.Folder, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Text(
            name ?: "No session",
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (busy) {
            Spacer(Modifier.width(8.dp))
            Box(Modifier.size(8.dp).clip(CircleShape).background(LocalStateColours.current.thinking))
        }
    }
}

/**
 * Stop everything: hold for ~0.8 s to send straight away, or tap for a confirm dialog.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun StopEverythingButton(onKill: () -> Unit, modifier: Modifier = Modifier) {
    val danger = LocalStateColours.current.danger
    val haptics = LocalHapticFeedback.current
    var ask by remember { mutableStateOf(false) }
    Surface(
        color = danger.copy(alpha = 0.14f),
        contentColor = danger,
        shape = RoundedCornerShape(20.dp),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(RoundedCornerShape(20.dp))
            .border(1.5.dp, danger.copy(alpha = 0.7f), RoundedCornerShape(20.dp))
            .combinedClickable(
                role = Role.Button,
                onClickLabel = "Stop everything",
                onLongClickLabel = "Stop everything now",
                onClick = { ask = true },
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onKill()
                },
            ),
    ) {
        Row(
            Modifier.padding(horizontal = 20.dp, vertical = 18.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.StopCircle, null, Modifier.size(28.dp))
            Spacer(Modifier.width(10.dp))
            Text("Stop everything", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(10.dp))
            Text("hold", style = MaterialTheme.typography.labelLarge, color = danger.copy(alpha = 0.7f))
        }
    }
    if (ask) {
        AlertDialog(
            onDismissRequest = { ask = false },
            icon = { Icon(Icons.Rounded.StopCircle, null, tint = danger) },
            title = { Text("Stop everything?") },
            text = { Text("Stops every running task on your PC and cancels any pending approvals.") },
            confirmButton = {
                Button(
                    onClick = { ask = false; onKill() },
                    colors = ButtonDefaults.buttonColors(containerColor = danger, contentColor = Color.White),
                ) { Text("Stop everything") }
            },
            dismissButton = { TextButton(onClick = { ask = false }) { Text("Keep running") } },
        )
    }
}

/** Large approval card for when parked. Confirm is disabled until a Drive session is unlocked. */
@Composable
fun ConfirmCard(
    pending: PendingConfirm,
    driveActive: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val accent = LocalStateColours.current.confirming
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pending.request.confirmId) {
        while (true) {
            now = System.currentTimeMillis()
            delay(500)
        }
    }
    val secondsLeft = ((pending.deadlineMs - now) / 1000).coerceAtLeast(0)
    val fraction by animateFloatAsState(
        (secondsLeft.toFloat() / pending.request.expiresInS.coerceAtLeast(1)).coerceIn(0f, 1f),
        tween(500), label = "countdown",
    )
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(28.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 6.dp,
        shadowElevation = 12.dp,
    ) {
        Column(Modifier.padding(24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.VerifiedUser, null, tint = accent, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    if (pending.request.tier >= 2) "Approval needed · risky" else "Approval needed",
                    style = MaterialTheme.typography.titleMedium,
                    color = accent,
                    modifier = Modifier.weight(1f),
                )
                Text("${secondsLeft}s", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(10.dp))
            Box(
                Modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(accent.copy(alpha = 0.18f)),
            ) {
                Box(Modifier.fillMaxWidth(fraction).height(4.dp).clip(CircleShape).background(accent))
            }
            Spacer(Modifier.height(18.dp))
            Text(pending.request.summary, style = MaterialTheme.typography.headlineSmall)
            if (pending.request.command.isNotBlank()) {
                Spacer(Modifier.height(14.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 160.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                        .verticalScroll(rememberScrollState())
                        .padding(14.dp),
                ) {
                    Text(
                        pending.request.command,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(
                if (driveActive) "Or say “${pending.request.phrase}” / “cancel”."
                else "Start a Drive session to approve. You can cancel any time.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = onCancel,
                    modifier = Modifier.weight(1f).height(60.dp),
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Icon(Icons.Rounded.Close, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Cancel", style = MaterialTheme.typography.titleMedium)
                }
                Button(
                    onClick = onConfirm,
                    enabled = driveActive,
                    modifier = Modifier.weight(1f).height(60.dp),
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = Color(0xFF231700)),
                ) {
                    Icon(Icons.Rounded.Check, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Confirm", style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}
