package au.com.roamdesk.car

import android.media.MediaDescription
import android.media.MediaMetadata
import android.media.browse.MediaBrowser
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.service.media.MediaBrowserService
import android.util.Log
import au.com.roamdesk.R
import au.com.roamdesk.container
import au.com.roamdesk.drive.DrivePhase
import au.com.roamdesk.security.UnlockGate
import au.com.roamdesk.service.DriveService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Android Auto front end for sideloaded installs. Android Auto only lists sideloaded apps that are media apps
 * (the "Unknown sources" developer switch does not cover templated apps), so Roam Desk presents as one:
 * play/pause or the steering-wheel button talks, the now-playing card shows what Claude is doing and its reply,
 * and custom buttons cover Cancel, Stop all and (when Claude asks) Approve / Deny.
 */
class CarMediaService : MediaBrowserService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var session: MediaSession
    private var lastPressAt = 0L

    override fun onCreate() {
        super.onCreate()
        session = MediaSession(this, "RoamDeskCar")
        session.setCallback(callback)
        sessionToken = session.sessionToken
        session.isActive = true
        scope.launch {
            container.drive.state
                .map { View(it.paired, it.driveActive, it.phase, it.progressLabel, it.partialTranscript, it.lastHeard, it.lastReply, it.confirm?.request?.summary, it.confirm?.request?.phrase) }
                .distinctUntilChanged()
                .collect(::render)
        }
    }

    private data class View(
        val paired: Boolean,
        val active: Boolean,
        val phase: DrivePhase,
        val progress: String?,
        val partial: String,
        val heard: String,
        val reply: String,
        val confirmSummary: String?,
        val confirmPhrase: String?,
    )

    private val callback = object : MediaSession.Callback() {
        override fun onPlay() = talk()
        override fun onPause() = talk()
        override fun onStop() = talk()
        override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
            when (mediaId) {
                ID_TALK -> talk()
                ID_CANCEL -> cancel()
                ID_KILL -> container.drive.killEverything()
            }
        }
        override fun onCustomAction(action: String, extras: Bundle?) {
            when (action) {
                ID_TALK -> talk()
                ID_CANCEL -> cancel()
                ID_KILL -> container.drive.killEverything()
                ID_APPROVE -> container.drive.onConfirmButton(UnlockGate.allowed(this@CarMediaService))
                ID_DENY -> container.drive.onConfirmButton(false)
            }
        }
    }

    private fun talk() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPressAt < 350) return
        lastPressAt = now
        val drive = container.drive
        if (!drive.isDriveActive) {
            // Starting from the car needs no fingerprint, so the phone can stay locked, as long as it was unlocked recently.
            // This also stops other apps on the phone from starting Drive through the media session while it sits locked.
            if (!UnlockGate.allowed(this)) {
                session.setPlaybackState(
                    PlaybackState.Builder().setState(PlaybackState.STATE_ERROR, 0, 0f)
                        .setErrorMessage(UnlockGate.LOCKED_MESSAGE)
                        .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PLAY_PAUSE).build(),
                )
                return
            }
            drive.startDrive()
            runCatching { DriveService.start(this) }.onFailure { Log.w(TAG, "couldn't start Drive service from the car", it) }
        } else {
            drive.onTalk()
        }
    }

    private fun cancel() {
        if (container.drive.isDriveActive) container.drive.cancelCurrentTurn()
    }

    private fun render(v: View) {
        val title = when {
            !v.paired -> "Pair this phone with your PC first"
            !v.active -> "Press play to start Claude"
            v.confirmPhrase != null -> "Approve? ${v.confirmSummary.orEmpty()}".take(80)
            v.phase == DrivePhase.Listening -> "Listening…"
            v.phase == DrivePhase.Thinking -> "Working…"
            v.phase == DrivePhase.Speaking -> "Speaking"
            v.phase == DrivePhase.Offline -> "Offline"
            else -> "Press play to talk"
        }
        val subtitle = when {
            v.confirmPhrase != null -> "Say \"${v.confirmPhrase}\" or \"cancel\", or use the buttons"
            v.phase == DrivePhase.Listening && v.partial.isNotBlank() -> v.partial.take(120)
            v.phase == DrivePhase.Thinking && v.progress != null -> v.progress
            v.reply.isNotBlank() -> v.reply.take(200)
            v.heard.isNotBlank() -> "You: ${v.heard}".take(120)
            else -> "Roam Desk"
        }
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, subtitle)
                .build(),
        )
        val builder = PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                    PlaybackState.ACTION_STOP or PlaybackState.ACTION_PLAY_FROM_MEDIA_ID,
            )
        // A microphone button next to play/pause: the standard button can only ever show play or pause.
        builder.addCustomAction(PlaybackState.CustomAction.Builder(ID_TALK, if (v.phase == DrivePhase.Listening) "Done" else "Talk", R.drawable.ic_car_talk).build())
        if (v.confirmPhrase != null) {
            builder.addCustomAction(PlaybackState.CustomAction.Builder(ID_APPROVE, "Approve", R.drawable.ic_car_approve).build())
            builder.addCustomAction(PlaybackState.CustomAction.Builder(ID_DENY, "Deny", R.drawable.ic_car_cancel).build())
        }
        if (v.active) {
            builder.addCustomAction(PlaybackState.CustomAction.Builder(ID_CANCEL, "Cancel request", R.drawable.ic_car_cancel).build())
            builder.addCustomAction(PlaybackState.CustomAction.Builder(ID_KILL, "Stop everything", R.drawable.ic_car_stop).build())
        }
        // "Playing" while listening/speaking/working so the head unit shows pause; either button talks.
        val playing = v.active && v.phase != DrivePhase.Idle && v.phase != DrivePhase.Offline
        builder.setState(
            if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
            PlaybackState.PLAYBACK_POSITION_UNKNOWN,
            1f,
        )
        session.setPlaybackState(builder.build())
    }

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? =
        if (clientUid == Process.myUid() || clientUid == Process.SYSTEM_UID || clientPackageName in TRUSTED) BrowserRoot(ROOT, null) else null

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaBrowser.MediaItem>>) {
        if (parentId != ROOT) return result.sendResult(mutableListOf())
        result.sendResult(
            mutableListOf(
                item(ID_TALK, "Talk to Claude", "Same as pressing play or the steering-wheel button", R.drawable.ic_car_talk),
                item(ID_CANCEL, "Cancel current request", "Stops what Claude is doing now", R.drawable.ic_car_cancel),
                item(ID_KILL, "Stop everything", "Ends all work on your PC", R.drawable.ic_car_stop),
            ),
        )
    }

    private fun item(id: String, title: String, subtitle: String, icon: Int) = MediaBrowser.MediaItem(
        MediaDescription.Builder()
            .setMediaId(id)
            .setTitle(title)
            .setSubtitle(subtitle)
            .setIconUri(android.net.Uri.parse("android.resource://$packageName/$icon"))
            .build(),
        MediaBrowser.MediaItem.FLAG_PLAYABLE,
    )

    override fun onDestroy() {
        scope.cancel()
        session.isActive = false
        session.release()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "CarMedia"
        const val ROOT = "root"
        const val ID_TALK = "talk"
        const val ID_CANCEL = "cancel"
        const val ID_KILL = "kill"
        const val ID_APPROVE = "approve"
        const val ID_DENY = "deny"
        /** Android Auto, Android Automotive media centre and Bluetooth (head-unit AVRCP browsing). */
        val TRUSTED = setOf(
            "com.google.android.projection.gearhead",
            "com.google.android.carassistant",
            "com.android.car.media",
            "com.android.bluetooth",
            "com.android.systemui",
        )
    }
}
