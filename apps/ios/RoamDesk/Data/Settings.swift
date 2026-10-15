import Foundation
import Observation

/// A paired PC. The device secret itself lives in the Keychain, never here.
struct Pairing: Equatable, Codable {
    var deviceId: String
    var helperId: String
    var helperName: String
    var hosts: [String]
    var port: Int
    /// The PC's .ts.net name for the encrypted HTTPS link (tailscale serve); blank if it had none when paired.
    var secureHost: String = ""
    var securePort: Int = 443

    /// Where to connect, in order: the encrypted link first, then plain Tailscale addresses only if the build allows them.
    var endpoints: [Endpoint] {
        (secureHost.isEmpty ? [] : [Endpoint(host: secureHost, port: securePort, secure: true)])
            + (AppConfig.allowPlainLink ? hosts.map { Endpoint(host: $0, port: port, secure: false) } : [])
    }

    static var secretAccount: String { "deviceSecret" }
}

/// One way to reach the PC: wss/https when `secure`, else ws/http over the Tailscale address.
struct Endpoint: Equatable {
    var host: String
    var port: Int
    var secure: Bool

    private var urlHost: String { host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host }
    var wsURL: URL? { URL(string: "\(secure ? "wss" : "ws")://\(urlHost):\(port)/ws") }
    func httpURL(path: String, query: [URLQueryItem] = []) -> URL? {
        var c = URLComponents()
        c.scheme = secure ? "https" : "http"
        c.host = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
        c.port = port
        c.path = path
        if !query.isEmpty { c.queryItems = query }
        return c.url
    }
}

/// Everything the app remembers between launches, outside the Keychain.
@MainActor
@Observable
final class SettingsStore {
    static let idleTimeoutChoices = [10, 20, 30, 60]

    private let defaults: UserDefaults

    private(set) var pairing: Pairing?
    var speechRate: Double { didSet { defaults.set(speechRate, forKey: "speechRate") } }
    var idleTimeoutMin: Int { didSet { defaults.set(idleTimeoutMin, forKey: "idleTimeoutMin") } }
    var onboarded: Bool { didSet { defaults.set(onboarded, forKey: "onboarded") } }
    var keepScreenOn: Bool { didSet { defaults.set(keepScreenOn, forKey: "keepScreenOn") } }
    /// Identifier of the chosen voice; nil means automatic (best Australian English voice).
    var voiceId: String? { didSet { defaults.set(voiceId, forKey: "voiceId") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let d = defaults.data(forKey: "pairing"), let p = try? JSONDecoder().decode(Pairing.self, from: d),
           Keychain.get(Pairing.secretAccount) != nil {
            pairing = p
        }
        speechRate = defaults.object(forKey: "speechRate") as? Double ?? 1.0
        idleTimeoutMin = defaults.object(forKey: "idleTimeoutMin") as? Int ?? 30
        onboarded = defaults.bool(forKey: "onboarded")
        keepScreenOn = defaults.object(forKey: "keepScreenOn") as? Bool ?? true
        voiceId = defaults.string(forKey: "voiceId")
        #if DEBUG
        // Launch with `-demo YES` to see the screens with sample data and no PC (simulator screenshots).
        if defaults.bool(forKey: "demo") {
            pairing = Pairing(deviceId: "demo", helperId: "demo", helperName: "MY-PC", hosts: [], port: defaultPort, secureHost: "demo.ts.net")
            onboarded = true
        }
        #endif
    }

    func savePairing(_ p: Pairing, secret: String) {
        Keychain.set(secret, account: Pairing.secretAccount)
        defaults.set(try? JSONEncoder().encode(p), forKey: "pairing")
        defaults.set(0, forKey: "lastSeq")
        pairing = p
    }

    func clearPairing() {
        Keychain.delete(Pairing.secretAccount)
        defaults.removeObject(forKey: "pairing")
        defaults.removeObject(forKey: "lastSeq")
        pairing = nil
    }

    func deviceSecret() -> String? { Keychain.get(Pairing.secretAccount) }

    var lastSeq: Int64 {
        get { Int64(defaults.integer(forKey: "lastSeq")) }
        set { defaults.set(Int(newValue), forKey: "lastSeq") }
    }
}
