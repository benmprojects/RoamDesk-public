package au.com.roamdesk.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayCollapserTest {
    private val now = 1_760_000_000_000L
    private var seq = 0L

    private fun frame(msg: HelperMessage, ageMs: Long, replay: Boolean = true) =
        HelperFrame("x", "id${seq}", now - ageMs, ++seq, replay, msg)

    private fun speak(text: String, ageMs: Long, p: String = "normal") = frame(HelperMessage.Speak("t", text, p), ageMs)
    private fun done(text: String, ageMs: Long) = frame(HelperMessage.TurnDone("t", text, 10), ageMs)

    @Test fun `old speak frames collapse into one summary using last turn done`() {
        val c = ReplayCollapser()
        c.offer(speak("Starting the backup.", 600_000), now)
        c.offer(speak("Backup is halfway.", 500_000), now)
        c.offer(done("Backup finished, 3 GB copied.", 400_000), now)
        c.offer(speak("Backup finished, 3 GB copied.", 400_000), now)
        assertTrue(c.hasPending)
        val out = c.flush()
        assertEquals(listOf(ReplayCollapser.Utterance("While you were away: Backup finished, 3 GB copied.", SpeakPriority.Normal)), out)
        assertFalse(c.hasPending)
    }

    @Test fun `fresh speak frames are spoken individually after the summary`() {
        val c = ReplayCollapser()
        c.offer(done("Old task done.", 120_000), now)
        c.offer(speak("Old task done.", 120_000), now)
        c.offer(speak("New one started.", 20_000), now)
        c.offer(speak("Heads up.", 5_000, "interrupt"), now)
        val out = c.flush()
        assertEquals(
            listOf(
                ReplayCollapser.Utterance("While you were away: Old task done.", SpeakPriority.Normal),
                ReplayCollapser.Utterance("New one started.", SpeakPriority.Normal),
                ReplayCollapser.Utterance("Heads up.", SpeakPriority.Interrupt),
            ),
            out,
        )
    }

    @Test fun `exactly 60 s old is still fresh`() {
        val c = ReplayCollapser()
        c.offer(speak("On the edge.", 60_000), now)
        assertEquals(listOf(ReplayCollapser.Utterance("On the edge.", SpeakPriority.Normal)), c.flush())
    }

    @Test fun `no turn done falls back to last stale speak text`() {
        val c = ReplayCollapser()
        c.offer(speak("Still checking the logs.", 300_000), now)
        assertEquals("While you were away: Still checking the logs.", c.flush().single().text)
    }

    @Test fun `non replay frames and other types are ignored`() {
        val c = ReplayCollapser()
        c.offer(frame(HelperMessage.Speak("t", "live", "normal"), 300_000, replay = false), now)
        c.offer(frame(HelperMessage.TurnProgress("t", "Working"), 300_000), now)
        assertFalse(c.hasPending)
        assertTrue(c.flush().isEmpty())
    }

    @Test fun `turn done without stale speaks produces nothing`() {
        val c = ReplayCollapser()
        c.offer(done("Finished.", 300_000), now)
        assertTrue(c.flush().isEmpty())
    }
}
