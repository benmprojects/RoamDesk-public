package au.com.roamdesk.data.net

import android.util.Log
import au.com.roamdesk.BuildConfig
import au.com.roamdesk.data.Endpoint
import au.com.roamdesk.data.Pairing
import au.com.roamdesk.data.SettingsRepository
import au.com.roamdesk.protocol.HelperFrame
import au.com.roamdesk.protocol.HelperMessage
import au.com.roamdesk.protocol.PhoneMessage
import au.com.roamdesk.protocol.ProtocolCodec
import au.com.roamdesk.protocol.TailnetHost
import au.com.roamdesk.security.AuthMac
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * WebSocket link to the desktop helper (PROTOCOL.md "Connect and authenticate").
 *
 * Runs only while something holds it (the visible UI or a Drive session) and the phone is paired.
 * Handles challenge/response auth, lastSeq persistence, acks (≤ 1/s), 15 s pings, a dead-socket watchdog,
 * reconnect with exponential backoff + jitter (cap 30 s) and failover across the paired hosts.
 */
class HelperConnection(
    private val http: OkHttpClient,
    private val settings: SettingsRepository,
    private val decryptSecret: suspend (Pairing) -> String?,
    private val scope: CoroutineScope,
    private val backoff: Backoff = Backoff(),
) {
    sealed interface State {
        data object NotPaired : State
        data object Stopped : State
        data class Connecting(val host: String) : State
        /** [endpoint] is how we reached the PC; downloads use the same scheme, host and port. */
        data class Connected(val host: String, val helperName: String, val endpoint: Endpoint) : State
        data class Waiting(val retryAtMs: Long, val reason: String) : State
        data class AuthFailed(val reason: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Stopped)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _frames = MutableSharedFlow<HelperFrame>(extraBufferCapacity = 512)
    /** Every authenticated PC → phone frame, in order, duplicates (seq ≤ lastSeq) removed. Includes auth.ok. */
    val frames: SharedFlow<HelperFrame> = _frames.asSharedFlow()

    private val holds = MutableStateFlow<Set<String>>(emptySet())
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private val active = AtomicReference<WebSocket?>(null)
    private val lastSeq = AtomicLong(0)

    init {
        scope.launch {
            combine(holds, settings.pairing) { h, p -> p to h.isNotEmpty() }
                .distinctUntilChanged()
                .collectLatest { (pairing, wanted) ->
                    when {
                        pairing == null -> _state.value = State.NotPaired
                        !wanted -> _state.value = State.Stopped
                        else -> runLoop(pairing)
                    }
                }
        }
    }

    fun acquire(tag: String) = holds.update { it + tag }
    fun release(tag: String) = holds.update { it - tag }

    /** Skip the current backoff wait (e.g. network came back, or the user tapped Retry). */
    fun reconnectNow() {
        kick.trySend(Unit)
    }

    val isConnected: Boolean get() = _state.value is State.Connected

    /** Sends a frame if authenticated. Returns false if it couldn't be handed to the socket. */
    fun send(msg: PhoneMessage): Boolean {
        if (_state.value !is State.Connected) return false
        val ws = active.get() ?: return false
        return ws.send(ProtocolCodec.encodePhone(msg))
    }

    // ------------------------------------------------------------------ loop

    private enum class Outcome { ConnectFailed, WasConnected, AuthRejected }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class) // select { onTimeout }
    private suspend fun runLoop(stored: Pairing) {
        // Plain ws:// is only safe inside Tailscale's encrypted network, so other stored addresses are never used.
        val pairing = stored.copy(hosts = stored.hosts.filter(TailnetHost::isAllowed))
        val endpoints = pairing.endpoints(BuildConfig.ALLOW_PLAIN)
        if (endpoints.isEmpty()) {
            _state.value = State.AuthFailed(
                if (BuildConfig.ALLOW_PLAIN) "No Tailscale addresses stored for your PC. Pair again."
                else "This phone was paired without the encrypted link. Show a fresh QR code on your PC and pair again.",
            )
            return
        }
        lastSeq.set(settings.lastSeq())
        var attempt = 0
        var hostIndex = 0
        var failedHostsThisRound = 0
        var authRejections = 0
        while (scope.isActive) {
            val ep = endpoints[hostIndex % endpoints.size]
            when (runSocket(pairing, ep)) {
                Outcome.WasConnected -> {
                    attempt = 0; failedHostsThisRound = 0; authRejections = 0
                    // Brief pause, then reconnect to the same host first.
                }
                Outcome.AuthRejected -> {
                    authRejections++
                    if (authRejections >= 3) {
                        // Stop hammering the helper with bad credentials. Wait for a manual retry.
                        kick.tryReceive()
                        kick.receive()
                        authRejections = 0; attempt = 0
                        continue
                    }
                }
                Outcome.ConnectFailed -> {
                    hostIndex++
                    failedHostsThisRound++
                    if (failedHostsThisRound < endpoints.size) continue // fail over to the next address immediately
                    failedHostsThisRound = 0
                }
            }
            val wait = backoff.delayFor(attempt++)
            val reason = (_state.value as? State.AuthFailed)?.reason ?: "Can't reach ${pairing.helperName.ifBlank { "your PC" }}"
            if (_state.value !is State.AuthFailed) _state.value = State.Waiting(System.currentTimeMillis() + wait, reason)
            kick.tryReceive() // drop stale kicks
            select<Unit> {
                kick.onReceive { }
                onTimeout(wait) { }
            }
        }
    }

    private sealed interface WsEvent {
        data object Open : WsEvent
        data class Text(val text: String) : WsEvent
        data class Closed(val reason: String) : WsEvent
    }

    private suspend fun runSocket(pairing: Pairing, ep: Endpoint): Outcome = coroutineScope {
        val host = ep.host
        _state.value = State.Connecting(host)
        val events = Channel<WsEvent>(Channel.UNLIMITED)
        val url = ep.ws()
        val request = try {
            Request.Builder().url(url).build()
        } catch (e: IllegalArgumentException) {
            return@coroutineScope Outcome.ConnectFailed
        }
        val ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { events.trySend(WsEvent.Open) }
            override fun onMessage(webSocket: WebSocket, text: String) { events.trySend(WsEvent.Text(text)) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                events.trySend(WsEvent.Closed(reason.ifBlank { "closed ($code)" }))
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { events.trySend(WsEvent.Closed(reason)) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                events.trySend(WsEvent.Closed(if (response?.code == 403) FORBIDDEN else t.message ?: t.javaClass.simpleName))
            }
        })

        var authenticated = false
        try {
            // 1. Wait for auth.challenge.
            val challenge = withTimeoutOrNull(CHALLENGE_TIMEOUT_MS) {
                while (true) {
                    when (val ev = events.receive()) {
                        WsEvent.Open -> Unit
                        is WsEvent.Closed -> {
                            // The encrypted link refuses Tailscale accounts other than the PC owner's.
                            if (ev.reason == FORBIDDEN) _state.value = State.AuthFailed(
                                "Your PC only accepts its owner's Tailscale account. Sign this phone in to Tailscale with the same account as the PC.",
                            )
                            return@withTimeoutOrNull null
                        }
                        is WsEvent.Text -> {
                            val m = ProtocolCodec.decodeHelper(ev.text)?.message
                            if (m is HelperMessage.AuthChallenge) return@withTimeoutOrNull m
                        }
                    }
                }
                @Suppress("UNREACHABLE_CODE") null
            } ?: return@coroutineScope if (_state.value is State.AuthFailed) Outcome.AuthRejected else Outcome.ConnectFailed

            if (pairing.helperId.isNotBlank() && challenge.helperId != pairing.helperId) {
                _state.value = State.AuthFailed("A different PC answered at $host. Pair again if you've reinstalled the helper.")
                return@coroutineScope Outcome.AuthRejected
            }

            // 2. Answer with the HMAC. The secret is decrypted just for this and not kept.
            val secret = decryptSecret(pairing) ?: run {
                _state.value = State.AuthFailed("The stored pairing key can't be read. Pair again.")
                return@coroutineScope Outcome.AuthRejected
            }
            // Our own challenge: the PC has to answer it with the pairing secret, so nothing else can pose as it.
            val phoneNonce = AuthMac.newNonce()
            val helperIdForProof = pairing.helperId.ifBlank { challenge.helperId }
            val (mac, expectedProof) = withContext(Dispatchers.Default) {
                AuthMac.compute(secret, challenge.nonce, pairing.deviceId) to
                    AuthMac.helperProof(secret, phoneNonce, challenge.nonce, pairing.deviceId, helperIdForProof)
            }
            ws.send(ProtocolCodec.encodePhone(PhoneMessage.AuthResponse(pairing.deviceId, mac, lastSeq.get(), phoneNonce)))

            // 3. auth.ok / auth.fail.
            val okFrame = withTimeoutOrNull(AUTH_RESULT_TIMEOUT_MS) {
                while (true) {
                    when (val ev = events.receive()) {
                        WsEvent.Open -> Unit
                        is WsEvent.Closed -> return@withTimeoutOrNull null
                        is WsEvent.Text -> {
                            val f = ProtocolCodec.decodeHelper(ev.text) ?: continue
                            when (val m = f.message) {
                                is HelperMessage.AuthOk -> return@withTimeoutOrNull f
                                is HelperMessage.AuthFail -> {
                                    _state.value = State.AuthFailed(m.reason.ifBlank { "Your PC rejected this phone." })
                                    return@withTimeoutOrNull null
                                }
                                else -> Unit
                            }
                        }
                    }
                }
                @Suppress("UNREACHABLE_CODE") null
            }
            if (okFrame == null) {
                return@coroutineScope if (_state.value is State.AuthFailed) Outcome.AuthRejected else Outcome.ConnectFailed
            }
            if (!AuthMac.matches(expectedProof, (okFrame.message as HelperMessage.AuthOk).proof)) {
                _state.value = State.AuthFailed("The PC at $host couldn't prove it's the one you paired with. Update the PC helper, or pair again.")
                return@coroutineScope Outcome.AuthRejected
            }

            val helperName = (okFrame.message as HelperMessage.AuthOk).helperName.ifBlank { pairing.helperName }
            active.set(ws)
            authenticated = true
            _state.value = State.Connected(host, helperName, ep)
            _frames.emit(okFrame)

            // 4. Live: pings, acks, watchdog, frames.
            val lastRx = AtomicLong(System.currentTimeMillis())
            var lastAcked = lastSeq.get()
            val pinger = launch {
                while (isActive) {
                    delay(PING_INTERVAL_MS)
                    ws.send(ProtocolCodec.encodePhone(PhoneMessage.Ping))
                    if (System.currentTimeMillis() - lastRx.get() > DEAD_AFTER_MS) {
                        ws.cancel()
                        events.trySend(WsEvent.Closed("No response from PC"))
                    }
                }
            }
            val acker = launch {
                while (isActive) {
                    delay(ACK_INTERVAL_MS)
                    val s = lastSeq.get()
                    if (s > lastAcked && ws.send(ProtocolCodec.encodePhone(PhoneMessage.Ack(s)))) {
                        lastAcked = s
                        settings.setLastSeq(s)
                    }
                }
            }
            try {
                while (true) {
                    when (val ev = events.receive()) {
                        WsEvent.Open -> Unit
                        is WsEvent.Closed -> break
                        is WsEvent.Text -> {
                            lastRx.set(System.currentTimeMillis())
                            val f = ProtocolCodec.decodeHelper(ev.text) ?: continue
                            val seq = f.seq
                            if (seq != null) {
                                if (seq <= lastSeq.get()) continue // already processed (replay overlap)
                                _frames.emit(f)
                                lastSeq.set(seq)
                            } else {
                                _frames.emit(f)
                            }
                        }
                    }
                }
            } finally {
                pinger.cancel(); acker.cancel()
            }
            Outcome.WasConnected
        } finally {
            active.compareAndSet(ws, null)
            ws.cancel()
            if (authenticated) {
                val s = lastSeq.get()
                scope.launch { runCatching { settings.setLastSeq(s) } }
                if (_state.value is State.Connected) _state.value = State.Waiting(System.currentTimeMillis(), "Connection lost")
            }
            Log.d(TAG, "socket to $host ended (authenticated=$authenticated)")
        }
    }


    companion object {
        private const val TAG = "HelperConnection"
        const val CHALLENGE_TIMEOUT_MS = 8_000L
        private const val FORBIDDEN = "\u0000forbidden"
        const val AUTH_RESULT_TIMEOUT_MS = 10_000L
        const val PING_INTERVAL_MS = 15_000L
        const val ACK_INTERVAL_MS = 1_000L
        const val DEAD_AFTER_MS = 45_000L
    }
}
