package au.com.roamdesk.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicNone
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import au.com.roamdesk.drive.DrivePhase
import au.com.roamdesk.ui.theme.LocalStateColours
import kotlin.math.PI
import kotlin.math.sin

fun DrivePhase.icon(): ImageVector = when (this) {
    DrivePhase.Idle -> Icons.Rounded.MicNone
    DrivePhase.Listening -> Icons.Rounded.Mic
    DrivePhase.Thinking -> Icons.Rounded.AutoAwesome
    DrivePhase.Speaking -> Icons.Rounded.GraphicEq
    DrivePhase.Confirming -> Icons.Rounded.VerifiedUser
    DrivePhase.Offline -> Icons.Rounded.CloudOff
}

/** The large animated state ring: distinct colour + icon + one-word label per phase. */
@Composable
fun StateRing(phase: DrivePhase, modifier: Modifier = Modifier, size: Dp = 260.dp) {
    val target = LocalStateColours.current.of(phase)
    val colour by animateColorAsState(target, tween(450), label = "ringColour")
    val t = rememberInfiniteTransition(label = "ring")
    val cycle by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "cycle")
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "spin")
    val breathe by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breathe")

    Box(
        modifier = modifier
            .size(size)
            .semantics { contentDescription = "State: ${phase.label}" },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val r = this.size.minDimension / 2f * 0.80f
            val w = this.size.minDimension * 0.032f
            val c = center

            // Soft glow behind everything.
            drawCircle(
                brush = Brush.radialGradient(listOf(colour.copy(alpha = 0.20f), Color.Transparent), c, r * 1.15f),
                radius = r * 1.15f,
            )
            // Track.
            drawCircle(colour.copy(alpha = 0.14f), r, c, style = Stroke(w))

            when (phase) {
                DrivePhase.Idle -> drawCircle(colour.copy(alpha = 0.75f), r, c, style = Stroke(w))
                DrivePhase.Listening -> {
                    for (i in 0..1) {
                        val p = (cycle + i * 0.5f) % 1f
                        drawCircle(colour.copy(alpha = (1f - p) * 0.55f), r * (1f + p * 0.22f), c, style = Stroke(w * (1f - p * 0.6f)))
                    }
                    drawCircle(colour, r * (0.98f + breathe * 0.03f), c, style = Stroke(w * 1.2f))
                }
                DrivePhase.Thinking -> {
                    val box = Size(r * 2, r * 2)
                    val tl = Offset(c.x - r, c.y - r)
                    drawArc(colour, spin, 110f, false, tl, box, style = Stroke(w * 1.2f, cap = StrokeCap.Round))
                    drawArc(colour.copy(alpha = 0.45f), spin + 180f, 45f, false, tl, box, style = Stroke(w * 1.2f, cap = StrokeCap.Round))
                }
                DrivePhase.Speaking -> {
                    drawCircle(colour.copy(alpha = 0.10f + breathe * 0.08f), r * 0.96f, c)
                    // Ring "voice" ripple: radius wobbles gently.
                    val wobble = sin(cycle * 2 * PI).toFloat() * 0.015f
                    drawCircle(colour, r * (1f + wobble), c, style = Stroke(w * 1.2f))
                }
                DrivePhase.Confirming -> {
                    drawCircle(colour.copy(alpha = 0.10f + breathe * 0.10f), r, c)
                    drawCircle(colour, r, c, style = Stroke(w * (1.2f + breathe * 0.6f)))
                }
                DrivePhase.Offline -> drawCircle(
                    colour.copy(alpha = 0.8f), r, c,
                    style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(w * 1.6f, w * 1.4f))),
                )
            }
        }
        AnimatedContent(phase, transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(180)) }, label = "ringContent") { p ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(p.icon(), contentDescription = null, tint = colour, modifier = Modifier.size(size * 0.22f))
                Spacer(Modifier.height(8.dp))
                Text(p.label, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
            }
        }
    }
}
