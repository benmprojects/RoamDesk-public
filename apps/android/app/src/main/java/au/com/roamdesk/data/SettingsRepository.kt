package au.com.roamdesk.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "claude_anywhere")

/** A paired PC. [encryptedSecret] is the Keystore-encrypted deviceSecret, never the plain value. */
data class Pairing(
    val deviceId: String,
    val helperId: String,
    val helperName: String,
    val hosts: List<String>,
    val port: Int,
    val encryptedSecret: String,
    /** The PC's .ts.net name for the encrypted HTTPS link (tailscale serve); blank if it had none when paired. */
    val secureHost: String = "",
    val securePort: Int = 443,
) {
    /** Where to connect, in order: the encrypted link first, then plain Tailscale addresses if this build allows them. */
    fun endpoints(allowPlain: Boolean): List<Endpoint> =
        (if (secureHost.isNotBlank()) listOf(Endpoint(secureHost, securePort, secure = true)) else emptyList()) +
            (if (allowPlain) hosts.map { Endpoint(it, port, secure = false) } else emptyList())
}

/** One way to reach the PC: wss/https when [secure], else ws/http over the Tailscale address. */
data class Endpoint(val host: String, val port: Int, val secure: Boolean) {
    val urlHost: String get() = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
    fun http(): okhttp3.HttpUrl.Builder = okhttp3.HttpUrl.Builder().scheme(if (secure) "https" else "http").host(host).port(port)
    fun ws(): String = "${if (secure) "wss" else "ws"}://$urlHost:$port/ws"
}

data class UserPrefs(
    val speechRate: Float = 1.0f,
    val idleTimeoutMin: Int = DEFAULT_IDLE_TIMEOUT_MIN,
    val onboarded: Boolean = false,
    /** Keep the screen awake while the app is open (on by default for in-car use). */
    val keepScreenOn: Boolean = true,
    /** TTS voice name chosen in Settings; null = automatic (best offline Australian voice). */
    val voiceName: String? = null,
) {
    companion object {
        const val DEFAULT_IDLE_TIMEOUT_MIN = 30
        val IDLE_TIMEOUT_CHOICES = listOf(10, 20, 30, 60)
    }
}

class SettingsRepository(context: Context) {
    private val store = context.applicationContext.dataStore

    private object K {
        val deviceId = stringPreferencesKey("device_id")
        val helperId = stringPreferencesKey("helper_id")
        val helperName = stringPreferencesKey("helper_name")
        val hosts = stringPreferencesKey("hosts")
        val port = intPreferencesKey("port")
        val secret = stringPreferencesKey("device_secret_enc")
        val secureHost = stringPreferencesKey("secure_host")
        val securePort = intPreferencesKey("secure_port")
        val lastSeq = longPreferencesKey("last_seq")
        val speechRate = floatPreferencesKey("speech_rate")
        val idleTimeout = intPreferencesKey("idle_timeout_min")
        val onboarded = booleanPreferencesKey("onboarded")
        val keepScreenOn = booleanPreferencesKey("keep_screen_on")
        val voiceName = stringPreferencesKey("voice_name")
    }

    val pairing: Flow<Pairing?> = store.data.map { p ->
        val deviceId = p[K.deviceId] ?: return@map null
        val secret = p[K.secret] ?: return@map null
        Pairing(
            deviceId = deviceId,
            helperId = p[K.helperId].orEmpty(),
            helperName = p[K.helperName].orEmpty(),
            hosts = p[K.hosts].orEmpty().split('\n').filter { it.isNotBlank() },
            port = p[K.port] ?: au.com.roamdesk.protocol.DEFAULT_PORT,
            encryptedSecret = secret,
            secureHost = p[K.secureHost].orEmpty(),
            securePort = p[K.securePort] ?: 443,
        )
    }.distinctUntilChanged()

    val prefs: Flow<UserPrefs> = store.data.map { p ->
        UserPrefs(
            speechRate = p[K.speechRate] ?: 1.0f,
            idleTimeoutMin = p[K.idleTimeout] ?: UserPrefs.DEFAULT_IDLE_TIMEOUT_MIN,
            onboarded = p[K.onboarded] ?: false,
            keepScreenOn = p[K.keepScreenOn] ?: true,
            voiceName = p[K.voiceName],
        )
    }.distinctUntilChanged()

    suspend fun currentPairing(): Pairing? = pairing.first()

    suspend fun savePairing(pairing: Pairing) {
        store.edit {
            it[K.deviceId] = pairing.deviceId
            it[K.helperId] = pairing.helperId
            it[K.helperName] = pairing.helperName
            it[K.hosts] = pairing.hosts.joinToString("\n")
            it[K.port] = pairing.port
            it[K.secret] = pairing.encryptedSecret
            if (pairing.secureHost.isNotBlank()) it[K.secureHost] = pairing.secureHost else it.remove(K.secureHost)
            it[K.securePort] = pairing.securePort
            it[K.lastSeq] = 0L
        }
    }

    suspend fun clearPairing() {
        store.edit {
            it.remove(K.deviceId); it.remove(K.helperId); it.remove(K.helperName)
            it.remove(K.hosts); it.remove(K.port); it.remove(K.secret); it.remove(K.lastSeq)
            it.remove(K.secureHost); it.remove(K.securePort)
        }
    }

    suspend fun lastSeq(): Long = store.data.first()[K.lastSeq] ?: 0L
    suspend fun setLastSeq(seq: Long) = store.edit { it[K.lastSeq] = seq }

    suspend fun setSpeechRate(rate: Float) = store.edit { it[K.speechRate] = rate }
    suspend fun setIdleTimeout(min: Int) = store.edit { it[K.idleTimeout] = min }
    suspend fun setOnboarded(done: Boolean) = store.edit { it[K.onboarded] = done }
    suspend fun setKeepScreenOn(on: Boolean) = store.edit { it[K.keepScreenOn] = on }
    suspend fun setVoiceName(name: String?) = store.edit { if (name == null) it.remove(K.voiceName) else it[K.voiceName] = name }
}
