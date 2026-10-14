package au.com.roamdesk.voice

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Android SpeechRecognizer (on-device on API 31+ when available, else the default service), en-AU,
 * partial results exposed for the screen. Main thread only; [listen] hops to Main itself.
 */
class SpeechInput(context: Context) {
    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setOnAudioFocusChangeListener { }
        .build()

    data class Config(
        /** Hard limit on how long the microphone stays open. */
        val windowMs: Long,
        /** Extend the window once (by [windowMs]) if speech is heard — used by the confirmation window. */
        val extendOnceOnSpeech: Boolean,
        /** Close the microphone if nothing at all is said within this long. */
        val noSpeechMs: Long,
        /** Close it once the transcript has stopped changing for this long after speech. The recogniser's own
         *  end-of-speech detection is unreliable on the car microphone, so this is enforced here. */
        val trailingSilenceMs: Long,
    ) {
        companion object {
            val Utterance = Config(windowMs = 30_000, extendOnceOnSpeech = false, noSpeechMs = 8_000, trailingSilenceMs = 2_000)
            val Confirmation = Config(windowMs = 8_000, extendOnceOnSpeech = true, noSpeechMs = 6_000, trailingSilenceMs = 1_200)
            val YesNo = Config(windowMs = 8_000, extendOnceOnSpeech = true, noSpeechMs = 6_000, trailingSilenceMs = 1_200)
        }
    }

    data class Result(val text: String?, val heardSpeech: Boolean, val error: Int? = null) {
        val isEmpty: Boolean get() = text.isNullOrBlank()
    }

    private val _listening = MutableStateFlow(false)
    val listening: StateFlow<Boolean> = _listening.asStateFlow()

    private val _partial = MutableStateFlow("")
    val partial: StateFlow<String> = _partial.asStateFlow()

    private var recognizer: SpeechRecognizer? = null
    private var preferOnDevice = true

    /** The car microphone currently feeding the recogniser, so "done" can close it and give the recogniser an end of audio. */
    @Volatile private var activeMic: ExternalMic? = null

    /** A microphone other than the phone's (the car's, via Android Auto) streaming 16 kHz mono PCM16. */
    interface ExternalMic {
        /** Starts capture and returns the read end of a pipe, or null if unavailable. */
        fun open(): android.os.ParcelFileDescriptor?
        fun close()
    }

    /** Set while the car screen is showing; null = phone microphone. */
    @Volatile var externalMic: ExternalMic? = null

    val isAvailable: Boolean get() = SpeechRecognizer.isRecognitionAvailable(app) || onDeviceAvailable()

    private fun onDeviceAvailable(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(app)

    private fun create(): Pair<SpeechRecognizer, Boolean> {
        val onDevice = preferOnDevice && onDeviceAvailable()
        val r = if (onDevice) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(app)
        } else {
            SpeechRecognizer.createSpeechRecognizer(app)
        }
        return r to onDevice
    }

    private fun intent(onDevice: Boolean) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-AU")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        if (!onDevice) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.packageName)
    }

    /** Opens the mic once and returns the best transcript (or null on silence/error). Cancellable. */
    suspend fun listen(config: Config): Result = withContext(Dispatchers.Main) {
        // Car microphone first (API 33+ lets the recogniser read audio we supply); fall back to the phone mic.
        val ext = externalMic
        if (ext != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val viaCar = listenOnce(config, ext)
            if (viaCar.error == null || viaCar.heardSpeech) return@withContext viaCar
            Log.w(TAG, "car mic listen failed (${viaCar.error}); using phone mic")
        }
        val first = listenOnce(config)
        // If the on-device model lacks en-AU, fall back to the default recogniser for good.
        if (first.error == ERROR_LANGUAGE_NOT_SUPPORTED || first.error == ERROR_LANGUAGE_UNAVAILABLE) {
            if (preferOnDevice) {
                preferOnDevice = false
                return@withContext listenOnce(config)
            }
        }
        first
    }

    private suspend fun listenOnce(config: Config, mic: ExternalMic? = null): Result = coroutineScope {
        destroyRecognizer()
        val source = mic?.open()
        if (mic != null && source == null) return@coroutineScope Result(null, false, ERROR_NO_EXTERNAL_MIC)
        val (rec, onDevice) = if (source != null && onDeviceAvailable()) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(app) to true
        } else {
            create()
        }
        recognizer = rec
        val result = CompletableDeferred<Result>()
        var lastPartial = ""
        var heard = false
        var extended = false
        var window: Job? = null
        var watchdog: Job? = null
        val startedAt = SystemClock.elapsedRealtime()
        var lastActivity = startedAt // everything here runs on the main thread

        /** Close the microphone first (so the recogniser sees the end of the audio), then ask it for its result. */
        suspend fun finalise() {
            if (mic != null) runCatching { mic.close() }
            rec.stopListening()
            delay(FINALISE_GRACE_MS)
            result.complete(Result(lastPartial.ifBlank { null }, heard))
        }

        fun armWindow(ms: Long) {
            window?.cancel()
            window = launch {
                delay(ms)
                if (heard && config.extendOnceOnSpeech && !extended) {
                    extended = true
                    delay(config.windowMs)
                }
                finalise()
            }
        }

        // Ends listening early: nothing said at all, or the transcript has been still since the last words.
        fun armWatchdog() {
            watchdog?.cancel()
            watchdog = launch {
                while (true) {
                    delay(WATCHDOG_TICK_MS)
                    val now = SystemClock.elapsedRealtime()
                    val noSpeech = !heard && now - startedAt > config.noSpeechMs
                    val finished = heard && now - lastActivity > config.trailingSilenceMs
                    if (noSpeech || finished) break
                }
                window?.cancel()
                finalise()
            }
        }

        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() { heard = true; lastActivity = SystemClock.elapsedRealtime() }
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
            override fun onPartialResults(partialResults: Bundle?) {
                val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (t.isNotBlank()) {
                    heard = true
                    if (t != lastPartial) lastActivity = SystemClock.elapsedRealtime()
                    lastPartial = t
                    _partial.value = t
                }
            }
            override fun onResults(results: Bundle?) {
                val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                val best = t?.takeIf { it.isNotBlank() } ?: lastPartial.ifBlank { null }
                if (best != null) _partial.value = best
                result.complete(Result(best, heard || best != null))
            }
            override fun onError(error: Int) {
                Log.d(TAG, "recogniser error $error (onDevice=$onDevice)")
                val silent = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                result.complete(Result(lastPartial.ifBlank { null }, heard, if (silent) null else error))
            }
        })

        _partial.value = ""
        val gotFocus = audio.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        _listening.value = true
        try {
            val i = intent(onDevice)
            if (source != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source)
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
                i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16_000)
            }
            activeMic = mic
            rec.startListening(i)
            armWindow(config.windowMs)
            armWatchdog()
            result.await()
        } finally {
            activeMic = null
            if (mic != null) {
                runCatching { mic.close() }
                runCatching { source?.close() }
            }
            window?.cancel()
            watchdog?.cancel()
            _listening.value = false
            if (gotFocus) audio.abandonAudioFocusRequest(focusRequest)
            if (!result.isCompleted) rec.cancel()
            destroyRecognizer()
        }
    }

    /** Stops listening and finalises what's been heard so far (push-to-talk "I'm done"). */
    fun finish() {
        activeMic?.let { runCatching { it.close() } } // end of audio, so the recogniser can finalise straight away
        recognizer?.stopListening()
    }

    private fun destroyRecognizer() {
        recognizer?.let {
            runCatching { it.cancel() }
            runCatching { it.destroy() }
        }
        recognizer = null
    }

    fun clearPartial() {
        _partial.value = ""
    }

    private companion object {
        const val TAG = "SpeechInput"
        const val FINALISE_GRACE_MS = 2_500L
        const val WATCHDOG_TICK_MS = 200L
        // SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED / ERROR_LANGUAGE_UNAVAILABLE (API 31).
        const val ERROR_LANGUAGE_NOT_SUPPORTED = 12
        const val ERROR_LANGUAGE_UNAVAILABLE = 13
        const val ERROR_NO_EXTERNAL_MIC = -100
    }
}
