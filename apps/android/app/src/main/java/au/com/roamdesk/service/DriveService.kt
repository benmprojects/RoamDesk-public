package au.com.roamdesk.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import au.com.roamdesk.R
import au.com.roamdesk.container
import au.com.roamdesk.drive.DrivePhase
import au.com.roamdesk.drive.DriveUiState
import au.com.roamdesk.drive.EndReason
import au.com.roamdesk.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service (microphone | mediaPlayback) for a Drive session. Keeps the process alive with the
 * screen off and owns the MediaSession that receives steering-wheel button presses.
 * Started only from the visible Activity after BiometricPrompt (Android 14 forbids starting a mic FGS from the background).
 * No binding: it talks to the process-wide [au.com.roamdesk.drive.DriveStateMachine].
 */
class DriveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var media: MediaButtonSession
    private var inForeground = false

    override fun onBind(intent: Intent?): IBinder? = null

    private val carConnected: Boolean get() = container.speechIn.externalMic != null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        media = MediaButtonSession(this) { container.drive.onTalk() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val drive = container.drive
        if (!inForeground && !goForeground(drive.state.value)) {
            // Android may refuse when started from the car with the phone locked; the car session keeps us alive then.
            if (!carConnected) drive.endDrive(EndReason.ServiceStopped)
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_TALK -> drive.onTalk()
            ACTION_STOP -> drive.endDrive(EndReason.User)
            else -> Unit
        }
        if (!drive.isDriveActive) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == null || intent.action == ACTION_START) observe()
        return START_NOT_STICKY
    }

    private var observing = false

    private fun observe() {
        if (observing) return
        observing = true
        media.activate()
        val drive = container.drive
        scope.launch {
            drive.state
                .map { NotifModel(it.driveActive, it.phase, it.helperName, notificationLine(it)) }
                .distinctUntilChanged()
                .collect { m ->
                    if (!m.active && !drive.isDriveActive) {
                        stopSelf()
                    } else if (m.active) {
                        media.update(m.phase)
                        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(m))
                    }
                }
        }
    }

    private data class NotifModel(val active: Boolean, val phase: DrivePhase, val helper: String, val line: String)

    private fun notificationLine(s: DriveUiState): String = when {
        s.confirm != null -> "Waiting for your approval"
        s.phase == DrivePhase.Offline -> s.linkDetail.ifBlank { "Offline" }
        s.phase == DrivePhase.Thinking && s.progressLabel != null -> s.progressLabel
        else -> "Press your steering-wheel button to talk"
    }

    private fun goForeground(state: DriveUiState): Boolean {
        val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        }
        return try {
            val model = NotifModel(true, state.phase, state.helperName, "Starting…")
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(model), types)
            inForeground = true
            true
        } catch (e: Exception) { // SecurityException / ForegroundServiceStartNotAllowedException
            Log.e(TAG, "Couldn't start foreground", e)
            false
        }
    }

    private fun buildNotification(m: NotifModel): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val talk = PendingIntent.getService(
            this, 1, Intent(this, DriveService::class.java).setAction(ACTION_TALK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 2, Intent(this, DriveService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = "Drive · ${m.phase.label}" + if (m.helper.isNotBlank()) " · ${m.helper}" else ""
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_wave)
            .setContentTitle(title)
            .setContentText(m.line)
            .setColor(ContextCompat.getColor(this, R.color.ca_ember))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .addAction(0, getString(R.string.notif_action_talk), talk)
            .addAction(0, getString(R.string.notif_action_stop), stop)
            .build()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel_drive), NotificationManager.IMPORTANCE_LOW)
        channel.description = getString(R.string.notif_channel_drive_desc)
        channel.setShowBadge(false)
        nm.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        scope.cancel()
        media.release()
        // If the system killed us, close the unlock window too (unless the car screen is running the session).
        if (!carConnected) container.drive.endDrive(EndReason.ServiceStopped)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "DriveService"
        private const val CHANNEL_ID = "drive"
        private const val NOTIF_ID = 42
        const val ACTION_START = "au.com.roamdesk.action.START"
        const val ACTION_TALK = "au.com.roamdesk.action.TALK"
        const val ACTION_STOP = "au.com.roamdesk.action.STOP"

        /** Call from the visible Activity, right after [au.com.roamdesk.drive.DriveStateMachine.startDrive]. */
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, DriveService::class.java).setAction(ACTION_START))
        }
    }
}
