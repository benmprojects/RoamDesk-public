package au.com.roamdesk.pairing

import android.content.Context
import android.os.Build
import android.provider.Settings
import au.com.roamdesk.data.OfflineQueue
import au.com.roamdesk.data.Pairing
import au.com.roamdesk.data.SettingsRepository
import au.com.roamdesk.protocol.PairQr
import au.com.roamdesk.protocol.PairRequest
import au.com.roamdesk.protocol.PairResponse
import au.com.roamdesk.protocol.Wire
import au.com.roamdesk.security.Base64Url
import au.com.roamdesk.security.SecretCipher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed interface PairResult {
    data class Success(val helperName: String) : PairResult
    data class Failure(val message: String) : PairResult
}

/** PROTOCOL.md "Pairing": POST /pair to each host in turn; store the secret Keystore-encrypted. */
class PairingRepository(
    context: Context,
    private val settings: SettingsRepository,
    private val cipher: SecretCipher,
    private val queue: OfflineQueue,
    http: OkHttpClient,
) {
    private val app = context.applicationContext
    private val http = http.newBuilder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun pair(qrJson: String): PairResult = withContext(Dispatchers.IO) {
        val qr = try {
            PairQr.parse(qrJson)
        } catch (e: IllegalArgumentException) {
            return@withContext PairResult.Failure(e.message ?: "That pairing code isn't valid.")
        }
        val body = Wire.json.encodeToString(PairRequest.serializer(), PairRequest(qr.code, deviceName(), "android"))
            .toRequestBody("application/json; charset=utf-8".toMediaType())

        var lastProblem = "no answer"
        // The encrypted link first; plain Tailscale addresses only if this build allows them (parse() already filtered).
        val endpoints = Pairing("", "", "", qr.hosts, qr.port, "", qr.secureHost, qr.securePort).endpoints(allowPlain = true)
        for (ep in endpoints) {
            val host = ep.host
            val request = try {
                Request.Builder().url(ep.http().addPathSegment("pair").build()).post(body).build()
            } catch (e: IllegalArgumentException) {
                lastProblem = "bad address $host"; continue
            }
            try {
                http.newCall(request).execute().use { resp ->
                    when (resp.code) {
                        200 -> {
                            val pr = Wire.json.decodeFromString(PairResponse.serializer(), resp.body?.string().orEmpty())
                            val secretBytes = Base64Url.decode(pr.deviceSecret)
                            require(secretBytes.size >= 16) { "secret too short" }
                            val encrypted = cipher.encrypt(pr.deviceSecret.toByteArray(Charsets.UTF_8))
                            val name = pr.helperName.ifBlank { qr.name }
                            // Put the plain host that answered first so a fallback reconnect is quick.
                            val hosts = if (ep.secure) qr.hosts else listOf(host) + qr.hosts.filter { it != host }
                            queue.clear()
                            settings.savePairing(Pairing(pr.deviceId, pr.helperId, name, hosts, qr.port, encrypted, qr.secureHost, qr.securePort))
                            return@withContext PairResult.Success(name)
                        }
                        401 -> return@withContext PairResult.Failure(
                            "Your PC rejected that code. It may have expired or already been used. Show a fresh QR code and try again.",
                        )
                        403 -> return@withContext PairResult.Failure(
                            "Your PC only accepts its owner's Tailscale account. Sign this phone in to Tailscale with the same account as the PC.",
                        )
                        else -> lastProblem = "HTTP ${resp.code} from $host"
                    }
                }
            } catch (e: IOException) {
                lastProblem = "${e.javaClass.simpleName} on $host: ${e.message ?: "no detail"}"
            } catch (e: IllegalArgumentException) {
                return@withContext PairResult.Failure("Your PC sent a pairing reply this app can't read.")
            } catch (e: kotlinx.serialization.SerializationException) {
                return@withContext PairResult.Failure("Your PC sent a pairing reply this app can't read.")
            }
        }
        PairResult.Failure("Couldn't reach ${qr.name.ifBlank { "your PC" }} ($lastProblem). Check Tailscale is on for both devices.")
    }

    /** Decrypts the device secret for one auth handshake. */
    suspend fun deviceSecret(pairing: Pairing): String? = withContext(Dispatchers.IO) {
        runCatching { String(cipher.decrypt(pairing.encryptedSecret), Charsets.UTF_8) }.getOrNull()
    }

    suspend fun unpair() {
        settings.clearPairing()
        queue.clear()
        withContext(Dispatchers.IO) { cipher.deleteKey() }
    }

    private fun deviceName(): String =
        runCatching { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
