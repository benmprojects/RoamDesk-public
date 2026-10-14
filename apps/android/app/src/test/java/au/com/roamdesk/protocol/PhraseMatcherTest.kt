package au.com.roamdesk.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhraseMatcherTest {
    private fun m(heard: String?, phrase: String = "confirm delete", tier: Int = 2) =
        PhraseMatcher.matchConfirmation(heard, phrase, tier)

    @Test fun `exact phrase confirms`() = assertEquals(ConfirmMatch.Confirm, m("confirm delete"))
    @Test fun `case and punctuation ignored`() = assertEquals(ConfirmMatch.Confirm, m("Confirm, DELETE!"))
    @Test fun `words in order with filler between confirm`() = assertEquals(ConfirmMatch.Confirm, m("yes confirm the delete please"))
    @Test fun `words out of order are unclear`() = assertEquals(ConfirmMatch.Unclear, m("delete confirm"))
    @Test fun `missing verb is unclear`() = assertEquals(ConfirmMatch.Unclear, m("confirm"))
    @Test fun `substring is not a word match`() = assertEquals(ConfirmMatch.Unclear, m("confirmed deleted"))

    @Test fun `cancel words win over a phrase match`() {
        assertEquals(ConfirmMatch.Cancel, m("confirm delete no"))
        assertEquals(ConfirmMatch.Cancel, m("don't confirm delete"))
        assertEquals(ConfirmMatch.Cancel, m("don’t confirm delete")) // curly apostrophe
        assertEquals(ConfirmMatch.Cancel, m("stop confirm delete"))
        assertEquals(ConfirmMatch.Cancel, m("cancel"))
        assertEquals(ConfirmMatch.Cancel, m("No."))
        assertEquals(ConfirmMatch.Cancel, m("do not confirm delete"))
    }

    @Test fun `no is matched as a whole word only`() = assertEquals(ConfirmMatch.Confirm, m("I know, confirm delete"))

    @Test fun `silence and empty are unclear`() {
        assertEquals(ConfirmMatch.Unclear, m(null))
        assertEquals(ConfirmMatch.Unclear, m(""))
        assertEquals(ConfirmMatch.Unclear, m("  ...  "))
    }

    @Test fun `tier 2 does not accept plain yes`() {
        assertEquals(ConfirmMatch.Unclear, m("yes", tier = 2))
        assertEquals(ConfirmMatch.Unclear, m("confirm", tier = 2))
    }

    @Test fun `tier 1 accepts single word yes or confirm`() {
        assertEquals(ConfirmMatch.Confirm, m("yes", tier = 1))
        assertEquals(ConfirmMatch.Confirm, m("Yes.", tier = 1))
        assertEquals(ConfirmMatch.Confirm, m("confirm", tier = 1))
        assertEquals(ConfirmMatch.Unclear, m("yes maybe", tier = 1))
        assertEquals(ConfirmMatch.Confirm, m("confirm delete", tier = 1))
        assertEquals(ConfirmMatch.Cancel, m("no", tier = 1))
    }

    @Test fun `multi word phrase`() {
        assertEquals(ConfirmMatch.Confirm, m("okay confirm push now", phrase = "confirm push"))
        assertEquals(ConfirmMatch.Unclear, m("confirm delete", phrase = "confirm push"))
    }

    @Test fun `phrase containing a cancel word can never confirm (spec literal)`() {
        assertEquals(ConfirmMatch.Cancel, m("confirm stop", phrase = "confirm stop"))
    }

    @Test fun `yes no for queued utterances`() {
        assertEquals(YesNo.Yes, PhraseMatcher.matchYesNo("yeah go on"))
        assertEquals(YesNo.Yes, PhraseMatcher.matchYesNo("go ahead"))
        assertEquals(YesNo.No, PhraseMatcher.matchYesNo("no thanks"))
        assertEquals(YesNo.No, PhraseMatcher.matchYesNo("yes, actually no"))
        assertEquals(YesNo.No, PhraseMatcher.matchYesNo("don't bother"))
        assertEquals(YesNo.Unclear, PhraseMatcher.matchYesNo("hmm"))
        assertEquals(YesNo.Unclear, PhraseMatcher.matchYesNo(null))
    }

    @Test fun `stop everything detection`() {
        assertTrue(PhraseMatcher.isStopEverything("Stop everything!"))
        assertTrue(PhraseMatcher.isStopEverything("please stop everything now"))
        assertFalse(PhraseMatcher.isStopEverything("stop"))
        assertFalse(PhraseMatcher.isStopEverything("everything stop"))
    }
}
