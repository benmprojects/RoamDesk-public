package au.com.roamdesk.protocol

import java.util.Locale

enum class ConfirmMatch { Confirm, Cancel, Unclear }
enum class YesNo { Yes, No, Unclear }

/**
 * Transcript matching rules. Confirmation rules follow PROTOCOL.md "Spoken confirmation flow" §3:
 *  - transcripts are lower-cased and punctuation is stripped (apostrophes are removed so "don't" → "dont");
 *  - matching is by whole word, never by substring ("know" is not "no", "confirmed" is not "confirm");
 *  - any cancel word wins over a phrase match.
 */
object PhraseMatcher {
    private val CANCEL_WORDS = setOf("cancel", "no", "stop", "dont")
    private val TIER1_SINGLE_WORDS = setOf("yes", "confirm")

    private val YES_WORDS = setOf("yes", "yeah", "yep", "yup", "sure", "ok", "okay", "please", "send", "affirmative", "correct")
    private val NO_WORDS = setOf("no", "nope", "nah", "cancel", "dont", "stop", "drop", "forget", "skip", "negative")

    fun tokens(text: String): List<String> =
        text.lowercase(Locale.ROOT)
            .replace("’", "'")
            .replace("'", "")
            .replace(Regex("[^\\p{L}\\p{N}\\s]"), " ")
            .split(Regex("\\s+"))
            .filter { it.isNotEmpty() }

    /** True if every word of [phrase] appears in [heard] in order (other words may sit between them). */
    fun containsInOrder(heard: List<String>, phrase: List<String>): Boolean {
        if (phrase.isEmpty()) return false
        var i = 0
        for (w in heard) {
            if (w == phrase[i]) {
                i++
                if (i == phrase.size) return true
            }
        }
        return false
    }

    private fun hasCancelWord(t: List<String>): Boolean =
        t.any { it in CANCEL_WORDS } ||
            // "do not" is treated like "don't" (stricter than the spec; can only turn a confirm into a cancel).
            t.zipWithNext().any { (a, b) -> a == "do" && b == "not" }

    fun matchConfirmation(heard: String?, phrase: String, tier: Int): ConfirmMatch {
        val t = tokens(heard.orEmpty())
        if (t.isEmpty()) return ConfirmMatch.Unclear
        if (hasCancelWord(t)) return ConfirmMatch.Cancel
        if (containsInOrder(t, tokens(phrase))) return ConfirmMatch.Confirm
        // Tier 1 only: the transcript is exactly the single word "yes" or "confirm".
        if (tier == 1 && t.size == 1 && t[0] in TIER1_SINGLE_WORDS) return ConfirmMatch.Confirm
        return ConfirmMatch.Unclear
    }

    /** Used for "Still want me to …?" on queued utterances. "No"-type words win. */
    fun matchYesNo(heard: String?): YesNo {
        val t = tokens(heard.orEmpty())
        if (t.isEmpty()) return YesNo.Unclear
        if (t.any { it in NO_WORDS } || t.zipWithNext().any { (a, b) -> a == "do" && b == "not" }) return YesNo.No
        if (t.any { it in YES_WORDS } || containsInOrder(t, listOf("go", "ahead"))) return YesNo.Yes
        return YesNo.Unclear
    }

    /** "Stop everything" → send kill without confirmation. */
    fun isStopEverything(heard: String?): Boolean {
        val t = tokens(heard.orEmpty())
        return t.zipWithNext().any { (a, b) -> a == "stop" && b == "everything" }
    }
}
