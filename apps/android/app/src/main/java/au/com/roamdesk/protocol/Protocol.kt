package au.com.roamdesk.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.util.UUID

/**
 * Kotlin mirror of packages/protocol (wire protocol v1). See PROTOCOL.md.
 * Keep field names identical to src/index.ts.
 */
const val PROTOCOL_VERSION = 1
const val DEFAULT_PORT = 8787

object Wire {
    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false // optional fields (seq, sessionId, queuedAt, …) are omitted, not sent as null
        encodeDefaults = true
        coerceInputValues = true
    }
}

@Serializable
data class Session(
    val id: String,
    val name: String = "",
    val cwd: String = "",
    val model: String = "",
    val busy: Boolean = false,
    /** Claude Code session being continued, when known. */
    val claudeSessionId: String? = null,
)

/** An existing Claude Code session on the PC that the phone can continue (hand-off). */
@Serializable
data class CatalogItem(
    val claudeSessionId: String,
    val title: String = "",
    val project: String = "",
    val cwd: String = "",
    /** "desktop" | "terminal" | "phone" | "other" */
    val origin: String = "other",
    /** Epoch ms. Double so a fractional value from the PC can never break decoding. */
    val lastActiveAt: Double = 0.0,
    val activeRecently: Boolean = false,
    val attachedSessionId: String? = null,
)

// ---------------------------------------------------------------- Pairing (HTTP)

@Serializable
data class PairQr(
    val v: Int,
    val kind: String,
    val name: String = "",
    val hosts: List<String>,
    val port: Int = DEFAULT_PORT,
    val code: String,
    val exp: Long,
    /** The PC's .ts.net name for the encrypted link (tailscale serve), when it has one. */
    val secureHost: String = "",
    val securePort: Int = 443,
) {
    companion object {
        const val KIND = "claude-anywhere-pair"

        /**
         * Parses and validates QR / pasted pairing JSON. Throws [IllegalArgumentException] with a user-facing message.
         * [allowPlain] = whether this build may use the plain ws:// Tailscale addresses (the Play build may not).
         */
        fun parse(text: String, allowPlain: Boolean = au.com.roamdesk.BuildConfig.ALLOW_PLAIN): PairQr {
            val qr = try {
                Wire.json.decodeFromString(serializer(), text.trim())
            } catch (e: Exception) {
                throw IllegalArgumentException("That isn't a Roam Desk pairing code.")
            }
            require(qr.kind == KIND) { "That QR code isn't from the Roam Desk helper." }
            require(qr.v == PROTOCOL_VERSION) { "This helper uses protocol v${qr.v}; this app speaks v$PROTOCOL_VERSION." }
            require(qr.code.isNotBlank()) { "The pairing code is missing its one-time code." }
            require(qr.port in 1..65535 && qr.securePort in 1..65535) { "The pairing code has an invalid port." }
            val secure = qr.secureHost.trim().lowercase().takeIf { it.isNotEmpty() }
            require(secure == null || (secure.endsWith(".ts.net") && TailnetHost.isAllowed(secure))) {
                "That pairing code points somewhere other than your Tailscale network, so it wasn't used."
            }
            // Plain ws:// relies on Tailscale's own encryption, so only Tailscale addresses are kept.
            val tailnet = if (allowPlain) qr.hosts.map { it.trim() }.filter { it.isNotEmpty() && TailnetHost.isAllowed(it) } else emptyList()
            if (!allowPlain) require(secure != null) {
                "Your PC's encrypted link isn't set up yet. Update the PC helper and switch on HTTPS certificates in Tailscale, then show a fresh QR code."
            }
            require(secure != null || tailnet.isNotEmpty()) { "That pairing code points somewhere other than your Tailscale network, so it wasn't used." }
            return qr.copy(hosts = tailnet, secureHost = secure.orEmpty())
        }
    }
}

/**
 * Addresses on a Tailscale network: 100.64.0.0/10, fd7a:115c:a1e0::/48, and MagicDNS names (short machine names
 * or names under .ts.net). Anything else, such as a home-network IP, is refused.
 */
object TailnetHost {
    private val emulatorHosts = setOf("10.0.2.2", "127.0.0.1")

    fun isAllowed(host: String): Boolean {
        val h = host.trim().removePrefix("[").removeSuffix("]").lowercase()
        if (au.com.roamdesk.BuildConfig.DEBUG && h in emulatorHosts) return true
        if (h.endsWith(".ts.net") && Regex("^[a-z0-9.-]+$").matches(h)) return true
        if (Regex("^[a-z0-9]([a-z0-9-]{0,62})$").matches(h) && h != "localhost") return true // MagicDNS short name
        if (h.startsWith("fd7a:115c:a1e0:")) return true
        val parts = h.split('.')
        if (parts.size != 4) return false
        val n = parts.map { it.toIntOrNull() ?: return false }
        if (n.any { it !in 0..255 }) return false
        return n[0] == 100 && n[1] in 64..127
    }
}

@Serializable
data class PairRequest(val code: String, val deviceName: String, val platform: String = "android")

@Serializable
data class PairResponse(val deviceId: String, val deviceSecret: String, val helperId: String, val helperName: String = "")

// ---------------------------------------------------------------- Envelope

@Serializable
data class RawEnvelope(
    val v: Int = PROTOCOL_VERSION,
    val type: String,
    val id: String = "",
    val ts: Long = 0,
    val seq: Long? = null,
    val payload: JsonElement = JsonObject(emptyMap()),
)

object Decision {
    const val CONFIRM = "confirm"
    const val CANCEL = "cancel"
    const val TIMEOUT = "timeout"
}

enum class SpeakPriority { Normal, Low, Interrupt;
    companion object {
        fun parse(s: String?): SpeakPriority = when (s) {
            "interrupt" -> Interrupt
            "low" -> Low
            else -> Normal
        }
    }
}

// ---------------------------------------------------------------- PC → phone

sealed interface HelperMessage {
    @Serializable data class AuthChallenge(val nonce: String, val helperId: String) : HelperMessage
    @Serializable data class AuthOk(
        val helperName: String = "",
        val sessions: List<Session> = emptyList(),
        val activeSessionId: String? = null,
        val replayFrom: Long = 0,
        val disabled: Boolean = false,
        /** The PC's answer to our phoneNonce; proves it holds the pairing secret. */
        val proof: String = "",
    ) : HelperMessage
    @Serializable data class AuthFail(val reason: String = "") : HelperMessage
    @Serializable data class TurnStarted(val turnId: String, val sessionId: String = "", val text: String = "") : HelperMessage
    @Serializable data class ReplyDelta(val turnId: String, val text: String) : HelperMessage
    @Serializable data class TurnProgress(val turnId: String, val label: String) : HelperMessage
    @Serializable data class Speak(val turnId: String? = null, val text: String, val priority: String = "normal") : HelperMessage {
        val speakPriority: SpeakPriority get() = SpeakPriority.parse(priority)
    }
    @Serializable data class TurnDone(val turnId: String, val text: String = "", val durationMs: Long = 0) : HelperMessage
    @Serializable data class TurnFailed(val turnId: String, val error: String = "") : HelperMessage
    @Serializable data class ConfirmRequest(
        val confirmId: String,
        val turnId: String = "",
        val tier: Int,
        val summary: String,
        val command: String = "",
        val phrase: String,
        val expiresInS: Int = 45,
    ) : HelperMessage
    @Serializable data class ConfirmResolved(val confirmId: String, val decision: String, val by: String = "server") : HelperMessage
    @Serializable data class SessionList(val sessions: List<Session> = emptyList(), val activeSessionId: String? = null) : HelperMessage
    @Serializable data class Catalog(val items: List<CatalogItem> = emptyList()) : HelperMessage
    @Serializable data class HistoryItem(val role: String = "assistant", val text: String = "", val ts: Long = 0)
    /** Recent turns of a session (oldest first), read from Claude's session record on the PC. */
    @Serializable data class History(val sessionId: String = "", val items: List<HistoryItem> = emptyList()) : HelperMessage
    /** Newest app build on the PC; downloaded with [access] if [versionCode] is newer than ours. */
    @Serializable data class AppUpdate(val versionCode: Long, val versionName: String = "", val size: Long = 0, val access: String) : HelperMessage
    /** A file Claude is giving the phone; downloaded from the helper with [access] as the only credential. */
    @Serializable data class FileOffer(
        val fileId: String,
        val turnId: String? = null,
        val name: String,
        val size: Long = 0,
        val mime: String = "application/octet-stream",
        val caption: String = "",
        val access: String,
        val expiresAt: Long = 0,
    ) : HelperMessage
    @Serializable data class Status(
        val busy: Boolean = false,
        val queued: Int = 0,
        val disabled: Boolean = false,
        val skipConfirmations: Boolean = false,
        val plainUpdates: Boolean = true,
    ) : HelperMessage
    @Serializable data class HelperError(val code: String = "", val message: String = "") : HelperMessage
    data object Pong : HelperMessage
    /** Unknown type (ignored per spec) or a known type whose payload didn't parse. */
    data class Unknown(val type: String, val malformed: Boolean = false) : HelperMessage
}

data class HelperFrame(
    val type: String,
    val id: String,
    val ts: Long,
    val seq: Long?,
    val replay: Boolean,
    val message: HelperMessage,
)

// ---------------------------------------------------------------- Phone → PC

sealed interface PhoneMessage {
    val type: String

    @Serializable data class AuthResponse(val deviceId: String, val mac: String, val lastSeq: Long, val phoneNonce: String = "") : PhoneMessage {
        override val type get() = "auth.response"
    }
    @Serializable data class Utterance(
        val text: String,
        val sessionId: String? = null,
        val source: String = SOURCE_VOICE,
        val queuedAt: Long? = null,
    ) : PhoneMessage {
        override val type get() = "utterance"
    }
    @Serializable data class ConfirmResponse(val confirmId: String, val decision: String, val heard: String) : PhoneMessage {
        override val type get() = "confirm.response"
    }
    @Serializable data class TurnCancel(val turnId: String? = null) : PhoneMessage {
        override val type get() = "turn.cancel"
    }
    data object Kill : PhoneMessage { override val type get() = "kill" }
    @Serializable data class SessionNew(val name: String, val cwd: String? = null) : PhoneMessage {
        override val type get() = "session.new"
    }
    @Serializable data class SessionSelect(val sessionId: String) : PhoneMessage {
        override val type get() = "session.select"
    }
    @Serializable data class SessionReset(val sessionId: String? = null) : PhoneMessage {
        override val type get() = "session.reset"
    }
    data object CatalogList : PhoneMessage { override val type get() = "catalog.list" }
    data object AppCheck : PhoneMessage { override val type get() = "app.check" }
    @Serializable data class HistoryGet(val sessionId: String? = null, val limit: Int? = null) : PhoneMessage {
        override val type get() = "history.get"
    }
    data object HelperUpdate : PhoneMessage { override val type get() = "helper.update" }
    @Serializable data class SessionAttach(val claudeSessionId: String) : PhoneMessage {
        override val type get() = "session.attach"
    }
    @Serializable data class SessionRelease(val sessionId: String) : PhoneMessage {
        override val type get() = "session.release"
    }
    @Serializable data class SettingsSet(val skipConfirmations: Boolean? = null, val plainUpdates: Boolean? = null) : PhoneMessage {
        override val type get() = "settings.set"
    }
    @Serializable data class Ack(val seq: Long) : PhoneMessage {
        override val type get() = "ack"
    }
    data object Ping : PhoneMessage { override val type get() = "ping" }

    companion object {
        const val SOURCE_VOICE = "voice"
        const val SOURCE_TYPED = "typed"
    }
}

// ---------------------------------------------------------------- Codec

object ProtocolCodec {
    private val json get() = Wire.json
    private val empty = JsonObject(emptyMap())

    fun newId(): String = UUID.randomUUID().toString()

    fun encodePhone(msg: PhoneMessage, id: String = newId(), ts: Long = System.currentTimeMillis()): String {
        val payload: JsonElement = when (msg) {
            is PhoneMessage.AuthResponse -> json.encodeToJsonElement(PhoneMessage.AuthResponse.serializer(), msg)
            is PhoneMessage.Utterance -> json.encodeToJsonElement(PhoneMessage.Utterance.serializer(), msg)
            is PhoneMessage.ConfirmResponse -> json.encodeToJsonElement(PhoneMessage.ConfirmResponse.serializer(), msg)
            is PhoneMessage.TurnCancel -> json.encodeToJsonElement(PhoneMessage.TurnCancel.serializer(), msg)
            is PhoneMessage.SessionNew -> json.encodeToJsonElement(PhoneMessage.SessionNew.serializer(), msg)
            is PhoneMessage.SessionSelect -> json.encodeToJsonElement(PhoneMessage.SessionSelect.serializer(), msg)
            is PhoneMessage.SessionReset -> json.encodeToJsonElement(PhoneMessage.SessionReset.serializer(), msg)
            is PhoneMessage.SessionAttach -> json.encodeToJsonElement(PhoneMessage.SessionAttach.serializer(), msg)
            is PhoneMessage.HistoryGet -> json.encodeToJsonElement(PhoneMessage.HistoryGet.serializer(), msg)
            is PhoneMessage.SessionRelease -> json.encodeToJsonElement(PhoneMessage.SessionRelease.serializer(), msg)
            is PhoneMessage.SettingsSet -> json.encodeToJsonElement(PhoneMessage.SettingsSet.serializer(), msg)
            is PhoneMessage.Ack -> json.encodeToJsonElement(PhoneMessage.Ack.serializer(), msg)
            PhoneMessage.Kill, PhoneMessage.Ping, PhoneMessage.CatalogList, PhoneMessage.AppCheck, PhoneMessage.HelperUpdate -> empty
        }
        // Phone → PC frames never carry seq.
        return json.encodeToString(RawEnvelope.serializer(), RawEnvelope(PROTOCOL_VERSION, msg.type, id, ts, null, payload))
    }

    /** Decodes a phone frame (used by tests and diagnostics). Returns null for unknown types. */
    fun decodePhone(text: String): Pair<RawEnvelope, PhoneMessage?> {
        val env = json.decodeFromString(RawEnvelope.serializer(), text)
        val p = env.payload
        fun <T> d(s: KSerializer<T>): T = json.decodeFromJsonElement(s, p)
        val msg: PhoneMessage? = when (env.type) {
            "auth.response" -> d(PhoneMessage.AuthResponse.serializer())
            "utterance" -> d(PhoneMessage.Utterance.serializer())
            "confirm.response" -> d(PhoneMessage.ConfirmResponse.serializer())
            "turn.cancel" -> d(PhoneMessage.TurnCancel.serializer())
            "kill" -> PhoneMessage.Kill
            "session.new" -> d(PhoneMessage.SessionNew.serializer())
            "session.select" -> d(PhoneMessage.SessionSelect.serializer())
            "session.reset" -> d(PhoneMessage.SessionReset.serializer())
            "catalog.list" -> PhoneMessage.CatalogList
            "app.check" -> PhoneMessage.AppCheck
            "history.get" -> d(PhoneMessage.HistoryGet.serializer())
            "helper.update" -> PhoneMessage.HelperUpdate
            "session.attach" -> d(PhoneMessage.SessionAttach.serializer())
            "session.release" -> d(PhoneMessage.SessionRelease.serializer())
            "settings.set" -> d(PhoneMessage.SettingsSet.serializer())
            "ack" -> d(PhoneMessage.Ack.serializer())
            "ping" -> PhoneMessage.Ping
            else -> null
        }
        return env to msg
    }

    /**
     * Decodes one PC → phone frame. Returns null only if the text isn't a JSON envelope at all.
     * Unknown types become [HelperMessage.Unknown] so the caller can still account for `seq`, then ignore them.
     */
    fun decodeHelper(text: String): HelperFrame? {
        val env = try {
            json.decodeFromString(RawEnvelope.serializer(), text)
        } catch (e: Exception) {
            return null
        }
        val payload = env.payload as? JsonObject ?: empty
        val replay = (payload["replay"] as? JsonPrimitive)?.booleanOrNull ?: false
        val message = try {
            decodeHelperPayload(env.type, payload)
        } catch (e: Exception) {
            HelperMessage.Unknown(env.type, malformed = true)
        }
        return HelperFrame(env.type, env.id, env.ts, env.seq, replay, message)
    }

    private fun decodeHelperPayload(type: String, p: JsonObject): HelperMessage {
        fun <T> d(s: KSerializer<T>): T = json.decodeFromJsonElement(s, p)
        return when (type) {
            "auth.challenge" -> d(HelperMessage.AuthChallenge.serializer())
            "auth.ok" -> d(HelperMessage.AuthOk.serializer())
            "auth.fail" -> d(HelperMessage.AuthFail.serializer())
            "turn.started" -> d(HelperMessage.TurnStarted.serializer())
            "reply.delta" -> d(HelperMessage.ReplyDelta.serializer())
            "turn.progress" -> d(HelperMessage.TurnProgress.serializer())
            "speak" -> d(HelperMessage.Speak.serializer())
            "turn.done" -> d(HelperMessage.TurnDone.serializer())
            "turn.failed" -> d(HelperMessage.TurnFailed.serializer())
            "confirm.request" -> d(HelperMessage.ConfirmRequest.serializer())
            "confirm.resolved" -> d(HelperMessage.ConfirmResolved.serializer())
            "session.list" -> d(HelperMessage.SessionList.serializer())
            "catalog" -> d(HelperMessage.Catalog.serializer())
            "file" -> d(HelperMessage.FileOffer.serializer())
            "app.update" -> d(HelperMessage.AppUpdate.serializer())
            "history" -> d(HelperMessage.History.serializer())
            "status" -> d(HelperMessage.Status.serializer())
            "error" -> d(HelperMessage.HelperError.serializer())
            "pong" -> HelperMessage.Pong
            else -> HelperMessage.Unknown(type)
        }
    }
}
