import Foundation

enum ConfirmMatch { case confirm, cancel, unclear }
enum YesNo { case yes, no, unclear }

/// Transcript matching rules. Confirmation rules follow PROTOCOL.md "Spoken confirmation flow" §3:
///  - transcripts are lower-cased and punctuation is stripped (apostrophes are removed so "don't" becomes "dont");
///  - matching is by whole word, never by substring ("know" is not "no", "confirmed" is not "confirm");
///  - any cancel word wins over a phrase match.
enum PhraseMatcher {
    private static let cancelWords: Set<String> = ["cancel", "no", "stop", "dont"]
    private static let tier1SingleWords: Set<String> = ["yes", "confirm"]
    private static let yesWords: Set<String> = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "please", "send", "affirmative", "correct"]
    private static let noWords: Set<String> = ["no", "nope", "nah", "cancel", "dont", "stop", "drop", "forget", "skip", "negative"]

    static func tokens(_ text: String) -> [String] {
        let lowered = text.lowercased()
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .replacingOccurrences(of: "'", with: "")
        let cleaned = String(lowered.unicodeScalars.map { s -> Character in
            CharacterSet.letters.contains(s) || CharacterSet.decimalDigits.contains(s) || CharacterSet.whitespacesAndNewlines.contains(s)
                ? Character(s) : " "
        })
        return cleaned.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// True if every word of `phrase` appears in `heard` in order (other words may sit between them).
    static func containsInOrder(_ heard: [String], _ phrase: [String]) -> Bool {
        if phrase.isEmpty { return false }
        var i = 0
        for w in heard where w == phrase[i] {
            i += 1
            if i == phrase.count { return true }
        }
        return false
    }

    private static func hasDoNot(_ t: [String]) -> Bool {
        zip(t, t.dropFirst()).contains { $0 == "do" && $1 == "not" }
    }

    private static func hasCancelWord(_ t: [String]) -> Bool {
        // "do not" is treated like "don't" (stricter than the spec; can only turn a confirm into a cancel).
        t.contains { cancelWords.contains($0) } || hasDoNot(t)
    }

    static func matchConfirmation(_ heard: String?, phrase: String, tier: Int) -> ConfirmMatch {
        let t = tokens(heard ?? "")
        if t.isEmpty { return .unclear }
        if hasCancelWord(t) { return .cancel }
        if containsInOrder(t, tokens(phrase)) { return .confirm }
        // Tier 1 only: the transcript is exactly the single word "yes" or "confirm".
        if tier == 1, t.count == 1, tier1SingleWords.contains(t[0]) { return .confirm }
        return .unclear
    }

    /// Used for "Still want me to ...?" on queued utterances. "No"-type words win.
    static func matchYesNo(_ heard: String?) -> YesNo {
        let t = tokens(heard ?? "")
        if t.isEmpty { return .unclear }
        if t.contains(where: { noWords.contains($0) }) || hasDoNot(t) { return .no }
        if t.contains(where: { yesWords.contains($0) }) || containsInOrder(t, ["go", "ahead"]) { return .yes }
        return .unclear
    }

    /// "Stop everything" sends kill without confirmation.
    static func isStopEverything(_ heard: String?) -> Bool {
        let t = tokens(heard ?? "")
        return zip(t, t.dropFirst()).contains { $0 == "stop" && $1 == "everything" }
    }
}
