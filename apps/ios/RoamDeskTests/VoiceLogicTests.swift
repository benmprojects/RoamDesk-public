import XCTest
@testable import RoamDesk

final class PhraseMatcherTests: XCTestCase {
    private func m(_ heard: String?, _ phrase: String = "confirm delete", tier: Int = 2) -> ConfirmMatch {
        PhraseMatcher.matchConfirmation(heard, phrase: phrase, tier: tier)
    }

    func testExactAndLooseMatches() {
        XCTAssertEqual(m("confirm delete"), .confirm)
        XCTAssertEqual(m("Confirm, DELETE!"), .confirm)
        XCTAssertEqual(m("yes confirm the delete please"), .confirm)
        XCTAssertEqual(m("delete confirm"), .unclear)
        XCTAssertEqual(m("confirm"), .unclear)
        XCTAssertEqual(m("confirmed deleted"), .unclear)
    }

    func testCancelWordsWin() {
        XCTAssertEqual(m("confirm delete no"), .cancel)
        XCTAssertEqual(m("don't confirm delete"), .cancel)
        XCTAssertEqual(m("don\u{2019}t confirm delete"), .cancel)
        XCTAssertEqual(m("stop confirm delete"), .cancel)
        XCTAssertEqual(m("cancel"), .cancel)
        XCTAssertEqual(m("No."), .cancel)
        XCTAssertEqual(m("do not confirm delete"), .cancel)
        XCTAssertEqual(m("I know, confirm delete"), .confirm)
    }

    func testSilenceIsUnclear() {
        XCTAssertEqual(m(nil), .unclear)
        XCTAssertEqual(m(""), .unclear)
        XCTAssertEqual(m("  ...  "), .unclear)
    }

    func testTiers() {
        XCTAssertEqual(m("yes", tier: 2), .unclear)
        XCTAssertEqual(m("confirm", tier: 2), .unclear)
        XCTAssertEqual(m("yes", tier: 1), .confirm)
        XCTAssertEqual(m("Yes.", tier: 1), .confirm)
        XCTAssertEqual(m("confirm", tier: 1), .confirm)
        XCTAssertEqual(m("yes maybe", tier: 1), .unclear)
        XCTAssertEqual(m("no", tier: 1), .cancel)
    }

    func testMultiWordPhraseAndCancelWordPhrase() {
        XCTAssertEqual(m("okay confirm push now", "confirm push"), .confirm)
        XCTAssertEqual(m("confirm delete", "confirm push"), .unclear)
        XCTAssertEqual(m("confirm stop", "confirm stop"), .cancel)
    }

    func testYesNo() {
        XCTAssertEqual(PhraseMatcher.matchYesNo("yeah go on"), .yes)
        XCTAssertEqual(PhraseMatcher.matchYesNo("go ahead"), .yes)
        XCTAssertEqual(PhraseMatcher.matchYesNo("no thanks"), .no)
        XCTAssertEqual(PhraseMatcher.matchYesNo("yes, actually no"), .no)
        XCTAssertEqual(PhraseMatcher.matchYesNo("don't bother"), .no)
        XCTAssertEqual(PhraseMatcher.matchYesNo("hmm"), .unclear)
        XCTAssertEqual(PhraseMatcher.matchYesNo(nil), .unclear)
    }

    func testStopEverything() {
        XCTAssertTrue(PhraseMatcher.isStopEverything("Stop everything!"))
        XCTAssertTrue(PhraseMatcher.isStopEverything("please stop everything now"))
        XCTAssertFalse(PhraseMatcher.isStopEverything("stop"))
        XCTAssertFalse(PhraseMatcher.isStopEverything("everything stop"))
    }
}

final class SpeechTextTests: XCTestCase {
    func testEmphasisDropped() {
        XCTAssertEqual(SpeechText.clean("This is **important** and *this* too."), "This is important and this too.")
        XCTAssertEqual(SpeechText.clean("***Three*** stars."), "Three stars.")
    }

    func testBulletsGetPauses() {
        let spoken = SpeechText.clean("Do these:\n- Update the helper\n- Try the build\n* Install the client")
        XCTAssertEqual(spoken, "Do these: Update the helper. Try the build. Install the client")
    }

    func testNumberedLists() {
        XCTAssertEqual(SpeechText.clean("1. Update\n2. Test\n3) Commit"), "Update. Test. Commit")
    }

    func testDashes() {
        XCTAssertEqual(SpeechText.clean("It works - mostly \u{2014} with one catch."), "It works, mostly, with one catch.")
        XCTAssertEqual(SpeechText.clean("Done -- then stop."), "Done, then stop.")
        XCTAssertEqual(SpeechText.clean("Open 9 - 5."), "Open 9 to 5.")
        XCTAssertEqual(SpeechText.clean("A well-known fix on 2026-10-09."), "A well-known fix on 2026-10-09.")
    }

    func testHeadingsCodeAndFences() {
        XCTAssertEqual(SpeechText.clean("## Summary\nUse the `send_file` tool."), "Summary. Use the send file tool.")
    }

    func testLinks() {
        XCTAssertEqual(SpeechText.clean("See [the docs](https://example.com/very/long/path)."), "See the docs.")
        XCTAssertEqual(SpeechText.clean("Open https://example.com/a/b?c=d now."), "Open a link now.")
    }

    func testTablesAndPlainText() {
        let spoken = SpeechText.clean("| Name | Status |\n|---|---|\n| Helper | Updated |")
        XCTAssertFalse(spoken.contains("|") || spoken.contains("---"))
        XCTAssertTrue(spoken.contains("Helper") && spoken.contains("Updated"))
        let plain = "I've fixed it. Your phone will say so if a reply can't be spoken."
        XCTAssertEqual(SpeechText.clean(plain), plain)
        XCTAssertEqual(SpeechText.clean("Call send_file now."), "Call send file now.")
        XCTAssertEqual(SpeechText.clean("**  **\n---\n"), "")
    }
}

final class ReplayCollapserTests: XCTestCase {
    private func speak(_ text: String, ts: Int64, replay: Bool = true) -> HelperFrame {
        HelperFrame(type: "speak", id: "", ts: ts, seq: nil, replay: replay, message: .speak(turnId: nil, text: text, priority: .normal))
    }
    private func done(_ text: String, ts: Int64) -> HelperFrame {
        HelperFrame(type: "turn.done", id: "", ts: ts, seq: nil, replay: true, message: .turnDone(turnId: "t", text: text, durationMs: 0))
    }

    func testStaleSpeakFramesCollapseIntoOneSummary() {
        let c = ReplayCollapser()
        c.offer(speak("one", ts: 0), nowMs: 120_000)
        c.offer(speak("two", ts: 1_000), nowMs: 120_000)
        c.offer(done("All finished.", ts: 2_000), nowMs: 120_000)
        XCTAssertTrue(c.hasPending)
        XCTAssertEqual(c.flush(), [ReplayCollapser.Utterance(text: "While you were away: All finished.", priority: .normal)])
        XCTAssertFalse(c.hasPending)
    }

    func testFreshFramesAreSpokenAfterTheSummary() {
        let c = ReplayCollapser()
        c.offer(speak("old", ts: 0), nowMs: 120_000)
        c.offer(speak("fresh", ts: 100_000), nowMs: 120_000)
        let out = c.flush()
        XCTAssertEqual(out.map(\.text), ["While you were away: old", "fresh"])
    }

    func testLiveFramesAreIgnored() {
        let c = ReplayCollapser()
        c.offer(speak("live", ts: 0, replay: false), nowMs: 999_999)
        XCTAssertFalse(c.hasPending)
        XCTAssertTrue(c.flush().isEmpty)
    }
}

final class QueueAndBackoffTests: XCTestCase {
    func testBackoffGrowsAndIsCapped() {
        let b = Backoff()
        XCTAssertEqual(b.delayMs(attempt: 0, random: { 0 }), 500)
        XCTAssertEqual(b.delayMs(attempt: 0, random: { 0.999 }), 1_000)
        XCTAssertEqual(b.delayMs(attempt: 3, random: { 0 }), 4_000)
        XCTAssertEqual(b.delayMs(attempt: 20, random: { 0 }), 15_000)
        XCTAssertEqual(b.delayMs(attempt: 100, random: { 0 }), 15_000)
        XCTAssertTrue((15_000...30_000).contains(b.delayMs(attempt: 100, random: { 0.999 })))
    }

    @MainActor
    func testQueueExpiresAndPersists() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("q-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        var now: Int64 = 1_000_000
        let q = OfflineQueue(fileURL: url, ttlMs: 60_000, clock: { now })
        q.add(QueuedUtterance(id: "a", text: "first", source: "voice", queuedAt: now))
        now += 30_000
        q.add(QueuedUtterance(id: "b", text: "second", source: "voice", queuedAt: now))
        XCTAssertEqual(q.pending().map(\.id), ["a", "b"])
        XCTAssertEqual(q.count, 2)
        now += 40_000 // "a" is now 70 s old
        XCTAssertEqual(q.pending().map(\.id), ["b"])
        let reloaded = OfflineQueue(fileURL: url, ttlMs: 60_000, clock: { now })
        XCTAssertEqual(reloaded.pending().map(\.id), ["b"])
        reloaded.remove(id: "b")
        XCTAssertEqual(reloaded.count, 0)
    }

    @MainActor
    func testAsContinuation() {
        XCTAssertEqual(DriveModel.asContinuation("Check the disk space."), "check the disk space")
        XCTAssertEqual(DriveModel.asContinuation("I need a summary"), "I need a summary")
    }
}
