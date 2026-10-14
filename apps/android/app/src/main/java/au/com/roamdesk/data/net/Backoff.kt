package au.com.roamdesk.data.net

import kotlin.random.Random

/** Exponential backoff with jitter: base·2^attempt, capped, then a random value in [50 %, 100 %] of that. */
class Backoff(
    private val baseMs: Long = 1_000,
    private val capMs: Long = 30_000,
    private val random: Random = Random.Default,
) {
    fun delayFor(attempt: Int): Long {
        val exp = if (attempt >= 30) capMs else minOf(capMs, baseMs shl attempt.coerceAtLeast(0))
        val half = exp / 2
        return half + random.nextLong(half + 1)
    }
}
