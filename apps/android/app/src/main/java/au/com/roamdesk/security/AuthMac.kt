package au.com.roamdesk.security

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** base64url per RFC 4648 §5. Encodes without padding; decodes with or without padding (and tolerates standard base64). */
object Base64Url {
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(text: String): ByteArray {
        val normalised = text.trim().replace('+', '-').replace('/', '_').trimEnd('=')
        return Base64.getUrlDecoder().decode(normalised)
    }
}

/**
 * PROTOCOL.md "Connect and authenticate":
 * mac = base64url(HMAC-SHA256(key = base64url-decoded deviceSecret, message = UTF-8 of nonce + "|" + deviceId))
 */
object AuthMac {
    fun compute(deviceSecret: String, nonce: String, deviceId: String): String {
        val key = Base64Url.decode(deviceSecret)
        val mac = hmacSha256(key, "$nonce|$deviceId".toByteArray(Charsets.UTF_8))
        key.fill(0)
        return Base64Url.encode(mac)
    }

    /** What the PC must send back in auth.ok: HMAC(secret, "helper|phoneNonce|nonce|deviceId|helperId"). */
    fun helperProof(deviceSecret: String, phoneNonce: String, nonce: String, deviceId: String, helperId: String): String {
        val key = Base64Url.decode(deviceSecret)
        val mac = hmacSha256(key, "helper|$phoneNonce|$nonce|$deviceId|$helperId".toByteArray(Charsets.UTF_8))
        key.fill(0)
        return Base64Url.encode(mac)
    }

    /** Constant-time comparison of two base64url MACs. */
    fun matches(expected: String, got: String): Boolean =
        java.security.MessageDigest.isEqual(expected.toByteArray(Charsets.UTF_8), got.toByteArray(Charsets.UTF_8))

    fun newNonce(): String = Base64Url.encode(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }
}
