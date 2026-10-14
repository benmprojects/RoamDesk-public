package au.com.roamdesk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import au.com.roamdesk.drive.DrivePhase

// Calm deep neutrals + one warm accent ("ember").
private object Palette {
    val Ink = Color(0xFF0D1015)
    val Ink1 = Color(0xFF12161C)
    val Ink2 = Color(0xFF181D25)
    val Ink3 = Color(0xFF1F252E)
    val Ink4 = Color(0xFF272E38)
    val Fog = Color(0xFFE6E8EB)
    val Mist = Color(0xFF9AA3AF)
    val Line = Color(0xFF353D48)
    val LineSoft = Color(0xFF242B34)

    val Ember = Color(0xFFF0936A)
    val EmberDeep = Color(0xFFC2582E)
    val EmberInk = Color(0xFF2B1206)
    val EmberContainer = Color(0xFF4A2616)
    val EmberOnContainer = Color(0xFFFFDBCB)

    val Paper = Color(0xFFF7F5F2)
    val Paper2 = Color(0xFFEFECE7)
    val Paper3 = Color(0xFFE6E2DC)
    val Graphite = Color(0xFF1B1F24)
    val Slate = Color(0xFF5C6470)

    val Danger = Color(0xFFE5484D)
}

private val DarkColours = darkColorScheme(
    primary = Palette.Ember,
    onPrimary = Palette.EmberInk,
    primaryContainer = Palette.EmberContainer,
    onPrimaryContainer = Palette.EmberOnContainer,
    secondary = Color(0xFFA9B4C2),
    onSecondary = Palette.Ink,
    secondaryContainer = Palette.Ink4,
    onSecondaryContainer = Palette.Fog,
    tertiary = Color(0xFF7FD1C2),
    background = Palette.Ink,
    onBackground = Palette.Fog,
    surface = Palette.Ink,
    onSurface = Palette.Fog,
    surfaceVariant = Palette.Ink3,
    onSurfaceVariant = Palette.Mist,
    surfaceContainerLowest = Palette.Ink,
    surfaceContainerLow = Palette.Ink1,
    surfaceContainer = Palette.Ink2,
    surfaceContainerHigh = Palette.Ink3,
    surfaceContainerHighest = Palette.Ink4,
    outline = Palette.Line,
    outlineVariant = Palette.LineSoft,
    error = Color(0xFFF2726C),
    onError = Color(0xFF2D0607),
    errorContainer = Color(0xFF5C1517),
    onErrorContainer = Color(0xFFFFDAD7),
)

private val LightColours = lightColorScheme(
    primary = Palette.EmberDeep,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDBCB),
    onPrimaryContainer = Color(0xFF3A1406),
    secondary = Palette.Slate,
    onSecondary = Color.White,
    secondaryContainer = Palette.Paper3,
    onSecondaryContainer = Palette.Graphite,
    tertiary = Color(0xFF1F8A78),
    background = Palette.Paper,
    onBackground = Palette.Graphite,
    surface = Palette.Paper,
    onSurface = Palette.Graphite,
    surfaceVariant = Palette.Paper3,
    onSurfaceVariant = Palette.Slate,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFBFAF8),
    surfaceContainer = Palette.Paper2,
    surfaceContainerHigh = Palette.Paper3,
    surfaceContainerHighest = Color(0xFFDDD8D1),
    outline = Color(0xFFB9B3AB),
    outlineVariant = Color(0xFFD9D4CD),
    error = Color(0xFFC9302C),
)

/** Distinct colour per ring state. Readable on both themes. */
@Immutable
data class StateColours(
    val idle: Color, val listening: Color, val thinking: Color,
    val speaking: Color, val confirming: Color, val offline: Color,
    val danger: Color,
) {
    fun of(phase: DrivePhase): Color = when (phase) {
        DrivePhase.Idle -> idle
        DrivePhase.Listening -> listening
        DrivePhase.Thinking -> thinking
        DrivePhase.Speaking -> speaking
        DrivePhase.Confirming -> confirming
        DrivePhase.Offline -> offline
    }
}

private val DarkState = StateColours(
    idle = Color(0xFF8E99AB), listening = Palette.Ember, thinking = Color(0xFFA594FF),
    speaking = Color(0xFF45C7AE), confirming = Color(0xFFF5BE4F), offline = Color(0xFF6B7380),
    danger = Palette.Danger,
)
private val LightState = StateColours(
    idle = Color(0xFF66707F), listening = Palette.EmberDeep, thinking = Color(0xFF6A55E0),
    speaking = Color(0xFF138C76), confirming = Color(0xFFB7800C), offline = Color(0xFF8A919B),
    danger = Color(0xFFD12F35),
)

val LocalStateColours = staticCompositionLocalOf { DarkState }

private val AppTypography = Typography().let { t ->
    val f = FontFamily.Default
    t.copy(
        displayMedium = TextStyle(fontFamily = f, fontWeight = FontWeight.SemiBold, fontSize = 44.sp, lineHeight = 50.sp, letterSpacing = (-0.5).sp),
        headlineLarge = TextStyle(fontFamily = f, fontWeight = FontWeight.SemiBold, fontSize = 32.sp, lineHeight = 38.sp),
        headlineMedium = TextStyle(fontFamily = f, fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 34.sp),
        headlineSmall = TextStyle(fontFamily = f, fontWeight = FontWeight.Medium, fontSize = 24.sp, lineHeight = 30.sp),
        titleLarge = TextStyle(fontFamily = f, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
        titleMedium = TextStyle(fontFamily = f, fontWeight = FontWeight.Medium, fontSize = 18.sp, lineHeight = 24.sp),
        bodyLarge = TextStyle(fontFamily = f, fontSize = 18.sp, lineHeight = 26.sp),
        bodyMedium = TextStyle(fontFamily = f, fontSize = 16.sp, lineHeight = 22.sp),
        labelLarge = TextStyle(fontFamily = f, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 20.sp, letterSpacing = 0.2.sp),
    )
}

@Composable
fun RoamDeskTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalStateColours provides if (darkTheme) DarkState else LightState) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColours else LightColours,
            typography = AppTypography,
            content = content,
        )
    }
}
