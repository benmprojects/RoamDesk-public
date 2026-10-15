import Foundation
import Observation

enum FileState: Equatable {
    /// Offered but not downloaded (a large file, or not connected right now).
    case waiting
    case downloading(bytes: Int64, total: Int64)
    case ready(URL)
    case failed(String)
}

/// Files Claude sends to the phone: downloads them from the helper into app storage so they can be opened or shared.
@MainActor
@Observable
final class FileInbox {
    static let autoDownloadMaxBytes: Int64 = 25 * 1024 * 1024
    /// The PC refuses anything over 200 MB; a little headroom for rounding.
    static let maxDownloadBytes: Int64 = 210 * 1024 * 1024

    private(set) var states: [String: FileState] = [:]

    private let connection: HelperConnection
    private let dir: URL
    private var offers: [String: FileOffer] = [:]
    private var jobs: [String: Task<Void, Never>] = [:]
    private let session: URLSession

    init(connection: HelperConnection) {
        self.connection = connection
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("received", isDirectory: true)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 600
        session = URLSession(configuration: cfg)
        cleanOld()
    }

    /// Called for every file frame, live or replayed. Safe to call twice for the same file.
    func receive(_ o: FileOffer) {
        // The id becomes a folder name: anything but a plain token (e.g. "../x") is refused.
        guard o.fileId.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else { return }
        guard offers[o.fileId] == nil else { return }
        offers[o.fileId] = o
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        if let have = localFile(o) {
            states[o.fileId] = .ready(have)
        } else if o.expiresAt > 0 && o.expiresAt < nowMs {
            states[o.fileId] = .failed("This file has expired on your PC.")
        } else if o.size <= Self.autoDownloadMaxBytes {
            download(o.fileId)
        } else {
            states[o.fileId] = .waiting
        }
    }

    func download(_ fileId: String) {
        guard let o = offers[fileId], jobs[fileId] == nil else { return }
        jobs[fileId] = Task { [weak self] in
            await self?.run(o)
            self?.jobs[fileId] = nil
        }
    }

    private func run(_ o: FileOffer) async {
        guard case let .connected(_, _, endpoint) = connection.state else {
            states[o.fileId] = .failed("Not connected to your PC. Try again when it's online.")
            return
        }
        states[o.fileId] = .downloading(bytes: 0, total: o.size)
        // Same route as the live connection: https on the encrypted link, http on a plain Tailscale address.
        guard let url = endpoint.httpURL(path: "/file/\(o.fileId)", query: [URLQueryItem(name: "a", value: o.access)]) else {
            states[o.fileId] = .failed("Bad address for the file.")
            return
        }
        do {
            let (tmp, resp) = try await session.download(from: url)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else {
                states[o.fileId] = .failed(code == 404 ? "Your PC no longer has this file." : "Your PC answered \(code).")
                return
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? Int64) ?? 0
            let limit = o.size > 0 ? min(o.size, Self.maxDownloadBytes) : Self.maxDownloadBytes
            guard size <= limit else { throw CocoaError(.fileReadTooLarge) }
            let target = dir.appendingPathComponent(o.fileId, isDirectory: true).appendingPathComponent(Self.safeName(o.name))
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: tmp, to: target)
            states[o.fileId] = .ready(target)
        } catch is CancellationError {
            states[o.fileId] = .waiting
        } catch {
            states[o.fileId] = .failed("Download failed (\(error.localizedDescription)). Tap Retry.")
        }
    }

    func offer(_ id: String) -> FileOffer? { offers[id] }

    private func localFile(_ o: FileOffer) -> URL? {
        let u = dir.appendingPathComponent(o.fileId, isDirectory: true).appendingPathComponent(Self.safeName(o.name))
        guard let size = (try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? Int64 else { return nil }
        return o.size <= 0 || size == o.size ? u : nil
    }

    private func cleanOld() {
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        let fm = FileManager.default
        for d in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            let m = (try? d.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
            if m < cutoff { try? fm.removeItem(at: d) }
        }
    }

    static func safeName(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let cleaned = String(name.unicodeScalars.map { bad.contains($0) ? "_" : Character($0) }).trimmingCharacters(in: .whitespaces)
        let cut = String(cleaned.prefix(120))
        return cut.isEmpty || cut.allSatisfy({ $0 == "." }) ? "file" : cut
    }
}
