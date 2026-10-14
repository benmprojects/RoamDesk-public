package au.com.roamdesk.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AuthMacTest {

    // Bytes 0x00..0x1f and 0xff..0xe0, base64url without padding (as Node's Buffer#toString("base64url") emits).
    private val secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    private val nonce = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA"
    private val deviceId = "dev_test01"

    @Test
    fun `mac matches vector computed independently with Node crypto`() {
        // node -e 'crypto.createHmac("sha256", Buffer.from(secret,"base64url")).update(nonce+"|"+deviceId).digest("base64url")'
        assertEquals("A2_0IS7sW00JxAtS9CMFHs2b8WBvdpk0OPsUKjclcN0", AuthMac.compute(secret, nonce, deviceId))
    }

    @Test
    fun `mac is stable and has no padding`() {
        val a = AuthMac.compute(secret, nonce, deviceId)
        assertEquals(a, AuthMac.compute(secret, nonce, deviceId))
        assertFalse(a.contains('='))
        assertFalse(a.contains('+') || a.contains('/'))
        assertEquals(43, a.length) // 32 bytes → 43 base64url chars
    }

    @Test
    fun `padded or standard base64 secret decodes to the same key`() {
        val padded = "$secret="
        val standard = secret.replace('-', '+').replace('_', '/')
        assertEquals(AuthMac.compute(secret, nonce, deviceId), AuthMac.compute(padded, nonce, deviceId))
        assertEquals(AuthMac.compute(secret, nonce, deviceId), AuthMac.compute(standard, nonce, deviceId))
    }

    @Test
    fun `mac changes with nonce and device id`() {
        val base = AuthMac.compute(secret, nonce, deviceId)
        assert(base != AuthMac.compute(secret, nonce + "x", deviceId))
        assert(base != AuthMac.compute(secret, nonce, "dev_other"))
    }

    @Test
    fun `hmac primitive matches RFC 4231 test case 2`() {
        val mac = AuthMac.hmacSha256("Jefe".toByteArray(), "what do ya want for nothing?".toByteArray())
        val expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
            .chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        assertArrayEquals(expected, mac)
    }

    @Test
    fun `base64url round trip`() {
        val bytes = ByteArray(32) { it.toByte() }
        assertEquals(secret, Base64Url.encode(bytes))
        assertArrayEquals(bytes, Base64Url.decode(secret))
    }
}
