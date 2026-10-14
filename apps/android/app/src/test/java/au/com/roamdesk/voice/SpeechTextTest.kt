package au.com.roamdesk.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SpeechTextTest {
    @Test fun `asterisks for bold and italic are dropped`() {
        assertEquals("This is important and this too.", SpeechText.clean("This is **important** and *this* too."))
        assertEquals("Three stars.", SpeechText.clean("***Three*** stars."))
    }

    @Test fun `bullet dashes and asterisks are dropped and each item gets a pause`() {
        val spoken = SpeechText.clean("Do these:\n- Update the helper\n- Try the build\n* Install the client")
        assertEquals("Do these: Update the helper. Try the build. Install the client", spoken)
        assertFalse(spoken.contains("-") || spoken.contains("*"))
    }

    @Test fun `numbered lists keep their words but lose the numbering marks`() {
        assertEquals("Update. Test. Commit", SpeechText.clean("1. Update\n2. Test\n3) Commit"))
    }

    @Test fun `dashes between words become a pause`() {
        assertEquals("It works, mostly, with one catch.", SpeechText.clean("It works - mostly — with one catch."))
        assertEquals("Done, then stop.", SpeechText.clean("Done -- then stop."))
    }

    @Test fun `a dash between numbers is spoken as to, and hyphenated words and dates are left alone`() {
        assertEquals("Open 9 to 5.", SpeechText.clean("Open 9 - 5."))
        assertEquals("A well-known fix on 2026-10-09.", SpeechText.clean("A well-known fix on 2026-10-09."))
    }

    @Test fun `headings, code marks and fences are dropped`() {
        assertEquals("Summary. Use the send file tool.", SpeechText.clean("## Summary\nUse the `send_file` tool."))
        assertEquals("Run this", SpeechText.clean("```powershell\nRun this\n```").trim('.', ' '))
    }

    @Test fun `links keep their words and bare addresses are not read out`() {
        assertEquals("See the docs.", SpeechText.clean("See [the docs](https://example.com/very/long/path)."))
        assertEquals("Open a link now.", SpeechText.clean("Open https://example.com/a/b?c=d now."))
    }

    @Test fun `tables are read as plain words`() {
        val spoken = SpeechText.clean("| Name | Status |\n|---|---|\n| Helper | Updated |")
        assertFalse(spoken.contains("|") || spoken.contains("---"))
        assertEquals(true, spoken.contains("Helper") && spoken.contains("Updated"))
    }

    @Test fun `plain speech is untouched`() {
        val plain = "I've fixed it. Your phone will say so if a reply can't be spoken."
        assertEquals(plain, SpeechText.clean(plain))
    }

    @Test fun `underscores in names become spaces`() {
        assertEquals("Call send file now.", SpeechText.clean("Call send_file now."))
    }

    @Test fun `nothing left means nothing to say`() {
        assertEquals("", SpeechText.clean("**  **\n---\n"))
    }
}
