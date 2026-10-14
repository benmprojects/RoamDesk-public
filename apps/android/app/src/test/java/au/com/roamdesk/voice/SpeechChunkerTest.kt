package au.com.roamdesk.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechChunkerTest {
    @Test fun `short text is one piece`() {
        assertEquals(listOf("Hello there."), SpeechChunker.split("  Hello there.  "))
    }

    @Test fun `blank text gives nothing`() {
        assertEquals(emptyList<String>(), SpeechChunker.split("   \n "))
    }

    @Test fun `long text is cut at sentence ends and nothing is lost`() {
        val sentence = "This is a sentence of moderate length that goes on a little. "
        val text = sentence.repeat(200) // about 12,000 characters
        val pieces = SpeechChunker.split(text, 3000)
        assertTrue(pieces.size >= 4)
        assertTrue(pieces.all { it.length <= 3000 })
        assertTrue(pieces.all { it.endsWith(".") }) // every cut lands on a sentence end
        assertEquals(text.trim().replace(Regex("\\s+"), " "), pieces.joinToString(" ").replace(Regex("\\s+"), " "))
    }

    @Test fun `text with no punctuation is cut at spaces, then hard`() {
        val words = "word ".repeat(1000)
        val pieces = SpeechChunker.split(words, 500)
        assertTrue(pieces.all { it.length <= 500 && !it.startsWith(" ") && !it.endsWith(" ") })
        assertEquals(1000, pieces.joinToString(" ").split(" ").count { it == "word" })
        val solid = "x".repeat(1200)
        assertEquals(listOf(500, 500, 200), SpeechChunker.split(solid, 500).map { it.length })
    }

    @Test fun `a real long reply is spoken in order`() {
        val paragraphs = (1..40).joinToString("\n\n") { "Paragraph $it. " + "Some detail here that matters. ".repeat(10) }
        val pieces = SpeechChunker.split(paragraphs, 3000)
        val joined = pieces.joinToString(" ")
        val order = (1..40).map { joined.indexOf("Paragraph $it.") }
        assertTrue(order.all { it >= 0 })
        assertEquals(order.sorted(), order)
    }
}
