package au.com.roamdesk.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.lifecycleScope
import au.com.roamdesk.R
import au.com.roamdesk.container
import au.com.roamdesk.drive.DrivePhase
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.drive.LinkStatus
import au.com.roamdesk.security.UnlockGate
import au.com.roamdesk.service.DriveService
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.launch

private fun icon(ctx: CarContext, res: Int) = CarIcon.Builder(IconCompat.createWithResource(ctx, res)).build()

private fun listLimit(ctx: CarContext): Int = runCatching {
    ctx.getCarService(ConstraintManager::class.java).getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
}.getOrDefault(6)

/** Re-renders a screen whenever the Drive state changes (sampled so live transcripts don't flood the car). */
@OptIn(FlowPreview::class)
private fun Screen.followDriveState() {
    lifecycleScope.launch {
        carContext.container.drive.state.sample(600).distinctUntilChanged().collect { invalidate() }
    }
}

/** Main car screen: status, what you said, Claude's reply, Talk / Sessions, plus Cancel and Stop. */
class DriveCarScreen(ctx: CarContext) : Screen(ctx) {
    init { followDriveState() }

    private val drive get() = carContext.container.drive
    private val state: DriveUiState get() = drive.state.value
    private var lockedOut = false

    /**
     * Android Auto allows five templates per task, and only counts a new template as a refresh (free) when the
     * template type and title are the same, and the number of rows and each row's TITLE are unchanged. So the whole
     * session is one PaneTemplate with three fixed rows ("Status", "You", "Claude") whose titles never change; only
     * their text lines and the buttons change. Switching template types as the state changed used the quota up
     * quickly, and Android Auto then said the task couldn't be completed while driving.
     */
    override fun onGetTemplate(): Template {
        val s = state
        val statusLine: String
        val detailLine: String
        val actions = mutableListOf<Action>()

        when {
            !s.paired -> {
                statusLine = "Not paired yet"
                detailLine = "Open Roam Desk on your phone and pair it with your PC."
            }
            !s.driveActive && lockedOut -> {
                statusLine = "Unlock your phone once"
                detailLine = UnlockGate.LOCKED_MESSAGE
                actions += Action.Builder().setTitle("Try again").setBackgroundColor(CarColor.PRIMARY).setOnClickListener { startDrive() }.build()
            }
            !s.driveActive -> {
                statusLine = if (s.link == LinkStatus.Online) "Connected to ${s.helperName.ifBlank { "your PC" }}" else "Not connected to your PC yet"
                detailLine = if (s.link == LinkStatus.Online) "Tap Start to talk to Claude." else "You can start anyway and it will connect."
                actions += Action.Builder().setTitle("Start").setIcon(icon(carContext, R.drawable.ic_car_talk))
                    .setBackgroundColor(CarColor.PRIMARY).setOnClickListener { startDrive() }.build()
            }
            s.confirm != null -> {
                val req = s.confirm.request
                statusLine = "Approve this?"
                detailLine = "${req.summary} Say \"${req.phrase}\"."
                actions += Action.Builder().setTitle("Approve").setBackgroundColor(CarColor.GREEN)
                    .setOnClickListener { drive.onConfirmButton(UnlockGate.allowed(carContext)) }.build()
                actions += Action.Builder().setTitle("Deny").setOnClickListener { drive.onConfirmButton(false) }.build()
            }
            else -> {
                val listening = s.phase == DrivePhase.Listening
                statusLine = when (s.phase) {
                    DrivePhase.Listening -> "Listening…"
                    DrivePhase.Thinking -> "Working: " + (s.progressLabel ?: "thinking")
                    DrivePhase.Offline -> "Offline: " + s.linkDetail.ifBlank { "reconnecting" }
                    DrivePhase.Speaking -> "Speaking"
                    else -> "Ready. Tap Talk."
                }
                detailLine = s.activeSession?.name?.let { "Session: $it" } ?: s.helperName
                actions += Action.Builder().setTitle(if (listening) "Done" else "Talk")
                    .setIcon(icon(carContext, R.drawable.ic_car_talk)).setBackgroundColor(CarColor.PRIMARY)
                    .setOnClickListener { drive.onTalk() }.build()
                actions += Action.Builder().setTitle("Sessions").setOnClickListener { screenManager.push(SessionsCarScreen(carContext)) }.build()
            }
        }

        val heard = (if (s.phase == DrivePhase.Listening && s.partialTranscript.isNotBlank()) s.partialTranscript else s.lastHeard)
            .ifBlank { "-" }.take(110)
        val replyChunks = s.lastReply.ifBlank { "-" }.chunked(110).take(2)

        val pane = Pane.Builder()
            .addRow(Row.Builder().setTitle("Status").addText(statusLine.take(110)).addText(detailLine.take(110)).build())
            .addRow(Row.Builder().setTitle("You").addText(heard).build())
            .addRow(Row.Builder().setTitle("Claude").addText(replyChunks[0]).apply { replyChunks.getOrNull(1)?.let { addText(it) } }.build())
        actions.forEach { pane.addAction(it) }

        val template = PaneTemplate.Builder(pane.build()).setTitle("Roam Desk").setHeaderAction(Action.APP_ICON)
        if (s.driveActive) {
            template.setActionStrip(
                ActionStrip.Builder()
                    .addAction(Action.Builder().setIcon(icon(carContext, R.drawable.ic_car_cancel)).setOnClickListener { drive.cancelCurrentTurn() }.build())
                    .addAction(Action.Builder().setTitle("Stop all").setOnClickListener { drive.killEverything() }.build())
                    .build(),
            )
        }
        return template.build()
    }

    private fun startDrive() {
        // The microphone permission is asked for on the car screen, where the user can answer it.
        if (androidx.core.content.ContextCompat.checkSelfPermission(carContext, android.Manifest.permission.RECORD_AUDIO) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            carContext.requestPermissions(listOf(android.Manifest.permission.RECORD_AUDIO)) { granted, _ ->
                if (granted.isNotEmpty()) startDrive()
            }
            return
        }
        // From the car the phone can stay locked, so no fingerprint step here, as long as it was unlocked recently.
        if (!UnlockGate.allowed(carContext)) {
            lockedOut = true
            invalidate()
            return
        }
        lockedOut = false
        drive.startDrive()
        runCatching { DriveService.start(carContext) } // keeps the app alive; may be refused while the phone is locked
        invalidate()
    }

}

/** Pick the active session, or continue one from the PC. */
class SessionsCarScreen(ctx: CarContext) : Screen(ctx) {
    init { followDriveState() }

    override fun onGetTemplate(): Template {
        val s = carContext.container.drive.state.value
        val items = ItemList.Builder()
        items.addItem(
            Row.Builder().setTitle("Continue a PC session…").addText("Pick up a desktop or terminal conversation")
                .setBrowsable(true).setOnClickListener { screenManager.push(CatalogCarScreen(carContext)) }.build(),
        )
        s.sessions.take(listLimit(carContext) - 1).forEach { sess ->
            val active = sess.id == s.activeSessionId
            items.addItem(
                Row.Builder().setTitle(sess.name + if (active) "  ✓" else "")
                    .addText(if (sess.busy) "Working…" else sess.cwd.substringAfterLast('\\'))
                    .setOnClickListener {
                        carContext.container.drive.selectSession(sess.id)
                        screenManager.pop()
                    }.build(),
            )
        }
        return ListTemplate.Builder().setSingleList(items.build()).setTitle("Sessions").setHeaderAction(Action.BACK).build()
    }
}

/** Recent sessions on the PC that the phone can take over. */
class CatalogCarScreen(ctx: CarContext) : Screen(ctx) {
    init {
        followDriveState()
        carContext.container.drive.loadCatalog()
    }

    override fun onGetTemplate(): Template {
        val s = carContext.container.drive.state.value
        val list = ListTemplate.Builder().setTitle("Continue a session").setHeaderAction(Action.BACK)
        val catalog = s.catalog
        if (catalog == null || (s.catalogLoading && catalog.isEmpty())) return list.setLoading(true).build()
        val items = ItemList.Builder().setNoItemsMessage("No sessions found on your PC.")
        catalog.take(listLimit(carContext)).forEach { c ->
            items.addItem(
                Row.Builder().setTitle(c.title.ifBlank { "Untitled session" })
                    .addText(listOf(c.project, if (c.activeRecently) "in use on PC" else "").filter { it.isNotBlank() }.joinToString(" · "))
                    .setOnClickListener {
                        carContext.container.drive.attachSession(c.claudeSessionId)
                        screenManager.popToRoot()
                    }.build(),
            )
        }
        return list.setSingleList(items.build()).build()
    }
}
