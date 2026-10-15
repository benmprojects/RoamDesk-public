import CryptoKit
import Foundation

/// base64url per RFC 4648 §5. Encodes without padding; decodes with or without padding (and tolerates standard base64).
enum Base64Url {
    static func encode(_ bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .replacingOccurrences(of: "=", with: "")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s)
    }
}

/// PROTOCOL.md "Connect and authenticate":
/// mac = base64url(HMAC-SHA256(key = base64url-decoded deviceSecret, message = UTF-8 of nonce + "|" + deviceId))
enum AuthMac {
    static func compute(deviceSecret: String, nonce: String, deviceId: String) -> String? {
        guard let key = Base64Url.decode(deviceSecret) else { return nil }
        return Base64Url.encode(hmac(key, "\(nonce)|\(deviceId)"))
    }

    /// What the PC must send back in auth.ok: HMAC(secret, "helper|phoneNonce|nonce|deviceId|helperId").
    static func helperProof(deviceSecret: String, phoneNonce: String, nonce: String, deviceId: String, helperId: String) -> String? {
        guard let key = Base64Url.decode(deviceSecret) else { return nil }
        return Base64Url.encode(hmac(key, "helper|\(phoneNonce)|\(nonce)|\(deviceId)|\(helperId)"))
    }

    /// Constant-time comparison of two base64url MACs.
    static func matches(_ expected: String, _ got: String) -> Bool {
        let a = Array(expected.utf8), b = Array(got.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    static func newNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Base64Url.encode(Data(bytes))
    }

    static func hmac(_ key: Data, _ message: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: key)))
    }
}
