package au.com.roamdesk.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolCodecTest {

    private fun roundTrip(msg: PhoneMessage): PhoneMessage? {
        val text = ProtocolCodec.encodePhone(msg, id = "id-1", ts = 1_760_000_000_000)
        val (env, decoded) = ProtocolCodec.decodePhone(text)
        assertEquals(1, env.v)
        assertEquals(msg.type, env.type)
        assertEquals("id-1", env.id)
        assertEquals(1_760_000_000_000, env.ts)
        assertNull("phone frames never carry seq", env.seq)
        assertFalse("seq must not be on the envelope", Wire.json.parseToJsonElement(text).jsonObject.containsKey("seq"))
        return decoded
    }

    @Test fun `every phone message round-trips`() {
        val all = listOf(
            PhoneMessage.AuthResponse("dev_1", "mac", 42),
            PhoneMessage.Utterance("check disk space", source = PhoneMessage.SOURCE_VOICE),
            PhoneMessage.Utterance("hi", sessionId = "s_1", source = PhoneMessage.SOURCE_TYPED, queuedAt = 1_759_999_000_000),
            PhoneMessage.ConfirmResponse("c_1", Decision.CONFIRM, "confirm delete"),
            PhoneMessage.TurnCancel(),
            PhoneMessage.TurnCancel("t_9"),
            PhoneMessage.Kill,
            PhoneMessage.SessionNew("home"),
            PhoneMessage.SessionSelect("s_2"),
            PhoneMessage.SessionReset(),
            PhoneMessage.CatalogList,
            PhoneMessage.SessionAttach("3378bb5d-a334-4a19-83ca-5cd2cae6e5f9"),
            PhoneMessage.Ack(7),
            PhoneMessage.Ping,
        )
        all.forEach { assertEquals(it, roundTrip(it)) }
    }

    @Test fun `optional fields are omitted, not null`() {
        val text = ProtocolCodec.encodePhone(PhoneMessage.Utterance("hi"))
        assertFalse(text.contains("sessionId"))
        assertFalse(text.contains("queuedAt"))
        assertFalse(text.contains("null"))
        val kill = ProtocolCodec.encodePhone(PhoneMessage.Kill)
        assertTrue(kill.contains("\"payload\":{}"))
    }

    @Test fun `auth response wire shape`() {
        val text = ProtocolCodec.encodePhone(PhoneMessage.AuthResponse("dev_1", "abc", 0), id = "x", ts = 1)
        val obj = Wire.json.parseToJsonElement(text).jsonObject
        assertEquals("auth.response", obj["type"]!!.jsonPrimitive.content)
        val p = obj["payload"]!!.jsonObject
        assertEquals("dev_1", p["deviceId"]!!.jsonPrimitive.content)
        assertEquals("abc", p["mac"]!!.jsonPrimitive.content)
        assertEquals(0L, p["lastSeq"]!!.jsonPrimitive.long)
    }

    @Test fun `confirm request from the spec example decodes`() {
        val text = """{"v":1,"type":"confirm.request","id":"a","ts":1760000000000,"seq":12,"payload":
            {"confirmId":"c_1","turnId":"t_9","tier":2,"summary":"Delete 4 log files in Downloads",
             "command":"Remove-Item C:\\Users\\ben\\Downloads\\*.log","phrase":"confirm delete","expiresInS":45}}"""
        val f = ProtocolCodec.decodeHelper(text)!!
        assertEquals(12L, f.seq)
        assertFalse(f.replay)
        val m = f.message as HelperMessage.ConfirmRequest
        assertEquals("c_1", m.confirmId)
        assertEquals(2, m.tier)
        assertEquals("Remove-Item C:\\Users\\ben\\Downloads\\*.log", m.command)
        assertEquals("confirm delete", m.phrase)
        assertEquals(45, m.expiresInS)
    }

    @Test fun `auth ok with sessions decodes`() {
        val text = """{"v":1,"type":"auth.ok","id":"b","ts":1,"payload":{"helperName":"my-pc",
            "sessions":[{"id":"s1","name":"home","cwd":"C:\\Users\\ben","model":"opus","busy":true}],
            "activeSessionId":"s1","replayFrom":5,"disabled":false}}"""
        val m = ProtocolCodec.decodeHelper(text)!!.message as HelperMessage.AuthOk
        assertEquals("my-pc", m.helperName)
        assertEquals(Session("s1", "home", "C:\\Users\\ben", "opus", true), m.sessions.single())
        assertEquals("s1", m.activeSessionId)
        assertEquals(5L, m.replayFrom)
    }

    @Test fun `replay flag and speak priority are read`() {
        val text = """{"v":1,"type":"speak","id":"c","ts":5,"seq":3,"payload":{"text":"Done.","priority":"interrupt","replay":true}}"""
        val f = ProtocolCodec.decodeHelper(text)!!
        assertTrue(f.replay)
        val m = f.message as HelperMessage.Speak
        assertEquals(SpeakPriority.Interrupt, m.speakPriority)
        assertNull(m.turnId)
    }

    @Test fun `file offer decodes and tolerates missing optional fields`() {
        val full = ProtocolCodec.decodeHelper(
            """{"v":1,"type":"file","id":"g","ts":1,"seq":7,"payload":{"fileId":"abc","turnId":"t1","name":"Quote 12.pdf","size":84213,"mime":"application/pdf","caption":"As asked","access":"k3y","expiresAt":1791400000000}}""",
        )!!.message as HelperMessage.FileOffer
        assertEquals("Quote 12.pdf", full.name)
        assertEquals(84213L, full.size)
        assertEquals("k3y", full.access)
        val min = ProtocolCodec.decodeHelper("""{"v":1,"type":"file","id":"h","ts":1,"payload":{"fileId":"x","name":"a.txt","access":"z"}}""")!!.message as HelperMessage.FileOffer
        assertEquals("application/octet-stream", min.mime)
        assertEquals(0L, min.size)
        assertEquals("", min.caption)
    }

    @Test fun `history decodes and the request encodes without nulls`() {
        val h = ProtocolCodec.decodeHelper(
            """{"v":1,"type":"history","id":"i","ts":1,"payload":{"sessionId":"home","items":[{"role":"user","text":"Hi","ts":1791300000000},{"role":"assistant","text":"Hello."}]}}""",
        )!!.message as HelperMessage.History
        assertEquals(2, h.items.size)
        assertEquals("user", h.items[0].role)
        assertEquals(0L, h.items[1].ts)
        val sent = ProtocolCodec.encodePhone(PhoneMessage.HistoryGet())
        assertTrue(sent.contains("\"type\":\"history.get\"") && !sent.contains("null"))
    }

    @Test fun `file names are made safe for storage`() {
        assertEquals("a_b_c.txt", au.com.roamdesk.files.FileInbox.safeName("a/b\\c.txt"))
        assertEquals("file", au.com.roamdesk.files.FileInbox.safeName("   "))
    }

    @Test fun `unknown priority falls back to normal`() {
        val m = ProtocolCodec.decodeHelper("""{"v":1,"type":"speak","id":"c","ts":5,"payload":{"text":"x","priority":"urgent"}}""")!!.message
        assertEquals(SpeakPriority.Normal, (m as HelperMessage.Speak).speakPriority)
    }

    @Test fun `unknown type is ignored but keeps its seq`() {
        val f = ProtocolCodec.decodeHelper("""{"v":1,"type":"future.thing","id":"d","ts":1,"seq":99,"payload":{"x":1}}""")
        assertNotNull(f)
        assertEquals(HelperMessage.Unknown("future.thing"), f!!.message)
        assertEquals(99L, f.seq)
    }

    @Test fun `unknown fields are ignored`() {
        val m = ProtocolCodec.decodeHelper("""{"v":1,"type":"status","id":"e","ts":1,"extra":true,"payload":{"busy":true,"queued":2,"disabled":false,"newField":"x"}}""")!!.message
        assertEquals(HelperMessage.Status(busy = true, queued = 2, disabled = false), m)
    }

    @Test fun `malformed known payload becomes Unknown rather than throwing`() {
        val m = ProtocolCodec.decodeHelper("""{"v":1,"type":"turn.done","id":"f","ts":1,"payload":{"nope":1}}""")!!.message
        assertEquals(HelperMessage.Unknown("turn.done", malformed = true), m)
    }

    @Test fun `non json is rejected`() {
        assertNull(ProtocolCodec.decodeHelper("not json"))
        assertNull(ProtocolCodec.decodeHelper("""{"v":1}"""))
    }

    @Test fun `pong and empty payloads`() {
        assertEquals(HelperMessage.Pong, ProtocolCodec.decodeHelper("""{"v":1,"type":"pong","id":"g","ts":1,"payload":{}}""")!!.message)
        assertEquals(HelperMessage.Pong, ProtocolCodec.decodeHelper("""{"v":1,"type":"pong","id":"g","ts":1}""")!!.message)
    }

    @Test fun `every PC message type decodes`() {
        val cases = mapOf(
            "auth.challenge" to """{"nonce":"n","helperId":"hlp_1"}""",
            "auth.fail" to """{"reason":"bad mac"}""",
            "turn.started" to """{"turnId":"t","sessionId":"s","text":"hi"}""",
            "reply.delta" to """{"turnId":"t","text":"He"}""",
            "turn.progress" to """{"turnId":"t","label":"Checking disk space"}""",
            "turn.done" to """{"turnId":"t","text":"All good.","durationMs":1200}""",
            "turn.failed" to """{"turnId":"t","error":"cancelled"}""",
            "confirm.resolved" to """{"confirmId":"c","decision":"timeout","by":"server"}""",
            "session.list" to """{"sessions":[],"activeSessionId":"s"}""",
            "error" to """{"code":"E1","message":"oops"}""",
        )
        cases.forEach { (type, payload) ->
            val f = ProtocolCodec.decodeHelper("""{"v":1,"type":"$type","id":"i","ts":1,"payload":$payload}""")!!
            assertFalse("$type decoded as Unknown", f.message is HelperMessage.Unknown)
        }
    }

    @Test fun `pair qr parses and validates`() {
        val qr = PairQr.parse("""{"v":1,"kind":"claude-anywhere-pair","name":"my-pc","hosts":["100.64.0.5","my-pc"],"port":8787,"code":"abc","exp":1760000300}""", allowPlain = true)
        assertEquals(listOf("100.64.0.5", "my-pc"), qr.hosts)
        assertEquals(8787, qr.port)
        val bad = runCatching { PairQr.parse("""{"v":1,"kind":"something-else","hosts":["a"],"code":"x","exp":1}""", allowPlain = true) }
        assertTrue(bad.isFailure)
        assertTrue(runCatching { PairQr.parse("hello", allowPlain = true) }.isFailure)
        // Only Tailscale addresses are kept; a code with none is refused.
        val mixed = PairQr.parse("""{"v":1,"kind":"claude-anywhere-pair","hosts":["192.168.1.20","100.64.0.5"],"port":8787,"code":"abc","exp":1}""", allowPlain = true)
        assertEquals(listOf("100.64.0.5"), mixed.hosts)
        assertTrue(runCatching { PairQr.parse("""{"v":1,"kind":"claude-anywhere-pair","hosts":["192.168.1.20","evil.example.com"],"port":8787,"code":"abc","exp":1}""", allowPlain = true) }.isFailure)
    }

    @Test fun `pair qr with the encrypted link`() {
        val json = """{"v":1,"kind":"claude-anywhere-pair","hosts":["100.64.0.5"],"port":8787,"code":"abc","exp":1,"secureHost":"My-PC.tail1234.ts.net","securePort":8443}"""
        val sideload = PairQr.parse(json, allowPlain = true)
        assertEquals("my-pc.tail1234.ts.net", sideload.secureHost)
        assertEquals(listOf("100.64.0.5"), sideload.hosts)
        val play = PairQr.parse(json, allowPlain = false)
        assertEquals(emptyList<String>(), play.hosts)
        assertEquals(8443, play.securePort)
        // Play build: a helper without the encrypted link can't be paired.
        assertTrue(runCatching { PairQr.parse("""{"v":1,"kind":"claude-anywhere-pair","hosts":["100.64.0.5"],"port":8787,"code":"abc","exp":1}""", allowPlain = false) }.isFailure)
        // The secure host has to be a .ts.net name.
        assertTrue(runCatching { PairQr.parse("""{"v":1,"kind":"claude-anywhere-pair","hosts":[],"code":"abc","exp":1,"secureHost":"evil.example.com"}""", allowPlain = false) }.isFailure)
        val ep = au.com.roamdesk.data.Pairing("d", "h", "n", play.hosts, 8787, "x", play.secureHost, play.securePort).endpoints(allowPlain = false)
        assertEquals("wss://my-pc.tail1234.ts.net:8443/ws", ep.single().ws())
    }

    @Test fun `tailnet host check`() {
        listOf("100.64.0.1", "100.127.255.255", "my-pc", "pc.tail1234.ts.net", "fd7a:115c:a1e0::1").forEach { assertTrue(it, TailnetHost.isAllowed(it)) }
        listOf("100.63.0.1", "100.128.0.1", "192.168.1.2", "8.8.8.8", "evil.example.com", "localhost", "").forEach { assertTrue(it, !TailnetHost.isAllowed(it)) }
    }

    @Test fun `helper proof is bound to both nonces and the helper`() {
        val secret = au.com.roamdesk.security.Base64Url.encode(ByteArray(32) { it.toByte() })
        val p = au.com.roamdesk.security.AuthMac.helperProof(secret, "pn", "n", "dev_1", "hlp_1")
        assertEquals(p, au.com.roamdesk.security.AuthMac.helperProof(secret, "pn", "n", "dev_1", "hlp_1"))
        assertTrue(p != au.com.roamdesk.security.AuthMac.helperProof(secret, "pn2", "n", "dev_1", "hlp_1"))
        assertTrue(p != au.com.roamdesk.security.AuthMac.helperProof(secret, "pn", "n", "dev_1", "hlp_2"))
    }

    @Test fun `received file names and types are made safe`() {
        assertEquals("file", au.com.roamdesk.files.FileInbox.safeName(".."))
        assertEquals("file", au.com.roamdesk.files.FileInbox.safeName("."))
        assertEquals(".._x", au.com.roamdesk.files.FileInbox.safeName("../x"))
    }

    @Test fun `empty payload object for kill`() {
        val (_, msg) = ProtocolCodec.decodePhone("""{"v":1,"type":"kill","id":"k","ts":1,"payload":{}}""")
        assertEquals(PhoneMessage.Kill, msg)
        val env = Wire.json.parseToJsonElement(ProtocolCodec.encodePhone(PhoneMessage.Ping)).jsonObject
        assertEquals(JsonObject(emptyMap()), env["payload"])
    }

    @Test fun `catalog frame decodes, with unknown fields ignored`() {
        val text = """{"v":1,"type":"catalog","id":"x","ts":1,"seq":null,"payload":{"items":[
            {"claudeSessionId":"3378bb5d-a334-4a19-83ca-5cd2cae6e5f9","title":"System manual","project":"Premier","cwd":"C:\\Users\\b\\Premier",
             "origin":"desktop","lastActiveAt":1760000000000.2192,"activeRecently":true,"somethingNew":1},
            {"claudeSessionId":"faa06145-f6f5-41cd-aea6-fd807c28b4bd","origin":"phone","attachedSessionId":"home"}]}}"""
        val m = ProtocolCodec.decodeHelper(text)!!.message as HelperMessage.Catalog
        assertEquals(2, m.items.size)
        assertEquals("System manual", m.items[0].title)
        assertTrue(m.items[0].activeRecently)
        assertEquals(1_760_000_000_000L, m.items[0].lastActiveAt.toLong()) // fractional ms from NTFS must not break decoding
        assertNull(m.items[0].attachedSessionId)
        assertEquals("home", m.items[1].attachedSessionId)
    }

    @Test fun `session carries claudeSessionId when present`() {
        val text = """{"v":1,"type":"session.list","id":"x","ts":1,"seq":5,"payload":{"sessions":[{"id":"s_1","name":"x","claudeSessionId":"abc"},{"id":"home"}],"activeSessionId":"s_1"}}"""
        val m = ProtocolCodec.decodeHelper(text)!!.message as HelperMessage.SessionList
        assertEquals("abc", m.sessions[0].claudeSessionId)
        assertNull(m.sessions[1].claudeSessionId)
    }
}