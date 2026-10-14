package au.com.roamdesk.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import au.com.roamdesk.protocol.SpeakPriority
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Android TextToSpeech with en-AU voice, USAGE_ASSISTANT audio and transient "may duck" focus.
 * Owns its own queue so it always knows whether it's speaking. Main thread only.
 *
 * Priorities (PROTOCOL.md `speak`): interrupt stops current speech and speaks now; normal is queued;
 * low is dropped if anything is already speaking or queued (the caller also drops it while listening).
 */
class SpeechOutput(context: Context) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audio = app.getSystemService(AudioManager::class.java)
    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attrs)
        .setOnAudioFocusChangeListener { }
        .build()

    private data class Item(val id: String, val text: String, val waiter: CompletableDeferred<Unit>?, val retries: Int = 0)

    /** Called (on the main thread) with text that could not be spoken, so the screen can say so instead of staying silent. */
    var onDropped: ((String) -> Unit)? = null

    private var tts: TextToSpeech? = null
    private var ready = false
    private var hasFocus = false
    private val queue = ArrayDeque<Item>()
    private var current: Item? = null
    private val ids = AtomicLong()

    private val _speaking = MutableStateFlow(false)
    val speaking: StateFlow<Boolean> = _speaking.asStateFlow()

    private val _available = MutableStateFlow(true)
    val available: StateFlow<Boolean> = _available.asStateFlow()

    var rate: Float = 1.0f
        set(value) {
            field = value
            tts?.setSpeechRate(value)
        }

    data class VoiceOption(val name: String, val label: String, val online: Boolean)

    private val _voices = MutableStateFlow<List<VoiceOption>>(emptyList())
    /** English voices installed in the phone's speech engine, Australian first. Empty until [init] completes. */
    val voices: StateFlow<List<VoiceOption>> = _voices.asStateFlow()

    /** Voice chosen in Settings; null = best offline Australian voice. */
    var voiceName: String? = null
        set(value) {
            field = value
            if (ready) applyVoice()
        }

    private fun applyVoice() {
        val engine = tts ?: return
        runCatching {
            val all = engine.voices ?: return
            val chosen = voiceName?.let { n -> all.firstOrNull { it.name == n } }
                ?: all.filter { it.locale == AU && !it.isNetworkConnectionRequired }.maxByOrNull { it.quality }
            chosen?.let { engine.voice = it }
        }
    }

    private fun loadVoices() {
        val engine = tts ?: return
        val order = listOf("AU", "GB", "NZ", "IE", "US")
        _voices.value = runCatching {
            engine.voices.orEmpty()
                .filter { it.locale.language == "en" && "notInstalled" !in it.features.orEmpty() }
                .sortedWith(
                    compareBy<android.speech.tts.Voice>({ order.indexOf(it.locale.country).let { i -> if (i < 0) 99 else i } })
                        .thenBy { it.isNetworkConnectionRequired }
                        .thenByDescending { it.quality }
                        .thenBy { it.name },
                )
                .map { VoiceOption(it.name, labelFor(it), it.isNetworkConnectionRequired) }
        }.getOrDefault(emptyList())
    }

    private fun labelFor(v: android.speech.tts.Voice): String {
        val country = v.locale.getDisplayCountry(Locale.UK).ifBlank { v.locale.displayName }
        // Google names look like "en-au-x-aub-local"; keep the short variant code so voices can be told apart.
        val code = Regex("-x-([a-z0-9]+)").find(v.name)?.groupValues?.get(1)?.uppercase()
            ?: v.name.substringAfterLast('-').take(12)
        return "$country · $code"
    }

    fun init() {
        if (tts != null) return
        tts = TextToSpeech(app) { status ->
            main.post {
                val engine = tts ?: return@post
                if (status != TextToSpeech.SUCCESS) {
                    _available.value = false
                    Log.w(TAG, "TTS init failed: $status")
                    dropQueued() // nothing can be spoken: say so rather than waiting forever
                    return@post
                }
                val r = engine.setLanguage(AU)
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    engine.setLanguage(Locale.UK).takeIf { it < 0 }?.let { engine.setLanguage(Locale.US) }
                }
                loadVoices()
                applyVoice()
                engine.setAudioAttributes(attrs)
                engine.setSpeechRate(rate)
                engine.setOnUtteranceProgressListener(listener)
                ready = true
                _available.value = true
                if (current == null) playNext()
            }
        }
    }

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit
        override fun onDone(utteranceId: String?) { main.post { finished(utteranceId) } }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) { main.post { failed(utteranceId) } }
        override fun onError(utteranceId: String?, errorCode: Int) { main.post { failed(utteranceId) } }
        override fun onStop(utteranceId: String?, interrupted: Boolean) { main.post { finished(utteranceId) } }
    }

    private fun finished(id: String?) {
        val c = current ?: return
        if (c.id != id) return
        current = null
        c.waiter?.complete(Unit)
        playNext()
    }

    /** The engine reported an error part-way through: tell the screen, then carry on with the next piece. */
    private fun failed(id: String?) {
        val c = current ?: return
        if (c.id != id) return
        Log.w(TAG, "speech engine error on an utterance")
        onDropped?.invoke(c.text)
        finished(id)
    }

    /** Returns false if the utterance was dropped. */
    fun speak(text: String, priority: SpeakPriority = SpeakPriority.Normal): Boolean {
        if (text.isBlank()) return false
        when (priority) {
            SpeakPriority.Interrupt -> {
                stopAll()
                enqueue(text, null)
            }
            SpeakPriority.Normal -> enqueue(text, null)
            SpeakPriority.Low -> {
                if (current != null || queue.isNotEmpty()) return false
                enqueue(text, null)
            }
        }
        return true
    }

    /** Interrupts anything playing, speaks [text] and suspends until it finishes or is stopped. */
    suspend fun speakAndWait(text: String) {
        stopAll()
        val done = CompletableDeferred<Unit>()
        enqueue(text, done)
        try {
            done.await()
        } finally {
            if (!done.isCompleted) stopAll()
        }
    }

    private fun enqueue(text: String, waiter: CompletableDeferred<Unit>?) {
        if (!_available.value) {
            onDropped?.invoke(text)
            waiter?.complete(Unit); return
        }
        // The engine rejects text over its limit, so long replies are spoken in pieces; only the last piece releases a waiter.
        val limit = runCatching { TextToSpeech.getMaxSpeechInputLength() - 400 }.getOrDefault(SpeechChunker.DEFAULT_MAX).coerceIn(500, SpeechChunker.DEFAULT_MAX)
        // Markdown symbols (asterisks, bullet dashes, hashes) are written for the eye, not the ear: don't read them out.
        val pieces = SpeechChunker.split(SpeechText.clean(text), limit)
        if (pieces.isEmpty()) {
            waiter?.complete(Unit); return
        }
        pieces.forEachIndexed { i, piece ->
            queue.addLast(Item("u${ids.incrementAndGet()}", piece, if (i == pieces.lastIndex) waiter else null))
        }
        _speaking.value = true
        if (current == null) playNext()
    }

    private fun dropQueued() {
        val pending = queue.toList()
        queue.clear()
        current = null
        _speaking.value = false
        pending.forEach {
            onDropped?.invoke(it.text)
            it.waiter?.complete(Unit)
        }
    }

    /** The engine can die or fall out of step with the app. Restart it once and try the same text again. */
    private fun restartEngine() {
        runCatching { tts?.shutdown() }
        tts = null
        ready = false
        _available.value = true
        init()
    }

    private fun playNext() {
        val engine = tts
        if (engine == null || !ready) {
            if (engine == null) init()
            return
        }
        val next = queue.removeFirstOrNull()
        if (next == null) {
            current = null
            _speaking.value = false
            abandonFocus()
            return
        }
        current = next
        _speaking.value = true
        requestFocus()
        val res = engine.speak(next.text, TextToSpeech.QUEUE_FLUSH, Bundle(), next.id)
        if (res != TextToSpeech.SUCCESS) {
            Log.w(TAG, "speak() failed ($res), retries so far ${next.retries}")
            if (next.retries < 1) {
                // Put it back at the front, restart the engine, and let init() resume playback.
                queue.addFirst(next.copy(retries = next.retries + 1))
                current = null
                restartEngine()
            } else {
                onDropped?.invoke(next.text)
                finished(next.id)
            }
        }
    }

    fun stopAll() {
        val pending = queue.toList() + listOfNotNull(current)
        queue.clear()
        current = null
        tts?.stop()
        pending.forEach { it.waiter?.complete(Unit) }
        _speaking.value = false
        abandonFocus()
    }

    private fun requestFocus() {
        if (hasFocus) return
        hasFocus = audio.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        if (!hasFocus) return
        audio.abandonAudioFocusRequest(focusRequest)
        hasFocus = false
    }

    fun shutdown() {
        stopAll()
        tts?.shutdown()
        tts = null
        ready = false
    }

    private companion object {
        const val TAG = "SpeechOutput"
        val AU: Locale = Locale("en", "AU")
    }
}
