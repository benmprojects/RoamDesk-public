import Foundation

/// Collects replayed frames (payload.replay = true) after a reconnect and decides what gets spoken.
///
/// PROTOCOL.md "Replay and resume": replayed `speak` frames more than 60 s old are not spoken one by one;
/// they collapse into a single "While you were away: <last turn.done text>". Replayed speak frames that are
/// still fresh (60 s or less) are spoken normally, after the summary, in order.
///
/// Age is measured as phoneNow minus frame.ts (PC clock), so large clock skew between devices shifts the cut-off.
final class ReplayCollapser {
    struct Utterance: Equatable {
        let text: String
        let priority: SpeakPriority
    }

    private let maxAgeMs: Int64
    private var fresh: [(text: String, priority: SpeakPriority)] = []
    private var staleSpeakCount = 0
    private var lastStaleSpeakText: String?
    private var lastStaleDoneText: String?
    private var lastAnyDoneText: String?

    init(maxAgeMs: Int64 = 60_000) { self.maxAgeMs = maxAgeMs }

    var hasPending: Bool { !fresh.isEmpty || staleSpeakCount > 0 }

    /// Offer a replayed frame. Non-speak/turn.done frames are ignored here (the caller still shows them on screen).
    func offer(_ frame: HelperFrame, nowMs: Int64) {
        guard frame.replay else { return }
        let stale = nowMs - frame.ts > maxAgeMs
        switch frame.message {
        case let .speak(_, text, priority):
            if stale {
                staleSpeakCount += 1
                lastStaleSpeakText = text
            } else {
                fresh.append((text, priority))
            }
        case let .turnDone(_, text, _):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lastAnyDoneText = text
                if stale { lastStaleDoneText = text }
            }
        default: break
        }
    }

    /// Returns what to speak, in order, and resets.
    func flush() -> [Utterance] {
        var out: [Utterance] = []
        if staleSpeakCount > 0 {
            let text = lastStaleDoneText ?? lastAnyDoneText ?? lastStaleSpeakText
            if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.append(Utterance(text: "While you were away: \(text.trimmingCharacters(in: .whitespacesAndNewlines))", priority: .normal))
            }
        }
        for f in fresh { out.append(Utterance(text: f.text, priority: f.priority)) }
        reset()
        return out
    }

    func reset() {
        fresh.removeAll()
        staleSpeakCount = 0
        lastStaleSpeakText = nil
        lastStaleDoneText = nil
        lastAnyDoneText = nil
    }
}
