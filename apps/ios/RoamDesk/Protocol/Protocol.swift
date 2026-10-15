import Foundation

/// Swift mirror of packages/protocol (wire protocol v1). See packages/protocol/PROTOCOL.md.
/// Decoding is deliberately tolerant: missing fields take defaults and unknown types are ignored, as the spec requires.
let protocolVersion = 1
let defaultPort = 8787

// MARK: - Tolerant JSON access

struct JSONObj {
    let raw: [String: Any]
    init(_ raw: [String: Any] = [:]) { self.raw = raw }

    func string(_ k: String, _ d: String = "") -> String { (raw[k] as? String) ?? d }
    func optString(_ k: String) -> String? { raw[k] as? String }
    func int(_ k: String, _ d: Int = 0) -> Int { (raw[k] as? NSNumber)?.intValue ?? d }
    func int64(_ k: String, _ d: Int64 = 0) -> Int64 { (raw[k] as? NSNumber)?.int64Value ?? d }
    func double(_ k: String, _ d: Double = 0) -> Double { (raw[k] as? NSNumber)?.doubleValue ?? d }
    func bool(_ k: String, _ d: Bool = false) -> Bool {
        if let n = raw[k] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
        return d
    }
    func objects(_ k: String) -> [JSONObj] { (raw[k] as? [[String: Any]])?.map(JSONObj.init) ?? [] }
}

struct Session: Equatable, Identifiable {
    var id: String
    var name = ""
    var cwd = ""
    var model = ""
    var busy = false
    var claudeSessionId: String?

    init(id: String, name: String = "", cwd: String = "", model: String = "", busy: Bool = false, claudeSessionId: String? = nil) {
        self.id = id; self.name = name; self.cwd = cwd; self.model = model; self.busy = busy; self.claudeSessionId = claudeSessionId
    }
    init?(_ j: JSONObj) {
        guard let id = j.optString("id") else { return nil }
        self.init(id: id, name: j.string("name"), cwd: j.string("cwd"), model: j.string("model"), busy: j.bool("busy"), claudeSessionId: j.optString("claudeSessionId"))
    }
}

/// An existing Claude Code session on the PC that the phone can continue (hand-off).
struct CatalogItem: Equatable, Identifiable {
    var id: String { claudeSessionId }
    var claudeSessionId: String
    var title = ""
    var project = ""
    var cwd = ""
    /// "desktop" | "terminal" | "phone" | "other"
    var origin = "other"
    /// Epoch ms.
    var lastActiveAt: Double = 0
    var activeRecently = false
    var attachedSessionId: String?

    init?(_ j: JSONObj) {
        guard let id = j.optString("claudeSessionId") else { return nil }
        claudeSessionId = id
        title = j.string("title"); project = j.string("project"); cwd = j.string("cwd")
        origin = j.string("origin", "other")
        lastActiveAt = j.double("lastActiveAt")
        activeRecently = j.bool("activeRecently")
        attachedSessionId = j.optString("attachedSessionId")
    }
}

// MARK: - Pairing (HTTP)

struct PairQr: Equatable {
    static let kind = "claude-anywhere-pair"

    var name = ""
    var hosts: [String]
    var port = defaultPort
    var code: String
    var exp: Int64 = 0
    /// The PC's .ts.net name for the encrypted link (tailscale serve), when it has one.
    var secureHost = ""
    var securePort = 443

    struct Invalid: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Parses and validates QR / pasted pairing JSON. Throws `Invalid` with a user-facing message.
    static func parse(_ text: String, allowPlain: Bool = AppConfig.allowPlainLink) throws -> PairQr {
        guard let data = text.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { throw Invalid(message: "That isn't a Roam Desk pairing code.") }
        let j = JSONObj(obj)
        guard j.string("kind") == kind else { throw Invalid(message: "That QR code isn't from the Roam Desk helper.") }
        let v = j.int("v", -1)
        guard v == protocolVersion else { throw Invalid(message: "This helper uses protocol v\(v); this app speaks v\(protocolVersion).") }
        let code = j.string("code")
        guard !code.trimmingCharacters(in: .whitespaces).isEmpty else { throw Invalid(message: "The pairing code is missing its one-time code.") }
        let port = j.int("port", defaultPort), securePort = j.int("securePort", 443)
        guard (1...65535).contains(port), (1...65535).contains(securePort) else { throw Invalid(message: "The pairing code has an invalid port.") }
        let secure = j.string("secureHost").trimmingCharacters(in: .whitespaces).lowercased()
        let offTailnet = Invalid(message: "That pairing code points somewhere other than your Tailscale network, so it wasn't used.")
        if !secure.isEmpty {
            guard secure.hasSuffix(".ts.net"), TailnetHost.isAllowed(secure) else { throw offTailnet }
        }
        let rawHosts = (obj["hosts"] as? [String]) ?? []
        // Plain ws:// relies on Tailscale's own encryption, so only Tailscale addresses are kept.
        let tailnet = allowPlain ? rawHosts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && TailnetHost.isAllowed($0) } : []
        if !allowPlain && secure.isEmpty {
            throw Invalid(message: "Your PC's encrypted link isn't set up yet. Update the PC helper and switch on HTTPS certificates in Tailscale, then show a fresh QR code.")
        }
        guard !secure.isEmpty || !tailnet.isEmpty else { throw offTailnet }
        return PairQr(name: j.string("name"), hosts: tailnet, port: port, code: code, exp: j.int64("exp"), secureHost: secure, securePort: securePort)
    }
}

/// Addresses on a Tailscale network: 100.64.0.0/10, fd7a:115c:a1e0::/48, and MagicDNS names (short machine names
/// or names under .ts.net). Anything else, such as a home-network IP, is refused.
enum TailnetHost {
    static func isAllowed(_ host: String) -> Bool {
        var h = host.trimmingCharacters(in: .whitespaces).lowercased()
        if h.hasPrefix("[") { h.removeFirst() }
        if h.hasSuffix("]") { h.removeLast() }
        #if DEBUG
        if h == "127.0.0.1" || h == "localhost" { return true }
        #endif
        if h.hasSuffix(".ts.net"), h.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil { return true }
        if h.range(of: "^[a-z0-9][a-z0-9-]{0,62}$", options: .regularExpression) != nil, h != "localhost" { return true } // MagicDNS short name
        if h.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let n = parts.compactMap { Int($0) }
        guard n.count == 4, n.allSatisfy({ (0...255).contains($0) }) else { return false }
        return n[0] == 100 && (64...127).contains(n[1])
    }
}

// MARK: - PC → phone

enum SpeakPriority {
    case normal, low, interrupt
    init(_ s: String?) {
        switch s {
        case "interrupt": self = .interrupt
        case "low": self = .low
        default: self = .normal
        }
    }
}

enum Decision {
    static let confirm = "confirm"
    static let cancel = "cancel"
    static let timeout = "timeout"
}

struct AuthOk: Equatable {
    var helperName = ""
    var sessions: [Session] = []
    var activeSessionId: String?
    var replayFrom: Int64 = 0
    var disabled = false
    /// The PC's answer to our phoneNonce; proves it holds the pairing secret.
    var proof = ""
}

struct ConfirmRequest: Equatable {
    var confirmId: String
    var turnId = ""
    var tier: Int
    var summary: String
    var command = ""
    var phrase: String
    var expiresInS = 45
}

struct FileOffer: Equatable {
    var fileId: String
    var turnId: String?
    var name: String
    var size: Int64 = 0
    var mime = "application/octet-stream"
    var caption = ""
    var access: String
    var expiresAt: Int64 = 0
}

struct HelperStatus: Equatable {
    var busy = false
    var queued = 0
    var disabled = false
    var skipConfirmations = false
    var plainUpdates = true
}

struct HistoryItem: Equatable {
    var role = "assistant"
    var text = ""
    var ts: Int64 = 0
}

enum HelperMessage {
    case authChallenge(nonce: String, helperId: String)
    case authOk(AuthOk)
    case authFail(reason: String)
    case turnStarted(turnId: String, sessionId: String, text: String)
    case replyDelta(turnId: String, text: String)
    case turnProgress(turnId: String, label: String)
    case speak(turnId: String?, text: String, priority: SpeakPriority)
    case turnDone(turnId: String, text: String, durationMs: Int64)
    case turnFailed(turnId: String, error: String)
    case confirmRequest(ConfirmRequest)
    case confirmResolved(confirmId: String, decision: String, by: String)
    case sessionList(sessions: [Session], activeSessionId: String?)
    case catalog([CatalogItem])
    case history(sessionId: String, items: [HistoryItem])
    case fileOffer(FileOffer)
    case status(HelperStatus)
    case error(code: String, message: String)
    case pong
    /// Unknown type (ignored per spec) or a known type whose payload didn't parse.
    case unknown(type: String, malformed: Bool)
}

struct HelperFrame {
    var type: String
    var id: String
    var ts: Int64
    var seq: Int64?
    var replay: Bool
    var message: HelperMessage
}

// MARK: - Phone → PC

enum PhoneMessage {
    static let sourceVoice = "voice"
    static let sourceTyped = "typed"

    case authResponse(deviceId: String, mac: String, lastSeq: Int64, phoneNonce: String)
    case utterance(text: String, sessionId: String? = nil, source: String = PhoneMessage.sourceVoice, queuedAt: Int64? = nil)
    case confirmResponse(confirmId: String, decision: String, heard: String)
    case turnCancel(turnId: String?)
    case kill
    case sessionNew(name: String, cwd: String? = nil)
    case sessionSelect(sessionId: String)
    case sessionReset(sessionId: String?)
    case catalogList
    case historyGet(sessionId: String? = nil, limit: Int? = nil)
    case sessionAttach(claudeSessionId: String)
    case sessionRelease(sessionId: String)
    case settingsSet(skipConfirmations: Bool? = nil, plainUpdates: Bool? = nil)
    case ack(seq: Int64)
    case ping

    var type: String {
        switch self {
        case .authResponse: return "auth.response"
        case .utterance: return "utterance"
        case .confirmResponse: return "confirm.response"
        case .turnCancel: return "turn.cancel"
        case .kill: return "kill"
        case .sessionNew: return "session.new"
        case .sessionSelect: return "session.select"
        case .sessionReset: return "session.reset"
        case .catalogList: return "catalog.list"
        case .historyGet: return "history.get"
        case .sessionAttach: return "session.attach"
        case .sessionRelease: return "session.release"
        case .settingsSet: return "settings.set"
        case .ack: return "ack"
        case .ping: return "ping"
        }
    }

    /// Optional fields are omitted, never sent as null.
    var payload: [String: Any] {
        var p: [String: Any] = [:]
        switch self {
        case let .authResponse(deviceId, mac, lastSeq, phoneNonce):
            p = ["deviceId": deviceId, "mac": mac, "lastSeq": lastSeq, "phoneNonce": phoneNonce]
        case let .utterance(text, sessionId, source, queuedAt):
            p = ["text": text, "source": source]
            if let sessionId { p["sessionId"] = sessionId }
            if let queuedAt { p["queuedAt"] = queuedAt }
        case let .confirmResponse(confirmId, decision, heard):
            p = ["confirmId": confirmId, "decision": decision, "heard": heard]
        case let .turnCancel(turnId):
            if let turnId { p["turnId"] = turnId }
        case let .sessionNew(name, cwd):
            p = ["name": name]
            if let cwd { p["cwd"] = cwd }
        case let .sessionSelect(sessionId): p = ["sessionId": sessionId]
        case let .sessionReset(sessionId): if let sessionId { p["sessionId"] = sessionId }
        case let .historyGet(sessionId, limit):
            if let sessionId { p["sessionId"] = sessionId }
            if let limit { p["limit"] = limit }
        case let .sessionAttach(id): p = ["claudeSessionId": id]
        case let .sessionRelease(id): p = ["sessionId": id]
        case let .settingsSet(skip, plain):
            if let skip { p["skipConfirmations"] = skip }
            if let plain { p["plainUpdates"] = plain }
        case let .ack(seq): p = ["seq": seq]
        case .kill, .catalogList, .ping: break
        }
        return p
    }
}

// MARK: - Codec

enum ProtocolCodec {
    static func newId() -> String { UUID().uuidString.lowercased() }
    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// One JSON text frame. Phone → PC frames never carry seq.
    static func encodePhone(_ msg: PhoneMessage, id: String = newId(), ts: Int64 = nowMs()) -> String {
        let env: [String: Any] = ["v": protocolVersion, "type": msg.type, "id": id, "ts": ts, "payload": msg.payload]
        let data = (try? JSONSerialization.data(withJSONObject: env, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Decodes one PC → phone frame. Returns nil only if the text isn't a JSON envelope at all.
    /// Unknown types become `.unknown` so the caller can still account for `seq`, then ignore them.
    static func decodeHelper(_ text: String) -> HelperFrame? {
        guard let data = text.data(using: .utf8),
              let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = env["type"] as? String
        else { return nil }
        let payload = JSONObj((env["payload"] as? [String: Any]) ?? [:])
        let seq = (env["seq"] as? NSNumber)?.int64Value
        let replay = payload.bool("replay")
        let message = decodePayload(type, payload)
        return HelperFrame(
            type: type,
            id: (env["id"] as? String) ?? "",
            ts: (env["ts"] as? NSNumber)?.int64Value ?? 0,
            seq: seq, replay: replay, message: message
        )
    }

    private static func decodePayload(_ type: String, _ p: JSONObj) -> HelperMessage {
        func need(_ keys: String...) -> Bool { keys.allSatisfy { p.raw[$0] != nil } }
        switch type {
        case "auth.challenge":
            guard need("nonce") else { return .unknown(type: type, malformed: true) }
            return .authChallenge(nonce: p.string("nonce"), helperId: p.string("helperId"))
        case "auth.ok":
            return .authOk(AuthOk(
                helperName: p.string("helperName"),
                sessions: p.objects("sessions").compactMap(Session.init),
                activeSessionId: p.optString("activeSessionId"),
                replayFrom: p.int64("replayFrom"),
                disabled: p.bool("disabled"),
                proof: p.string("proof")
            ))
        case "auth.fail": return .authFail(reason: p.string("reason"))
        case "turn.started":
            guard need("turnId") else { return .unknown(type: type, malformed: true) }
            return .turnStarted(turnId: p.string("turnId"), sessionId: p.string("sessionId"), text: p.string("text"))
        case "reply.delta":
            guard need("turnId", "text") else { return .unknown(type: type, malformed: true) }
            return .replyDelta(turnId: p.string("turnId"), text: p.string("text"))
        case "turn.progress":
            guard need("turnId", "label") else { return .unknown(type: type, malformed: true) }
            return .turnProgress(turnId: p.string("turnId"), label: p.string("label"))
        case "speak":
            guard need("text") else { return .unknown(type: type, malformed: true) }
            return .speak(turnId: p.optString("turnId"), text: p.string("text"), priority: SpeakPriority(p.optString("priority")))
        case "turn.done":
            guard need("turnId") else { return .unknown(type: type, malformed: true) }
            return .turnDone(turnId: p.string("turnId"), text: p.string("text"), durationMs: p.int64("durationMs"))
        case "turn.failed":
            guard need("turnId") else { return .unknown(type: type, malformed: true) }
            return .turnFailed(turnId: p.string("turnId"), error: p.string("error"))
        case "confirm.request":
            guard need("confirmId", "tier", "summary", "phrase") else { return .unknown(type: type, malformed: true) }
            return .confirmRequest(ConfirmRequest(
                confirmId: p.string("confirmId"), turnId: p.string("turnId"), tier: p.int("tier"),
                summary: p.string("summary"), command: p.string("command"), phrase: p.string("phrase"),
                expiresInS: p.int("expiresInS", 45)
            ))
        case "confirm.resolved":
            guard need("confirmId", "decision") else { return .unknown(type: type, malformed: true) }
            return .confirmResolved(confirmId: p.string("confirmId"), decision: p.string("decision"), by: p.string("by", "server"))
        case "session.list":
            return .sessionList(sessions: p.objects("sessions").compactMap(Session.init), activeSessionId: p.optString("activeSessionId"))
        case "catalog":
            return .catalog(p.objects("items").compactMap(CatalogItem.init))
        case "history":
            let items = p.objects("items").map { HistoryItem(role: $0.string("role", "assistant"), text: $0.string("text"), ts: $0.int64("ts")) }
            return .history(sessionId: p.string("sessionId"), items: items)
        case "file":
            guard need("fileId", "name", "access") else { return .unknown(type: type, malformed: true) }
            return .fileOffer(FileOffer(
                fileId: p.string("fileId"), turnId: p.optString("turnId"), name: p.string("name"), size: p.int64("size"),
                mime: p.string("mime", "application/octet-stream"), caption: p.string("caption"),
                access: p.string("access"), expiresAt: p.int64("expiresAt")
            ))
        case "status":
            return .status(HelperStatus(
                busy: p.bool("busy"), queued: p.int("queued"), disabled: p.bool("disabled"),
                skipConfirmations: p.bool("skipConfirmations"), plainUpdates: p.bool("plainUpdates", true)
            ))
        case "error": return .error(code: p.string("code"), message: p.string("message"))
        case "pong": return .pong
        default: return .unknown(type: type, malformed: false)
        }
    }
}
