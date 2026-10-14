package au.com.roamdesk.ui.screens

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.PictureAsPdf
import androidx.compose.material.icons.rounded.TableChart
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.ConversationItem
import au.com.roamdesk.files.FileState
import au.com.roamdesk.ui.AppActions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

/** A file Claude sent from the PC: shows progress while it downloads, then Open / Share / Save. */
@Composable
fun FileCard(item: ConversationItem, state: FileState?, actions: AppActions) {
    val offer = item.file ?: return
    Row(Modifier.fillMaxWidth()) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp),
            modifier = Modifier.widthIn(max = 340.dp),
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(iconFor(offer.mime, offer.name), null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(offer.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            kindLabel(offer.mime, offer.name) + " · " + formatSize(offer.size),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (offer.caption.isNotBlank()) Text(offer.caption, style = MaterialTheme.typography.bodyMedium)

                if (state is FileState.Ready && offer.mime.startsWith("image/")) {
                    val bitmap by produceState<ImageBitmap?>(null, state.path) { value = withContext(Dispatchers.IO) { decodeSampled(state.path, 900) } }
                    bitmap?.let {
                        Image(
                            it, offer.name, Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp)),
                            contentScale = ContentScale.Fit,
                        )
                    }
                }

                when (state) {
                    is FileState.Downloading -> Column {
                        if (state.total > 0) LinearProgressIndicator(progress = { (state.bytes.toFloat() / state.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                        else LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        Text("Downloading…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    }
                    is FileState.Ready -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Button(onClick = { actions.openFile(offer.fileId) }) { Text("Open") }
                        OutlinedButton(onClick = { actions.shareFile(offer.fileId) }) { Text("Share") }
                        TextButton(onClick = { actions.saveFile(offer.fileId) }) { Text("Save") }
                    }
                    is FileState.Failed -> Column {
                        Text(state.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { actions.downloadFile(offer.fileId) }) { Text("Retry") }
                    }
                    FileState.Waiting, null -> Button(onClick = { actions.downloadFile(offer.fileId) }) { Text("Download") }
                }
            }
        }
    }
}

private fun iconFor(mime: String, name: String) = when {
    mime.startsWith("image/") -> Icons.Rounded.Image
    mime == "application/pdf" -> Icons.Rounded.PictureAsPdf
    mime.startsWith("audio/") -> Icons.Rounded.MusicNote
    mime.startsWith("video/") -> Icons.Rounded.Movie
    mime.contains("spreadsheet") || mime.contains("excel") || mime == "text/csv" || name.endsWith(".csv", true) -> Icons.Rounded.TableChart
    else -> Icons.Rounded.Description
}

private fun kindLabel(mime: String, name: String): String {
    val ext = name.substringAfterLast('.', "").uppercase(Locale.ROOT)
    return when {
        mime.startsWith("image/") -> "Image"
        mime == "application/pdf" -> "PDF"
        ext.isNotBlank() && ext.length <= 5 -> ext
        else -> "File"
    }
}

private fun formatSize(bytes: Long): String = when {
    bytes <= 0 -> "unknown size"
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(Locale.ROOT, "%.0f KB", bytes / 1024.0)
    bytes < 1024L * 1024 * 1024 -> String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0)
    else -> String.format(Locale.ROOT, "%.1f GB", bytes / 1073741824.0)
}

private fun decodeSampled(path: String, maxSide: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    var sample = 1
    while (bounds.outWidth / sample > maxSide * 2 || bounds.outHeight / sample > maxSide * 2) sample *= 2
    BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}.getOrNull()
