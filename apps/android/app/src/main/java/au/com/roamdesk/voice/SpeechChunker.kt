package au.com.roamdesk.voice

/**
 * Android's speech engine refuses text over a fixed length (about 4000 characters) and the call just fails, which used to
 * mean a long reply showed on screen but was never spoken. Long text is spoken in pieces instead, cut at sentence ends.
 */
object SpeechChunker {
    /** Comfortably under the engine's limit. */
    const val DEFAULT_MAX = 3000

    fun split(text: String, max: Int = DEFAULT_MAX): List<String> {
        require(max >= 20) { "max too small" }
        val clean = text.trim()
        if (clean.isEmpty()) return emptyList()
        if (clean.length <= max) return listOf(clean)
        val out = mutableListOf<String>()
        var rest = clean
        while (rest.length > max) {
            val window = rest.substring(0, max)
            // Prefer the end of a sentence or a line in the second half of the window, then a space, then a hard cut.
            var cut = window.lastIndexOfAny(charArrayOf('.', '!', '?', '\n')).let { if (it >= max / 2) it + 1 else -1 }
            if (cut < 0) cut = window.lastIndexOf(' ').let { if (it >= max / 2) it + 1 else max }
            out += rest.substring(0, cut).trim()
            rest = rest.substring(cut).trim()
        }
        if (rest.isNotEmpty()) out += rest
        return out.filter { it.isNotBlank() }
    }
}
