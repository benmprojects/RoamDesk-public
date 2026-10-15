import Foundation
import Observation

struct QueuedUtterance: Codable, Equatable, Identifiable {
    let id: String
    let text: String
    let source: String
    let queuedAt: Int64
}

/// Utterances made while the PC was unreachable. Kept on disk for `ttlMs` (30 min), then dropped.
/// Confirmations are never queued here (PROTOCOL.md, Spoken confirmation flow, step 5).
@MainActor
@Observable
final class OfflineQueue {
    private let fileURL: URL
    private let ttlMs: Int64
    private let clock: () -> Int64
    private var items: [QueuedUtterance]

    private(set) var count = 0

    init(fileURL: URL, ttlMs: Int64 = 30 * 60_000, clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.fileURL = fileURL
        self.ttlMs = ttlMs
        self.clock = clock
        if let d = try? Data(contentsOf: fileURL), let list = try? JSONDecoder().decode([QueuedUtterance].self, from: d) {
            items = list
        } else {
            items = []
        }
        purge()
        count = items.count
    }

    static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("offline-queue.json")
    }

    func add(_ item: QueuedUtterance) {
        items.append(item)
        purge()
        save()
    }

    /// Non-expired items, oldest first. Expired ones are removed.
    func pending() -> [QueuedUtterance] {
        if purge() { save() } else { count = items.count }
        return items
    }

    func remove(id: String) {
        let before = items.count
        items.removeAll { $0.id == id }
        if items.count != before { save() }
    }

    func clear() {
        items.removeAll()
        save()
    }

    @discardableResult
    private func purge() -> Bool {
        let now = clock()
        let before = items.count
        items.removeAll { now - $0.queuedAt > ttlMs }
        return items.count != before
    }

    private func save() {
        count = items.count
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(items) { try? d.write(to: fileURL, options: .atomic) }
    }
}
