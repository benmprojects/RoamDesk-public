package au.com.roamdesk.service

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import au.com.roamdesk.R
import au.com.roamdesk.drive.DrivePhase

/**
 * Claims steering-wheel / headset media buttons for push-to-talk while a Drive session runs.
 *
 * Android routes media keys to the session that most recently played audio, so on activation we set
 * a "playing" state and play a fraction of a second of silence to become that session.
 */
class MediaButtonSession(context: Context, private val onPress: () -> Unit) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val session = MediaSession(app, "RoamDeskDrive")
    private var lastPressAt = 0L

    private val callback = object : MediaSession.Callback() {
        override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
            val event = keyEvent(mediaButtonIntent) ?: return super.onMediaButtonEvent(mediaButtonIntent)
            if (event.keyCode !in TALK_KEYS) return super.onMediaButtonEvent(mediaButtonIntent)
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) press()
            return true
        }

        // Some head units call transport controls directly instead of sending key events.
        override fun onPlay() = press()
        override fun onPause() = press()

        // The microphone button shown next to the play/pause control (Android Auto's media bar, lock screen).
        override fun onCustomAction(action: String, extras: android.os.Bundle?) {
            if (action == ACTION_TALK) press()
        }
    }

    private fun press() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPressAt < DEBOUNCE_MS) return
        lastPressAt = now
        onPress()
    }

    @Suppress("DEPRECATION")
    private fun keyEvent(intent: Intent): KeyEvent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
        }

    fun activate() {
        session.setCallback(callback, main)
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, "Roam Desk")
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Press to talk")
                .build(),
        )
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP,
                )
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build(),
        )
        session.isActive = true
        playSilence()
    }

    /**
     * Keeps the controls honest: play/pause shows "playing" only while the app is listening, working or speaking,
     * and a separate microphone "Talk" button (a custom action, since the standard button can't show a mic) is always
     * there. Android keeps routing steering-wheel keys to the last session that played, so pausing here is safe.
     */
    fun update(phase: DrivePhase) {
        val busy = phase == DrivePhase.Listening || phase == DrivePhase.Thinking || phase == DrivePhase.Speaking
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, "Roam Desk")
                .putString(MediaMetadata.METADATA_KEY_ARTIST, if (phase == DrivePhase.Listening) "Listening…" else "Tap the microphone to talk")
                .build(),
        )
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP,
                )
                .addCustomAction(
                    PlaybackState.CustomAction.Builder(
                        ACTION_TALK,
                        if (phase == DrivePhase.Listening) "Done" else "Talk",
                        R.drawable.ic_car_talk,
                    ).build(),
                )
                .setState(
                    if (busy) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                    1f,
                )
                .build(),
        )
    }

    /** Re-assert ourselves as the media-button target (e.g. after another app played audio). */
    fun reclaim() = playSilence()

    fun release() {
        session.isActive = false
        session.setCallback(null)
        session.release()
    }

    private fun playSilence() {
        Thread {
            try {
                val rate = 16_000
                val samples = rate / 4 // 250 ms
                val track = AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_UNKNOWN)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build(),
                    )
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(samples * 2)
                    .build()
                track.write(ShortArray(samples), 0, samples)
                track.play()
                Thread.sleep(400)
                track.stop()
                track.release()
            } catch (e: Exception) {
                Log.w("MediaButtonSession", "silent claim failed", e)
            }
        }.apply { name = "media-claim"; isDaemon = true }.start()
    }

    private companion object {
        const val ACTION_TALK = "au.com.roamdesk.media.TALK"
        const val DEBOUNCE_MS = 350L
        val TALK_KEYS = setOf(
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_HEADSETHOOK,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE,
        )
    }
}
