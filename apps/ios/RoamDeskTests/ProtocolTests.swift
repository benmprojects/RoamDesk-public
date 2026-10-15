import XCTest
@testable import RoamDesk

final class AuthMacTests: XCTestCase {
    // Bytes 0x00..0x1f and 0xff..0xe0, base64url without padding (as Node's Buffer#toString("base64url") emits).
    private let secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    private let nonce = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA"
    private let deviceId = "dev_test01"

    func testMacMatchesVectorComputedIndependentlyWithNode() {
        // node -e 'crypto.createHmac("sha256", Buffer.from(secret,"base64url")).update(nonce+"|"+deviceId).digest("base64url")'
        XCTAssertEqual(AuthMac.compute(deviceSecret: secret, nonce: nonce, deviceId: deviceId), "A2_0IS7sW00JxAtS9CMFHs2b8WBvdpk0OPsUKjclcN0")
    }

    func testMacHasNoPaddingAnd43Chars() {
        let a = AuthMac.compute(deviceSecret: secret, nonce: nonce, deviceId: deviceId)!
        XCTAssertFalse(a.contains("=") || a.contains("+") || a.contains("/"))
        XCTAssertEqual(a.count, 43)
    }

    func testPaddedOrStandardBase64SecretDecodesToSameKey() {
        let standard = secret.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let base = AuthMac.compute(deviceSecret: secret, nonce: nonce, deviceId: deviceId)
        XCTAssertEqual(base, AuthMac.compute(deviceSecret: secret + "=", nonce: nonce, deviceId: deviceId))
        XCTAssertEqual(base, AuthMac.compute(deviceSecret: standard, nonce: nonce, deviceId: deviceId))
    }

    func testMacChangesWithNonceAndDevice() {
        let base = AuthMac.compute(deviceSecret: secret, nonce: nonce, deviceId: deviceId)
        XCTAssertNotEqual(base, AuthMac.compute(deviceSecret: secret, nonce: nonce + "x", deviceId: deviceId))
        XCTAssertNotEqual(base, AuthMac.compute(deviceSecret: secret, nonce: nonce, deviceId: "dev_other"))
    }

    func testHmacMatchesRFC4231Case2() {
        let mac = AuthMac.hmac(Data("Jefe".utf8), "what do ya want for nothing?")
        let hex = mac.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    }

    func testBase64UrlRoundTrip() {
        let bytes = Data((0..<32).map { UInt8($0) })
        XCTAssertEqual(Base64Url.encode(bytes), secret)
        XCTAssertEqual(Base64Url.decode(secret), bytes)
    }

    func testConstantTimeCompare() {
        XCTAssertTrue(AuthMac.matches("abc", "abc"))
        XCTAssertFalse(AuthMac.matches("abc", "abd"))
        XCTAssertFalse(AuthMac.matches("abc", "abcd"))
    }
}

final class ProtocolCodecTests: XCTestCase {
    private func envelope(_ msg: PhoneMessage) -> [String: Any] {
        let text = ProtocolCodec.encodePhone(msg, id: "id-1", ts: 1_760_000_000_000)
        return (try! JSONSerialization.jsonObject(with: Data(text.utf8))) as! [String: Any]
    }

    func testPhoneFramesCarryEnvelopeAndNeverSeq() {
        let env = envelope(.utterance(text: "check disk space"))
        XCTAssertEqual(env["v"] as? Int, 1)
        XCTAssertEqual(env["type"] as? String, "utterance")
        XCTAssertEqual(env["id"] as? String, "id-1")
        XCTAssertEqual((env["ts"] as? NSNumber)?.int64Value, 1_760_000_000_000)
        XCTAssertNil(env["seq"])
        let p = env["payload"] as! [String: Any]
        XCTAssertEqual(p["text"] as? String, "check disk space")
        XCTAssertEqual(p["source"] as? String, "voice")
    }

    func testOptionalFieldsAreOmittedNotNull() {
        let text = ProtocolCodec.encodePhone(.utterance(text: "hi"))
        XCTAssertFalse(text.contains("sessionId"))
        XCTAssertFalse(text.contains("queuedAt"))
        XCTAssertFalse(text.contains("null"))
        XCTAssertTrue(ProtocolCodec.encodePhone(.kill).contains("\"payload\":{}"))
    }

    func testAuthResponseWireShape() {
        let p = envelope(.authResponse(deviceId: "dev_1", mac: "abc", lastSeq: 7, phoneNonce: "pn"))["payload"] as! [String: Any]
        XCTAssertEqual(p["deviceId"] as? String, "dev_1")
        XCTAssertEqual(p["mac"] as? String, "abc")
        XCTAssertEqual((p["lastSeq"] as? NSNumber)?.int64Value, 7)
        XCTAssertEqual(p["phoneNonce"] as? String, "pn")
    }

    func testTypeNames() {
        XCTAssertEqual(PhoneMessage.confirmResponse(confirmId: "c", decision: "confirm", heard: "h").type, "confirm.response")
        XCTAssertEqual(PhoneMessage.sessionAttach(claudeSessionId: "x").type, "session.attach")
        XCTAssertEqual(PhoneMessage.catalogList.type, "catalog.list")
        XCTAssertEqual(PhoneMessage.settingsSet(plainUpdates: true).type, "settings.set")
    }

    func testDecodeSpeakFrame() {
        let f = ProtocolCodec.decodeHelper(#"{"v":1,"type":"speak","id":"a","ts":5,"seq":12,"payload":{"turnId":"t1","text":"Hello","priority":"interrupt","replay":true}}"#)!
        XCTAssertEqual(f.seq, 12)
        XCTAssertTrue(f.replay)
        guard case let .speak(turnId, text, priority) = f.message else { return XCTFail("not a speak frame") }
        XCTAssertEqual(turnId, "t1")
        XCTAssertEqual(text, "Hello")
        XCTAssertEqual(priority, .interrupt)
    }

    func testDecodeAuthOkWithSessions() {
        let f = ProtocolCodec.decodeHelper(#"{"v":1,"type":"auth.ok","id":"a","ts":1,"payload":{"helperName":"PC","sessions":[{"id":"s1","name":"home","cwd":"C:\\x","model":"m","busy":true}],"activeSessionId":"s1","replayFrom":3,"disabled":false,"proof":"pp"}}"#)!
        guard case let .authOk(ok) = f.message else { return XCTFail("not auth.ok") }
        XCTAssertEqual(ok.helperName, "PC")
        XCTAssertEqual(ok.sessions, [Session(id: "s1", name: "home", cwd: "C:\\x", model: "m", busy: true)])
        XCTAssertEqual(ok.activeSessionId, "s1")
        XCTAssertEqual(ok.proof, "pp")
    }

    func testDecodeConfirmRequestDefaultsAndMissingFields() {
        let ok = ProtocolCodec.decodeHelper(#"{"v":1,"type":"confirm.request","id":"a","ts":1,"payload":{"confirmId":"c1","tier":2,"summary":"Delete files","phrase":"confirm delete"}}"#)!
        guard case let .confirmRequest(req) = ok.message else { return XCTFail("not confirm.request") }
        XCTAssertEqual(req.expiresInS, 45)
        XCTAssertEqual(req.command, "")
        let bad = ProtocolCodec.decodeHelper(#"{"v":1,"type":"confirm.request","id":"a","ts":1,"payload":{"confirmId":"c1"}}"#)!
        guard case let .unknown(type, malformed) = bad.message else { return XCTFail("should be malformed") }
        XCTAssertEqual(type, "confirm.request")
        XCTAssertTrue(malformed)
    }

    func testUnknownTypesAreKeptSoSeqIsStillCounted() {
        let f = ProtocolCodec.decodeHelper(#"{"v":1,"type":"something.new","id":"a","ts":1,"seq":9,"payload":{}}"#)!
        XCTAssertEqual(f.seq, 9)
        guard case let .unknown(_, malformed) = f.message else { return XCTFail() }
        XCTAssertFalse(malformed)
    }

    func testNonJsonIsNil() {
        XCTAssertNil(ProtocolCodec.decodeHelper("not json"))
        XCTAssertNil(ProtocolCodec.decodeHelper(#"{"no":"type"}"#))
    }

    func testDecodeStatusAndFileOffer() {
        let s = ProtocolCodec.decodeHelper(#"{"type":"status","payload":{"busy":true,"queued":2,"skipConfirmations":true}}"#)!
        guard case let .status(st) = s.message else { return XCTFail() }
        XCTAssertTrue(st.busy); XCTAssertEqual(st.queued, 2); XCTAssertTrue(st.skipConfirmations); XCTAssertTrue(st.plainUpdates)
        let f = ProtocolCodec.decodeHelper(#"{"type":"file","payload":{"fileId":"f_1","name":"a.pdf","size":10,"access":"tok"}}"#)!
        guard case let .fileOffer(o) = f.message else { return XCTFail() }
        XCTAssertEqual(o.mime, "application/octet-stream"); XCTAssertEqual(o.access, "tok")
    }
}

final class PairQrTests: XCTestCase {
    private func json(secureHost: String = "pc.tail123.ts.net", hosts: String = #"["100.75.182.13"]"#, extra: String = "") -> String {
        #"{"v":1,"kind":"claude-anywhere-pair","name":"PC","hosts":\#(hosts),"port":8787,"code":"abc","exp":1760000300,"secureHost":"\#(secureHost)","securePort":8443\#(extra)}"#
    }

    func testParsesAValidCode() throws {
        let qr = try PairQr.parse(json())
        XCTAssertEqual(qr.secureHost, "pc.tail123.ts.net")
        XCTAssertEqual(qr.securePort, 8443)
        XCTAssertEqual(qr.hosts, ["100.75.182.13"])
    }

    func testRefusesAddressesOutsideTailscale() {
        XCTAssertThrowsError(try PairQr.parse(json(secureHost: "evil.example.com")))
        XCTAssertThrowsError(try PairQr.parse(json(secureHost: "", hosts: #"["192.168.1.5"]"#)))
        XCTAssertThrowsError(try PairQr.parse(json(secureHost: "", hosts: #"["8.8.8.8"]"#)))
    }

    func testDropsNonTailnetHostsButKeepsTheRest() throws {
        let qr = try PairQr.parse(json(hosts: #"["192.168.1.5","100.100.1.1"]"#))
        XCTAssertEqual(qr.hosts, ["100.100.1.1"])
    }

    func testRejectsWrongKindVersionAndGarbage() {
        XCTAssertThrowsError(try PairQr.parse("hello"))
        XCTAssertThrowsError(try PairQr.parse(json().replacingOccurrences(of: "claude-anywhere-pair", with: "other")))
        XCTAssertThrowsError(try PairQr.parse(json().replacingOccurrences(of: #""v":1"#, with: #""v":2"#)))
        XCTAssertThrowsError(try PairQr.parse(json().replacingOccurrences(of: #""code":"abc""#, with: #""code":"""#)))
    }

    func testTailnetHostRules() {
        XCTAssertTrue(TailnetHost.isAllowed("100.64.0.1"))
        XCTAssertTrue(TailnetHost.isAllowed("100.127.255.254"))
        XCTAssertFalse(TailnetHost.isAllowed("100.128.0.1"))
        XCTAssertFalse(TailnetHost.isAllowed("10.0.0.1"))
        XCTAssertTrue(TailnetHost.isAllowed("my-pc"))
        XCTAssertTrue(TailnetHost.isAllowed("pc.tail955fb.ts.net"))
        XCTAssertTrue(TailnetHost.isAllowed("fd7a:115c:a1e0::1"))
        XCTAssertFalse(TailnetHost.isAllowed("example.com"))
    }
}
