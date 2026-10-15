import Foundation

/// Turns a reply as written (with markdown: asterisks, bullet dashes, headings, backticks, tables) into what should be
/// said aloud. Only the spoken copy is changed; the conversation on screen keeps the original text.
enum SpeechText {
    private static func re(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression {
        // Patterns are literals in this file; a bad one is a programming error caught by the unit tests.
        try! NSRegularExpression(pattern: p, options: o)
    }

    private static let fence = re("```[a-zA-Z0-9_-]*")
    private static let link = re("\\[([^\\]]+)\\]\\((?:[^)]*)\\)")
    private static let url = re("https?://\\S+")
    private static let heading = re("^\\s{0,3}#{1,6}\\s*", .anchorsMatchLines)
    private static let bullet = re("^\\s*(?:[-*+\u{2022}\u{00B7}]|\\d{1,3}[.)])\\s+", .anchorsMatchLines)
    private static let tableRule = re("^\\s*\\|?[\\s:|-]+\\|[\\s:|-]*$", .anchorsMatchLines)
    private static let rangeDash = re("(\\d)\\s[-\u{2013}\u{2014}]\\s(\\d)")
    private static let spokenDash = re("\\s*(?:--+|[\u{2013}\u{2014}])\\s*|\\s+-\\s+")
    private static let emphasis = re("[*~`]+")
    private static let spaceBeforePunct = re("\\s+([,.;:!?])")
    private static let repeatedPunct = re("([,;:])(?:\\s*[,;:])+")
    private static let lineBreak = re("\\s*\\n+\\s*")
    private static let spaces = re("[ \\t]{2,}")

    private static func sub(_ r: NSRegularExpression, _ s: String, _ with: String) -> String {
        r.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: with)
    }

    static func clean(_ text: String) -> String {
        var t = text
        t = sub(fence, t, " ")
        t = sub(link, t, "$1")
        t = sub(url, t, "a link")
        t = sub(tableRule, t, "")
        t = sub(heading, t, "")
        t = sub(bullet, t, "")
        t = t.replacingOccurrences(of: "|", with: ",")
        t = sub(rangeDash, t, "$1 to $2")
        t = sub(spokenDash, t, ", ")
        t = sub(emphasis, t, "")
        t = t.replacingOccurrences(of: "_", with: " ")
        // One line per list item or paragraph: give each a stop so the voice pauses instead of running them together.
        let ns = t as NSString
        var rebuilt = ""
        var last = 0
        for m in lineBreak.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
            rebuilt += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let prev: Character? = m.range.location > 0 ? Character(ns.substring(with: NSRange(location: m.range.location - 1, length: 1))) : nil
            if let prev, ".!?:,;".contains(prev) { rebuilt += " " } else if m.range.location > 0 { rebuilt += ". " } else { rebuilt += ". " }
            last = m.range.location + m.range.length
        }
        rebuilt += ns.substring(from: last)
        t = rebuilt
        t = sub(spaceBeforePunct, t, "$1")
        t = sub(repeatedPunct, t, "$1")
        t = sub(spaces, t, " ")
        t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        while let f = t.first, ",;: ".contains(f) { t.removeFirst() }
        return t
    }
}
