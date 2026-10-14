package au.com.roamdesk.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.DirectionsCar
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import au.com.roamdesk.data.Pairing
import au.com.roamdesk.data.UserPrefs
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.ui.components.ConfirmCard
import au.com.roamdesk.ui.screens.ConversationScreen
import au.com.roamdesk.ui.screens.DriveScreen
import au.com.roamdesk.ui.screens.OnboardingScreen
import au.com.roamdesk.ui.screens.OnboardingStep
import au.com.roamdesk.ui.screens.SessionsScreen
import au.com.roamdesk.ui.screens.SettingsScreen

private enum class Tab(val label: String, val icon: ImageVector) {
    Drive("Drive", Icons.Rounded.DirectionsCar),
    Conversation("Conversation", Icons.AutoMirrored.Rounded.Chat),
    Sessions("Sessions", Icons.Rounded.FolderOpen),
    Settings("Settings", Icons.Rounded.Settings),
}

@Composable
fun AppRoot(
    state: DriveUiState,
    prefs: UserPrefs?,
    pairing: Pairing?,
    pairingLoaded: Boolean,
    permissions: PermissionState,
    downloads: Map<String, au.com.roamdesk.files.FileState>,
    update: au.com.roamdesk.update.UpdateState,
    updateBannerHidden: Boolean,
    actions: AppActions,
) {
    if (prefs == null || !pairingLoaded) {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
        return
    }
    if (!prefs.onboarded || pairing == null) {
        OnboardingScreen(
            startAt = if (prefs.onboarded) OnboardingStep.Pair else OnboardingStep.Welcome,
            paired = pairing != null,
            permissions = permissions,
            actions = actions,
        )
        return
    }

    var tab by rememberSaveable { mutableStateOf(Tab.Drive) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.notice?.id) {
        val n = state.notice ?: return@LaunchedEffect
        actions.consumeNotice(n.id)
        snackbar.showSnackbar(n.text)
    }

    Box(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = 0.dp) {
                    Tab.entries.forEach { t ->
                        NavigationBarItem(
                            selected = tab == t,
                            onClick = { tab = t },
                            icon = { Icon(t.icon, null) },
                            label = { Text(t.label) },
                            colors = NavigationBarItemDefaults.colors(
                                indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                                selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            ),
                        )
                    }
                }
            },
        ) { padding ->
            androidx.compose.foundation.layout.Column(Modifier.padding(padding).fillMaxSize()) {
                if (!updateBannerHidden) au.com.roamdesk.ui.components.UpdateBanner(update, actions)
                Box(Modifier.weight(1f).fillMaxSize()) {
                    when (tab) {
                        Tab.Drive -> DriveScreen(state, actions, onOpenSessions = { tab = Tab.Sessions })
                        Tab.Conversation -> ConversationScreen(state, downloads, actions)
                        Tab.Sessions -> SessionsScreen(state, actions)
                        Tab.Settings -> SettingsScreen(state, pairing, permissions.batteryExempt, prefs.keepScreenOn, update, actions)
                    }
                }
            }
        }

        // Approval card floats over every tab.
        val confirm = state.confirm
        AnimatedVisibility(confirm != null, enter = fadeIn(), exit = fadeOut()) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.55f))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { },
            )
        }
        AnimatedVisibility(
            confirm != null,
            enter = slideInVertically { it / 3 } + fadeIn(),
            exit = slideOutVertically { it / 3 } + fadeOut(),
            modifier = Modifier.align(Alignment.Center),
        ) {
            if (confirm != null) {
                ConfirmCard(
                    pending = confirm,
                    driveActive = state.driveActive,
                    onConfirm = { actions.confirm(true) },
                    onCancel = { actions.confirm(false) },
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
    }
}
