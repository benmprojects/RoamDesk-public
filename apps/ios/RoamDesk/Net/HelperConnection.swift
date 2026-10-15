import Foundation
import Observation
import os

/// WebSocket link to the desktop helper (PROTOCOL.md "Connect and authenticate").
///
/// Runs only while something holds it (the visible UI or a Drive session) and the phone is paired.
/// Handles challenge/response auth, lastSeq persistence, acks (at most one a second), 15 s pings, a dead-socket
/// watchdog, reconnect with exponential backoff and jitter (cap 30 s) and failover across the paired addresses.
@MainActor
@Observable
final class HelperConnection {
    enum State: Equatable {
        case notPaired
        case stopped
        case connecting(host: String)
        /// `endpoint` is how we reached the PC; downloads use the same scheme, host and port.
        case connected(host: String, helperName: String, endpoint: Endpoint)
        case waiting(retryAt: Date, reason: String)
        case authFailed(reason: String)
    }

    private(set) var state: State = .stopped {
        didSet { if oldValue != state { onStateChange?() } }
    }

    /// Called whenever `state` changes, so the Drive model can notice a dropped connection.
    @ObservationIgnored var onStateChange: (() -> Void)?

    /// Every authenticated PC to phone frame, in order, duplicates (seq at or below lastSeq) removed. Includes auth.ok.
    @ObservationIgnored var onFrame: ((HelperFrame) -> Void)?

    private let settings: SettingsStore
    private let backoff = Backoff()
    private let log = Logger(subsystem: "au.com.roamdesk.ios", category: "HelperConnection")

    private var holds = Set<String>()
    private var loop: Task<Void, Never>?
    private var activeLink: WSLink?
    private var lastSeq: Int64 = 0
    private var kickRequested = false

    static let challengeTimeout: TimeInterval = 8
    static let authResultTimeout: TimeInterval = 10
    static let pingInterval: TimeInterval = 15
    static let ackInterval: TimeInterval = 1
    static let deadAfter: TimeInterval = 45

    init(settings: SettingsStore) {
        self.settings = settings
    }

    var isConnected: Bool {
        if case .connected = state { return true }
        return false
    }

    func acquire(_ tag: String) {
        holds.insert(tag)
        reevaluate()
    }

    func release(_ tag: String) {
        holds.remove(tag)
        reevaluate()
    }

    /// Call after pairing or unpairing.
    func pairingChanged() { reevaluate() }

    /// Skip the current backoff wait (the network came back, or the user tapped Retry).
    func reconnectNow() { kickRequested = true }

    /// Sends a frame if authenticated. False if it couldn't be handed to the socket.
    @discardableResult
    func send(_ msg: PhoneMessage) -> Bool {
        guard isConnected, let link = activeLink else { return false }
        return link.send(ProtocolCodec.encodePhone(msg))
    }

    private func reevaluate() {
        loop?.cancel()
        loop = nil
        activeLink?.close()
        activeLink = nil
        guard let pairing = settings.pairing else { state = .notPaired; return }
        if holds.isEmpty { state = .stopped; return }
        loop = Task { [weak self] in await self?.runLoop(pairing) }
    }

    // MARK: loop

    private enum Outcome { case connectFailed, wasConnected, authRejected }

    private func runLoop(_ stored: Pairing) async {
        // Plain ws:// is only safe inside Tailscale's encrypted network, so other stored addresses are never used.
        var pairing = stored
        pairing.hosts = stored.hosts.filter(TailnetHost.isAllowed)
        let endpoints = pairing.endpoints
        if endpoints.isEmpty {
            state = .authFailed(reason: AppConfig.allowPlainLink
                ? "No Tailscale addresses stored for your PC. Pair again."
                : "This phone was paired without the encrypted link. Show a fresh QR code on your PC and pair again.")
            return
        }
        lastSeq = settings.lastSeq
        var attempt = 0, hostIndex = 0, failedThisRound = 0, authRejections = 0
        while !Task.isCancelled {
            let ep = endpoints[hostIndex % endpoints.count]
            switch await runSocket(pairing, ep) {
            case .wasConnected:
                attempt = 0; failedThisRound = 0; authRejections = 0
            case .authRejected:
                authRejections += 1
                if authRejections >= 3 {
                    // Stop hammering the helper with bad credentials. Wait for a manual retry.
                    kickRequested = false
                    while !kickRequested && !Task.isCancelled { try? await Task.sleep(nanoseconds: 200_000_000) }
                    authRejections = 0; attempt = 0
                    continue
                }
            case .connectFailed:
                hostIndex += 1
                failedThisRound += 1
                if failedThisRound < endpoints.count { continue } // fail over to the next address immediately
                failedThisRound = 0
            }
            if Task.isCancelled { return }
            let waitMs = backoff.delayMs(attempt: attempt)
            attempt += 1
            let reason: String
            if case let .authFailed(r) = state { reason = r } else { reason = "Can't reach \(pairing.helperName.isEmpty ? "your PC" : pairing.helperName)" }
            if case .authFailed = state {} else { state = .waiting(retryAt: Date().addingTimeInterval(Double(waitMs) / 1000), reason: reason) }
            kickRequested = false
            var remaining = waitMs
            while remaining > 0 && !kickRequested && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 200_000_000)
                remaining -= 200
            }
        }
    }

    private func runSocket(_ pairing: Pairing, _ ep: Endpoint) async -> Outcome {
        let host = ep.host
        state = .connecting(host: host)
        guard let url = ep.wsURL else { return .connectFailed }
        let link = WSLink(url: url)
        activeLink = link
        var authenticated = false
        var pinger: Task<Void, Never>?
        var acker: Task<Void, Never>?
        defer {
            pinger?.cancel(); acker?.cancel()
            link.close()
            if activeLink === link { activeLink = nil }
            if authenticated {
                settings.lastSeq = lastSeq
                if case .connected = state { state = .waiting(retryAt: Date(), reason: "Connection lost") }
            }
            log.debug("socket to \(host, privacy: .public) ended (authenticated=\(authenticated))")
        }

        // 1. Wait for auth.challenge.
        var challenge: (nonce: String, helperId: String)?
        let challengeDeadline = Date().addingTimeInterval(Self.challengeTimeout)
        while challenge == nil {
            let left = challengeDeadline.timeIntervalSinceNow
            guard left > 0, let ev = await link.next(timeout: left) else { break }
            switch ev {
            case .open: continue
            case let .closed(reason):
                // The encrypted link refuses Tailscale accounts other than the PC owner's.
                if reason == WSLink.forbidden {
                    state = .authFailed(reason: "Your PC only accepts its owner's Tailscale account. Sign this phone in to Tailscale with the same account as the PC.")
                }
            case let .text(t):
                if let f = ProtocolCodec.decodeHelper(t), case let .authChallenge(nonce, helperId) = f.message { challenge = (nonce, helperId) }
                continue
            }
            break
        }
        guard let challenge else {
            if case .authFailed = state { return .authRejected }
            return .connectFailed
        }
        if !pairing.helperId.isEmpty && challenge.helperId != pairing.helperId {
            state = .authFailed(reason: "A different PC answered at \(host). Pair again if you've reinstalled the helper.")
            return .authRejected
        }

        // 2. Answer with the HMAC. The secret is read just for this and not kept.
        guard let secret = settings.deviceSecret() else {
            state = .authFailed(reason: "The stored pairing key can't be read. Pair again.")
            return .authRejected
        }
        // Our own challenge: the PC has to answer it with the pairing secret, so nothing else can pose as it.
        let phoneNonce = AuthMac.newNonce()
        let helperIdForProof = pairing.helperId.isEmpty ? challenge.helperId : pairing.helperId
        guard let mac = AuthMac.compute(deviceSecret: secret, nonce: challenge.nonce, deviceId: pairing.deviceId),
              let expectedProof = AuthMac.helperProof(deviceSecret: secret, phoneNonce: phoneNonce, nonce: challenge.nonce, deviceId: pairing.deviceId, helperId: helperIdForProof)
        else {
            state = .authFailed(reason: "The stored pairing key can't be read. Pair again.")
            return .authRejected
        }
        link.send(ProtocolCodec.encodePhone(.authResponse(deviceId: pairing.deviceId, mac: mac, lastSeq: lastSeq, phoneNonce: phoneNonce)))

        // 3. auth.ok / auth.fail.
        var okFrame: HelperFrame?
        let authDeadline = Date().addingTimeInterval(Self.authResultTimeout)
        authLoop: while okFrame == nil {
            let left = authDeadline.timeIntervalSinceNow
            guard left > 0, let ev = await link.next(timeout: left) else { break }
            switch ev {
            case .open: continue
            case .closed: break authLoop
            case let .text(t):
                guard let f = ProtocolCodec.decodeHelper(t) else { continue }
                switch f.message {
                case .authOk: okFrame = f
                case let .authFail(reason):
                    state = .authFailed(reason: reason.isEmpty ? "Your PC rejected this phone." : reason)
                    break authLoop
                default: continue
                }
            }
        }
        guard let okFrame, case let .authOk(ok) = okFrame.message else {
            if case .authFailed = state { return .authRejected }
            return .connectFailed
        }
        guard AuthMac.matches(expectedProof, ok.proof) else {
            state = .authFailed(reason: "The PC at \(host) couldn't prove it's the one you paired with. Update the PC helper, or pair again.")
            return .authRejected
        }

        let helperName = ok.helperName.isEmpty ? pairing.helperName : ok.helperName
        authenticated = true
        state = .connected(host: host, helperName: helperName, endpoint: ep)
        onFrame?(okFrame)

        // 4. Live: pings, acks, watchdog, frames.
        var lastAcked = lastSeq
        pinger = Task { [weak self, weak link] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.pingInterval * 1_000_000_000))
                guard let self, let link, !Task.isCancelled else { return }
                link.send(ProtocolCodec.encodePhone(.ping))
                if Date().timeIntervalSince(self.lastReceivedAt) > Self.deadAfter { link.close() }
            }
        }
        acker = Task { [weak self, weak link] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.ackInterval * 1_000_000_000))
                guard let self, let link, !Task.isCancelled else { return }
                let s = self.lastSeq
                if s > lastAcked, link.send(ProtocolCodec.encodePhone(.ack(seq: s))) {
                    lastAcked = s
                    self.settings.lastSeq = s
                }
            }
        }
        lastReceivedAt = Date()
        while let ev = await link.next(timeout: nil) {
            switch ev {
            case .open: continue
            case .closed: return .wasConnected
            case let .text(t):
                lastReceivedAt = Date()
                guard let f = ProtocolCodec.decodeHelper(t) else { continue }
                if let seq = f.seq {
                    if seq <= lastSeq { continue } // already processed (replay overlap)
                    onFrame?(f)
                    lastSeq = seq
                } else {
                    onFrame?(f)
                }
            }
        }
        return .wasConnected
    }

    private var lastReceivedAt = Date()
}
