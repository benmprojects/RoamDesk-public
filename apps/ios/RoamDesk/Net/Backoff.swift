import Foundation

/// Exponential backoff with jitter: base * 2^attempt, capped, then a random value in [50 %, 100 %] of that.
struct Backoff {
    var baseMs: Int64 = 1_000
    var capMs: Int64 = 30_000

    func delayMs(attempt: Int, random: () -> Double = { Double.random(in: 0..<1) }) -> Int64 {
        let exp: Int64 = attempt >= 30 ? capMs : min(capMs, baseMs << Int64(max(0, attempt)))
        let half = exp / 2
        return half + Int64(random() * Double(half + 1))
    }
}
