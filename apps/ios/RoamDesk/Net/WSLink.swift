import Foundation

/// One WebSocket to the helper, exposed as an ordered queue of events that can be awaited with a timeout.
@MainActor
final class WSLink: NSObject, URLSessionWebSocketDelegate {
    enum Event: Equatable {
        case open
        case text(String)
        case closed(String)
    }

    /// Reported as the close reason when the encrypted link refused our Tailscale account.
    static let forbidden = "\u{0}forbidden"

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var buffer: [Event] = []
    private var waiter: CheckedContinuation<Event?, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var receiver: Task<Void, Never>?
    private(set) var ended = false

    init(url: URL) {
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let t = s.webSocketTask(with: url)
        t.maximumMessageSize = 8 * 1024 * 1024
        session = s
        task = t
        t.resume()
        receiver = Task { [weak self] in
            while let self, !self.ended {
                guard let t = self.task else { return }
                do {
                    switch try await t.receive() {
                    case let .string(s): self.push(.text(s))
                    case let .data(d): if let s = String(data: d, encoding: .utf8) { self.push(.text(s)) }
                    @unknown default: break
                    }
                } catch {
                    let code = (t.response as? HTTPURLResponse)?.statusCode
                    self.push(.closed(code == 403 ? WSLink.forbidden : error.localizedDescription))
                    return
                }
            }
        }
    }

    /// The next event, or nil if `timeout` seconds pass first (or the waiting task is cancelled).
    func next(timeout: TimeInterval?) async -> Event? {
        if !buffer.isEmpty { return buffer.removeFirst() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<Event?, Never>) in
                if Task.isCancelled { cont.resume(returning: nil); return }
                waiter = cont
                if let timeout {
                    timeoutTask = Task { [weak self] in
                        try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                        self?.resolve(nil)
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resolve(nil) }
        }
    }

    /// Hands a text frame to the socket. False if the link has already ended.
    @discardableResult
    func send(_ text: String) -> Bool {
        guard !ended, let task else { return false }
        task.send(.string(text)) { _ in }
        return true
    }

    func close() {
        guard !ended else { return }
        ended = true
        task?.cancel(with: .goingAway, reason: nil)
        receiver?.cancel()
        session?.invalidateAndCancel()
        session = nil
        task = nil
        resolve(.closed("closed"))
    }

    private func resolve(_ e: Event?) {
        timeoutTask?.cancel()
        timeoutTask = nil
        if let w = waiter {
            waiter = nil
            w.resume(returning: e)
        }
    }

    private func push(_ e: Event) {
        if waiter != nil { resolve(e) } else { buffer.append(e) }
    }

    // MARK: URLSessionWebSocketDelegate (called on a background queue)

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor [weak self] in self?.push(.open) }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in self?.push(.closed("closed (\(closeCode.rawValue))")) }
    }
}
