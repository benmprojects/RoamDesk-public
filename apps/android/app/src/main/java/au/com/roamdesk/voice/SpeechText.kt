package au.com.roamdesk.voice

/**
 * Turns a reply as written (with markdown: asterisks, bullet dashes, headings, backticks, tables) into what should be
 * said aloud. Only the spoken copy is changed; the conversation on screen keeps the original text.
 */
object SpeechText {
    private val fence = Regex("```[a-zA-Z0-9_-]*")
    private val link = Regex("\\[([^\\]]+)]\\((?:[^)]*)\\)")
    private val url = Regex("https?://\\S+")
    private val heading = Regex("(?m)^\\s{0,3}#{1,6}\\s*")
    private val bullet = Regex("(?m)^\\s*(?:[-*+•·]|\\d{1,3}[.)])\\s+")
    private val tableRule = Regex("(?m)^\\s*\\|?[\\s:|-]+\\|[\\s:|-]*$")
    private val rangeDash = Regex("(\\d)\\s[-–—]\\s(\\d)")
    private val spokenDash = Regex("\\s*(?:--+|[–—])\\s*|\\s+-\\s+")
    private val emphasis = Regex("[*~`]+")
    private val spaceBeforePunct = Regex("\\s+([,.;:!?])")
    private val repeatedPunct = Regex("([,;:])(?:\\s*[,;:])+")
    private val lineBreak = Regex("\\s*\\n+\\s*")
    private val spaces = Regex("[ \\t]{2,}")

    fun clean(text: String): String {
        var t = text
        t = fence.replace(t, " ")
        t = link.replace(t, "$1")
        t = url.replace(t, "a link")
        t = tableRule.replace(t, "")
        t = heading.replace(t, "")
        t = bullet.replace(t, "")
        t = t.replace('|', ',')
        t = rangeDash.replace(t, "$1 to $2")
        t = spokenDash.replace(t, ", ")
        t = emphasis.replace(t, "")
        t = t.replace('_', ' ')
        // One line per list item or paragraph: give each a stop so the voice pauses instead of running them together.
        t = lineBreak.replace(t) { m -> if (m.range.first > 0 && t[m.range.first - 1] in ".!?:,;") " " else ". " }
        t = spaceBeforePunct.replace(t, "$1")
        t = repeatedPunct.replace(t, "$1")
        t = spaces.replace(t, " ")
        return t.trim().trimStart(',', ';', ':', ' ')
    }
}
