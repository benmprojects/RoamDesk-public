package au.com.roamdesk.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.protocol.CatalogItem
import au.com.roamdesk.ui.AppActions

/** Lists recent Claude Code sessions on the PC so one can be continued from the phone (hand-off). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContinueSessionSheet(state: DriveUiState, actions: AppActions, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var warnFor by remember { mutableStateOf<CatalogItem?>(null) }
    LaunchedEffect(Unit) { actions.loadCatalog() }

    fun attach(item: CatalogItem) {
        actions.attachSession(item.claudeSessionId)
        onDismiss()
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Continue a session", style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "Pick up where you left off on your PC. Same conversation, so don't use it in both places at once.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = actions::loadCatalog) { Icon(Icons.Rounded.Refresh, "Refresh") }
            }
            if (!state.driveActive) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Start a Drive session to continue one.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.height(12.dp))
        }
        val items = state.catalog
        when {
            items == null || (state.catalogLoading && items.isEmpty()) -> Box(
                Modifier.fillMaxWidth().height(180.dp),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }
            items.isEmpty() -> Box(Modifier.fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) {
                Text("No sessions found on your PC.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> LazyColumn(
                Modifier.heightIn(max = 560.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(items, key = { it.claudeSessionId }) { item ->
                    CatalogRow(item, enabled = state.driveActive) {
                        if (item.activeRecently && item.origin != "phone" && item.attachedSessionId == null) warnFor = item else attach(item)
                    }
                }
            }
        }
    }

    warnFor?.let { item ->
        AlertDialog(
            onDismissRequest = { warnFor = null },
            icon = { Icon(Icons.Rounded.Warning, null) },
            title = { Text("Still open on your PC?") },
            text = { Text("“${item.title}” was used on your PC in the last few minutes. Close it there first so the two don't get out of step.") },
            confirmButton = { Button(onClick = { warnFor = null; attach(item) }) { Text("Continue on phone") } },
            dismissButton = { TextButton(onClick = { warnFor = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun CatalogRow(item: CatalogItem, enabled: Boolean, onClick: () -> Unit) {
    val icon = when (item.origin) {
        "desktop" -> Icons.Rounded.Computer
        "phone" -> Icons.Rounded.PhoneAndroid
        else -> Icons.Rounded.Terminal
    }
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, item.origin, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(item.title.ifBlank { "Untitled session" }, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    listOf(item.project, originLabel(item.origin), timeAgo(item.lastActiveAt.toLong())).filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            when {
                item.attachedSessionId != null -> Tag("On phone", MaterialTheme.colorScheme.primary)
                item.activeRecently && item.origin != "phone" -> Tag("In use", MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun Tag(text: String, colour: androidx.compose.ui.graphics.Color) {
    Surface(shape = RoundedCornerShape(8.dp), color = colour.copy(alpha = 0.14f)) {
        Text(text, color = colour, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
    }
}

private fun originLabel(origin: String) = when (origin) {
    "desktop" -> "Desktop"
    "terminal" -> "Terminal"
    "phone" -> "Phone"
    else -> ""
}

internal fun timeAgo(epochMs: Long, now: Long = System.currentTimeMillis()): String {
    if (epochMs <= 0) return ""
    val mins = ((now - epochMs) / 60_000).coerceAtLeast(0)
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "$mins min ago"
        mins < 24 * 60 -> "${mins / 60} h ago"
        else -> "${mins / (24 * 60)} d ago"
    }
}
