import Foundation
import UIKit

enum PairResult: Equatable {
    case success(helperName: String)
    case failure(String)
}

/// PROTOCOL.md "Pairing": POST /pair to each address in turn; the secret goes straight into the Keychain.
@MainActor
final class PairingRepository {
    private let settings: SettingsStore
    private let queue: OfflineQueue
    private let session: URLSession

    init(settings: SettingsStore, queue: OfflineQueue) {
        self.settings = settings
        self.queue = queue
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 15
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)
    }

    func pair(qrJson: String) async -> PairResult {
        let qr: PairQr
        do { qr = try PairQr.parse(qrJson) } catch { return .failure(error.localizedDescription) }
        let body: [String: Any] = ["code": qr.code, "deviceName": UIDevice.current.name, "platform": "ios"]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return .failure("Couldn't build the pairing request.") }

        var lastProblem = "no answer"
        // The encrypted link first, then plain Tailscale addresses (parse() already filtered them).
        let probe = Pairing(deviceId: "", helperId: "", helperName: "", hosts: qr.hosts, port: qr.port, secureHost: qr.secureHost, securePort: qr.securePort)
        for ep in probe.endpoints {
            guard let url = ep.httpURL(path: "/pair") else { lastProblem = "bad address \(ep.host)"; continue }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            req.httpBody = bodyData
            do {
                let (data, resp) = try await session.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                switch code {
                case 200:
                    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                        return .failure("Your PC sent a pairing reply this app can't read.")
                    }
                    let j = JSONObj(obj)
                    let secret = j.string("deviceSecret"), deviceId = j.string("deviceId")
                    guard !deviceId.isEmpty, let bytes = Base64Url.decode(secret), bytes.count >= 16 else {
                        return .failure("Your PC sent a pairing reply this app can't read.")
                    }
                    let name = j.string("helperName").isEmpty ? qr.name : j.string("helperName")
                    // Put the plain host that answered first so a fallback reconnect is quick.
                    let hosts = ep.secure ? qr.hosts : [ep.host] + qr.hosts.filter { $0 != ep.host }
                    queue.clear()
                    settings.savePairing(
                        Pairing(deviceId: deviceId, helperId: j.string("helperId"), helperName: name, hosts: hosts, port: qr.port,
                                secureHost: qr.secureHost, securePort: qr.securePort),
                        secret: secret
                    )
                    return .success(helperName: name)
                case 401:
                    return .failure("Your PC rejected that code. It may have expired or already been used. Show a fresh QR code and try again.")
                case 403:
                    return .failure("Your PC only accepts its owner's Tailscale account. Sign this phone in to Tailscale with the same account as the PC.")
                default:
                    lastProblem = "HTTP \(code) from \(ep.host)"
                }
            } catch {
                lastProblem = "\((error as NSError).localizedDescription) on \(ep.host)"
            }
        }
        let who = qr.name.isEmpty ? "your PC" : qr.name
        return .failure("Couldn't reach \(who) (\(lastProblem)). Check Tailscale is on for both devices.")
    }

    func unpair() {
        settings.clearPairing()
        queue.clear()
    }
}
