package au.com.roamdesk.protocol

/**
 * Collects replayed frames (payload.replay = true) after a reconnect and decides what gets spoken.
 *
 * PROTOCOL.md "Replay and resume": replayed `speak` frames more than 60 s old are not spoken one by one;
 * they collapse into a single "While you were away: <last turn.done text>". Replayed speak frames that are
 * still fresh (≤ 60 s) are spoken normally, after the summary, in order.
 *
 * Age is measured as phoneNow − frame.ts (PC clock), so large clock skew between devices shifts the cut-off.
 */
class ReplayCollapser(private val maxAgeMs: Long = 60_000) {

    data class Utterance(val text: String, val priority: SpeakPriority)

    private val fresh = mutableListOf<HelperMessage.Speak>()
    private var staleSpeakCount = 0
    private var lastStaleSpeakText: String? = null
    private var lastStaleDoneText: String? = null
    private var lastAnyDoneText: String? = null

    val hasPending: Boolean get() = fresh.isNotEmpty() || staleSpeakCount > 0

    /** Offer a replayed frame. Non-speak/turn.done frames are ignored here (the caller still shows them on screen). */
    fun offer(frame: HelperFrame, nowMs: Long) {
        if (!frame.replay) return
        val stale = nowMs - frame.ts > maxAgeMs
        when (val m = frame.message) {
            is HelperMessage.Speak -> if (stale) {
                staleSpeakCount++
                lastStaleSpeakText = m.text
            } else {
                fresh += m
            }
            is HelperMessage.TurnDone -> {
                if (m.text.isNotBlank()) {
                    lastAnyDoneText = m.text
                    if (stale) lastStaleDoneText = m.text
                }
            }
            else -> Unit
        }
    }

    /** Returns what to speak, in order, and resets. */
    fun flush(): List<Utterance> {
        val out = mutableListOf<Utterance>()
        if (staleSpeakCount > 0) {
            val text = lastStaleDoneText ?: lastAnyDoneText ?: lastStaleSpeakText
            if (!text.isNullOrBlank()) out += Utterance("While you were away: ${text.trim()}", SpeakPriority.Normal)
        }
        fresh.forEach { out += Utterance(it.text, it.speakPriority) }
        reset()
        return out
    }

    fun reset() {
        fresh.clear()
        staleSpeakCount = 0
        lastStaleSpeakText = null
        lastStaleDoneText = null
        lastAnyDoneText = null
    }
}
