package au.com.roamdesk.voice

import android.media.AudioManager
import android.media.ToneGenerator
import android.util.Log

/** Short generated tones (no audio assets). Played on the media stream so they reach the car over Bluetooth. */
class Earcons {
    private var tone: ToneGenerator? = null

    private fun gen(): ToneGenerator? {
        tone?.let { return it }
        return try {
            ToneGenerator(AudioManager.STREAM_MUSIC, VOLUME).also { tone = it }
        } catch (e: RuntimeException) {
            Log.w("Earcons", "ToneGenerator unavailable", e)
            null
        }
    }

    private fun play(type: Int, ms: Int) {
        gen()?.startTone(type, ms)
    }

    /** Mic opening. */
    fun listenStart() = play(ToneGenerator.TONE_PROP_BEEP, 120)

    /** Mic closed. */
    fun listenStop() = play(ToneGenerator.TONE_PROP_ACK, 120)

    /** Soft "working on it" when nothing has been spoken 1.5 s after an utterance. */
    fun working() = play(ToneGenerator.TONE_SUP_CONFIRM, 180)

    /** Connection lost / couldn't do that. */
    fun problem() = play(ToneGenerator.TONE_PROP_NACK, 220)

    fun release() {
        tone?.release()
        tone = null
    }

    private companion object { const val VOLUME = 60 }
}
