package au.com.roamdesk.data

import au.com.roamdesk.data.net.Backoff
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.random.Random

class QueueAndBackoffTest {

    @Test fun `backoff grows exponentially, stays within jitter band and caps at 30 s`() {
        val b = Backoff(1_000, 30_000, Random(7))
        for (attempt in 0..12) {
            val ceiling = minOf(30_000L, 1_000L shl attempt)
            repeat(50) {
                val d = b.delayFor(attempt)
                assertTrue("attempt $attempt gave $d", d in ceiling / 2..ceiling)
            }
        }
        assertTrue(b.delayFor(100) <= 30_000)
    }

    @Test fun `offline queue drops items older than 30 minutes and persists`() = runTest {
        val dir = Files.createTempDirectory("q").toFile()
        val file = File(dir, "q.json")
        var clock = 1_000_000_000L
        val q = OfflineQueue(file, clock = { clock })
        q.add(QueuedUtterance("a", "check disk space", "voice", clock))
        clock += 20 * 60_000
        q.add(QueuedUtterance("b", "what's the time", "voice", clock))
        assertEquals(listOf("a", "b"), q.pending().map { it.id })

        clock += 11 * 60_000 // "a" is now 31 min old
        assertEquals(listOf("b"), q.pending().map { it.id })

        val reloaded = OfflineQueue(file, clock = { clock })
        assertEquals(listOf("b"), reloaded.pending().map { it.id })
        reloaded.remove("b")
        assertTrue(reloaded.pending().isEmpty())
        dir.deleteRecursively()
    }
}
