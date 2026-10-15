import Foundation

/// What the big ring shows. One word each.
enum DrivePhase: String {
    case idle = "Ready"
    case listening = "Listening"
    case thinking = "Thinking"
    case speaking = "Speaking"
    case confirming = "Confirm"
    case offline = "Offline"
}

enum LinkStatus { case notPaired, offline, connecting, online, rejected }

struct ConversationItem: Identifiable, Equatable {
    enum Kind { case user, progress, reply, system, error, file }

    let id: Int
    var kind: Kind
    var text: String
    var turnId: String?
    var ts: Int64
    /// Set for `.file`: a file Claude sent to the phone.
    var file: FileOffer?
}

struct PendingConfirm: Equatable {
    let request: ConfirmRequest
    let deadline: Date
}

struct Notice: Equatable {
    let id: Int
    let text: String
}

enum EndReason { case user, idle, serviceStopped, unpaired }

/// A restartable background job whose "is it still running" flag is safe against a newer job replacing it.
@MainActor
final class JobSlot {
    private var task: Task<Void, Never>?
    private var generation = 0
    private(set) var running = false

    /// Starts `body`, cancelling any job already in the slot. `onDone` runs when the body returns, cancelled or not.
    func start(_ body: @escaping @MainActor () async -> Void, onDone: (@MainActor () -> Void)? = nil) {
        task?.cancel()
        generation += 1
        let g = generation
        running = true
        task = Task { @MainActor [weak self] in
            await body()
            if let self, self.generation == g {
                self.running = false
                self.task = nil
            }
            onDone?()
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        running = false
        generation += 1
    }
}

/// Runs `body` but gives up (returns nil) after `seconds`.
@MainActor
func withDeadline<T: Sendable>(_ seconds: TimeInterval, _ body: @escaping @MainActor () async -> T?) async -> T? {
    await withTaskGroup(of: T?.self) { group in
        group.addTask { @MainActor in await body() }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            return nil
        }
        let first: T?? = await group.next()
        group.cancelAll()
        return first ?? nil
    }
}
