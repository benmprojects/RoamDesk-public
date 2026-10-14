package au.com.roamdesk.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.History
import androidx.compose.material3.IconButton
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.ConversationItem
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.ui.AppActions
import au.com.roamdesk.ui.theme.LocalStateColours

/** History for when parked, plus typed utterances (source "typed"). */
@Composable
fun ConversationScreen(state: DriveUiState, downloads: Map<String, au.com.roamdesk.files.FileState>, actions: AppActions) {
    val list = rememberLazyListState()
    LaunchedEffect(state.conversation.size) {
        if (state.conversation.isNotEmpty()) list.animateScrollToItem(state.conversation.lastIndex)
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, top = 16.dp, end = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Conversation", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = actions::loadHistory, enabled = state.link == au.com.roamdesk.drive.LinkStatus.Online) {
                Icon(Icons.Rounded.History, contentDescription = "Load conversation from your PC")
            }
        }
        if (state.conversation.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
                    Text(
                        "Nothing yet. What you say and Claude's replies appear here.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = actions::loadHistory, enabled = state.link == au.com.roamdesk.drive.LinkStatus.Online) {
                        Text("Load recent conversation from your PC")
                    }
                }
            }
        } else {
            LazyColumn(
                state = list,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.conversation, key = { it.id }) { item ->
                    if (item.kind == ConversationItem.Kind.File) FileCard(item, downloads[item.file?.fileId], actions)
                    else ConversationRow(item)
                }
            }
        }
        Composer(state, actions)
    }
}

@Composable
private fun ConversationRow(item: ConversationItem) {
    val sc = LocalStateColours.current
    when (item.kind) {
        ConversationItem.Kind.User -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp),
                modifier = Modifier.widthIn(max = 320.dp),
            ) { Text(item.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(14.dp)) }
        }
        ConversationItem.Kind.Reply -> Row(Modifier.fillMaxWidth()) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp),
                modifier = Modifier.widthIn(max = 340.dp),
            ) { Text(item.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(14.dp)) }
        }
        ConversationItem.Kind.Progress -> InfoLine(Icons.Rounded.Sync, item.text, sc.thinking)
        ConversationItem.Kind.System -> InfoLine(Icons.Rounded.Info, item.text, MaterialTheme.colorScheme.onSurfaceVariant)
        ConversationItem.Kind.Error -> InfoLine(Icons.Rounded.ErrorOutline, item.text, MaterialTheme.colorScheme.error)
        ConversationItem.Kind.File -> Unit // drawn by FileCard
    }
}

@Composable
private fun InfoLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, tint: androidx.compose.ui.graphics.Color) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(16.dp), tint = tint)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = tint)
    }
}

@Composable
private fun Composer(state: DriveUiState, actions: AppActions) {
    var text by rememberSaveable { mutableStateOf("") }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            if (!state.driveActive) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .padding(start = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Lock, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Locked. Start a Drive session to send.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = actions::startDrive, enabled = state.paired) { Text("Unlock") }
                }
                Spacer(Modifier.size(8.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    enabled = state.driveActive,
                    placeholder = { Text("Type to Claude…") },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(18.dp),
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        if (text.isNotBlank()) { actions.sendTyped(text); text = "" }
                    }),
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = { actions.sendTyped(text); text = "" },
                    enabled = state.driveActive && text.isNotBlank(),
                    modifier = Modifier.size(56.dp),
                ) { Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send") }
            }
        }
    }
}
