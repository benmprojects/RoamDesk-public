package au.com.roamdesk.drive

import android.util.Log
import au.com.roamdesk.data.OfflineQueue
import au.com.roamdesk.data.QueuedUtterance
import au.com.roamdesk.data.SettingsRepository
import au.com.roamdesk.data.UserPrefs
import au.com.roamdesk.data.net.HelperConnection
import au.com.roamdesk.protocol.ConfirmMatch
import au.com.roamdesk.protocol.Decision
import au.com.roamdesk.protocol.HelperFrame
import au.com.roamdesk.protocol.CatalogItem
import au.com.roamdesk.protocol.HelperMessage
import au.com.roamdesk.protocol.PhoneMessage
import au.com.roamdesk.protocol.PhraseMatcher
import au.com.roamdesk.protocol.ReplayCollapser
import au.com.roamdesk.protocol.Session
import au.com.roamdesk.protocol.SpeakPriority
import au.com.roamdesk.protocol.YesNo
import au.com.roamdesk.voice.Earcons
import au.com.roamdesk.voice.SpeechInput
import au.com.roamdesk.voice.SpeechOutput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

/**
 * The single source of truth for a Drive session: voice in/out, the PC link, confirmations,
 * the offline queue and the conversation. Everything runs on the main thread ([scope] is Main.immediate).
 *
 * Unlock window: commands (utterance, session.*, confirm) are only sent while a Drive session is active.
 * kill, turn.cancel and a *cancel* confirm.response are always allowed because they only stop things.
 */
class DriveStateMachine(
    private val scope: CoroutineScope,
    private val connection: HelperConnection,
    private val settings: SettingsRepository,
    private val queue: OfflineQueue,
    private val speechIn: SpeechInput,
    private val speechOut: SpeechOutput,
    private val earcons: Earcons,
    private val clock: () -> Long = System::currentTimeMillis,
    private val files: au.com.roamdesk.files.FileInbox? = null,
) {
    private data class Core(
        val driveActive: Boolean = false,
        val lastActivityMs: Long = 0,
        val helperName: String = "",
        val sessions: List<Session> = emptyList(),
        val activeSessionId: String? = null,
        /** Recent Claude Code sessions on the PC; null until requested. */
        val catalog: List<CatalogItem>? = null,
        val catalogLoading: Boolean = false,
        val pcBusy: Boolean = false,
        val pcQueued: Int = 0,
        val pcDisabled: Boolean = false,
        val skipConfirmations: Boolean = false,
        val plainUpdates: Boolean = true,
        val activeTurns: Set<String> = emptySet(),
        val awaitingReply: Boolean = false,
        val progressLabel: String? = null,
        val lastReply: String = "",
        val lastHeard: String = "",
        val confirm: PendingConfirm? = null,
        val queueQuestion: String? = null,
        val conversation: List<ConversationItem> = emptyList(),
        val notice: Notice? = null,
    )

    private val core = MutableStateFlow(Core())
    private var prefs = UserPrefs()
    private val prefsFlow = MutableStateFlow(UserPrefs())
    private var paired = false

    private val collapser = ReplayCollapser()
    private var replayFlushJob: Job? = null

    private var listenJob: Job? = null
    private var confirmJob: Job? = null
    private var confirmExpiryJob: Job? = null
    private var drainJob: Job? = null
    private var workingJob: Job? = null
    private var idleJob: Job? = null
    private val confirmQueue = ArrayDeque<HelperMessage.ConfirmRequest>()
    private val heldSpeech = ArrayDeque<Pair<String, SpeakPriority>>()
    private val replyItemByTurn = HashMap<String, Long>()
    private var nextItemId = 1L
    private var wasConnected = false
    private var lastUnspokenNoticeAt = 0L

    init {
        // Speech must never fail silently: if the engine can't speak something, say so on screen.
        speechOut.onDropped = { _ -> noteUnspoken("Couldn't speak that reply, but it's shown here.") }
    }

    /** A reply that was shown but not spoken: leave a note in the conversation, at most one every 30 seconds. */
    private fun noteUnspoken(text: String) {
        val now = clock()
        if (now - lastUnspokenNoticeAt < UNSPOKEN_NOTICE_GAP_MS) return
        lastUnspokenNoticeAt = now
        addItem(ConversationItem.Kind.System, text)
    }

    val state: StateFlow<DriveUiState> = combine(
        combine(core, connection.state, speechIn.listening, speechOut.speaking, speechIn.partial) { c, link, listening, speaking, partial ->
            Snapshot(c, link, listening, speaking, partial)
        },
        queue.count,
        prefsFlow,
        settings.pairing,
        speechOut.voices,
    ) { s, queued, p, pairing, voices ->
        val (link, detail) = linkOf(s.link)
        val c = s.core
        val dialogBusy = c.queueQuestion != null
        val phase = when {
            c.confirm != null && c.driveActive -> DrivePhase.Confirming
            s.listening -> DrivePhase.Listening
            s.speaking -> DrivePhase.Speaking
            link != LinkStatus.Online -> DrivePhase.Offline
            c.confirm != null -> DrivePhase.Confirming
            c.activeTurns.isNotEmpty() || c.awaitingReply || c.pcBusy || dialogBusy -> DrivePhase.Thinking
            else -> DrivePhase.Idle
        }
        DriveUiState(
            paired = pairing != null,
            helperName = c.helperName.ifBlank { pairing?.helperName.orEmpty() },
            link = link,
            linkDetail = detail,
            driveActive = c.driveActive,
            idleTimeoutMin = p.idleTimeoutMin,
            phase = phase,
            partialTranscript = if (s.listening) s.partial else "",
            lastHeard = c.lastHeard,
            lastReply = c.lastReply,
            progressLabel = c.progressLabel,
            sessions = c.sessions,
            activeSessionId = c.activeSessionId,
            catalog = c.catalog,
            catalogLoading = c.catalogLoading,
            pcBusy = c.pcBusy,
            pcQueued = c.pcQueued,
            pcDisabled = c.pcDisabled,
            skipConfirmations = c.skipConfirmations,
            plainUpdates = c.plainUpdates,
            confirm = c.confirm,
            queueQuestion = c.queueQuestion,
            offlineQueued = queued,
            conversation = c.conversation,
            notice = c.notice,
            speechRate = p.speechRate,
            voices = voices,
            voiceName = p.voiceName,
        )
    }.stateIn(scope, SharingStarted.Eagerly, DriveUiState())

    private data class Snapshot(
        val core: Core,
        val link: HelperConnection.State,
        val listening: Boolean,
        val speaking: Boolean,
        val partial: String,
    )

    init {
        scope.launch { connection.frames.collect { onFrame(it) } }
        scope.launch {
            connection.state.collect { s ->
                val now = s is HelperConnection.State.Connected
                if (wasConnected && !now) onDisconnected()
                wasConnected = now
            }
        }
        scope.launch {
            settings.prefs.collect {
                prefs = it
                prefsFlow.value = it
                speechOut.rate = it.speechRate
                if (speechOut.voiceName != it.voiceName) speechOut.voiceName = it.voiceName
            }
        }
        scope.launch {
            settings.pairing.collect { p ->
                val wasPaired = paired
                paired = p != null
                if (wasPaired && !paired) onUnpaired()
            }
        }
        scope.launch { queue.pending() } // load count
    }

    // ================================================================== Drive session

    /** Call only after BiometricPrompt succeeded (the unlock window). The Activity starts DriveService. */
    fun startDrive() {
        if (core.value.driveActive) return
        speechOut.init()
        core.update { it.copy(driveActive = true, lastActivityMs = clock()) }
        connection.acquire(HOLD_DRIVE)
        startIdleWatch()
        speechOut.speak(if (connection.isConnected) "Ready." else "Ready. Still connecting to your PC.")
        core.value.confirm?.let { if (confirmJob?.isActive != true) runVoiceConfirm(it) }
        maybeDrainQueue()
    }

    fun endDrive(reason: EndReason) {
        if (!core.value.driveActive) return
        listenJob?.cancel(); confirmJob?.cancel(); drainJob?.cancel(); workingJob?.cancel(); idleJob?.cancel()
        heldSpeech.clear()
        speechOut.stopAll()
        core.update { it.copy(driveActive = false, queueQuestion = null, awaitingReply = false) }
        connection.release(HOLD_DRIVE)
        when (reason) {
            EndReason.Idle -> {
                speechOut.speak("Drive session ended.")
                addItem(ConversationItem.Kind.System, "Drive session ended after ${prefs.idleTimeoutMin} minutes idle.")
            }
            else -> addItem(ConversationItem.Kind.System, "Drive session ended.")
        }
    }

    /** Read directly from core state (the combined [state] can lag by a frame). */
    val isDriveActive: Boolean get() = core.value.driveActive

    private fun touch() = core.update { it.copy(lastActivityMs = clock()) }

    private fun startIdleWatch() {
        idleJob?.cancel()
        idleJob = scope.launch {
            while (isActive) {
                val timeoutMs = prefs.idleTimeoutMin * 60_000L
                val remaining = core.value.lastActivityMs + timeoutMs - clock()
                if (remaining <= 0) {
                    endDrive(EndReason.Idle)
                    break
                }
                delay(minOf(remaining, 15_000L))
            }
        }
    }

    // ================================================================== Push-to-talk

    private val dialogActive: Boolean get() = confirmJob?.isActive == true || drainJob?.isActive == true && core.value.queueQuestion != null

    /** Steering-wheel button, notification Talk action or the on-screen Talk button. */
    fun onTalk() {
        if (!core.value.driveActive) {
            notice("Start a Drive session to talk.")
            return
        }
        touch()
        when {
            dialogActive -> when {
                speechIn.listening.value -> speechIn.finish()
                speechOut.speaking.value -> speechOut.stopAll() // skip the prompt, go straight to listening
            }
            listenJob?.isActive == true -> speechIn.finish() // press while listening → stop listening
            speechOut.speaking.value -> { // barge-in
                speechOut.stopAll()
                heldSpeech.clear()
                startListening()
            }
            else -> startListening()
        }
    }

    private fun startListening() {
        listenJob?.cancel()
        listenJob = scope.launch {
            try {
                earcons.listenStart()
                delay(EARCON_GAP_MS)
                val r = speechIn.listen(SpeechInput.Config.Utterance)
                earcons.listenStop()
                val text = r.text?.trim()
                when {
                    !text.isNullOrEmpty() -> {
                        core.update { it.copy(lastHeard = text) }
                        submitUtterance(text, PhoneMessage.SOURCE_VOICE)
                    }
                    r.error != null -> notice("The microphone didn't work (error ${r.error}). Try again.")
                }
            } finally {
                speechIn.clearPartial()
            }
        }.also { it.releaseSpeechWhenDone() }
    }

    /** Held speak frames play once nothing is listening or in a dialog any more. */
    private fun Job.releaseSpeechWhenDone() {
        invokeOnCompletion { scope.launch { releaseHeldSpeech() } }
    }

    /** Voice or typed user turn. "Stop everything" always becomes a kill. */
    fun submitUtterance(text: String, source: String) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        if (PhraseMatcher.isStopEverything(clean)) {
            killEverything()
            return
        }
        if (!core.value.driveActive) {
            notice("Start a Drive session to send commands.")
            return
        }
        touch()
        addItem(ConversationItem.Kind.User, clean)
        if (connection.isConnected && connection.send(PhoneMessage.Utterance(text = clean, source = source))) {
            awaitReply()
        } else {
            scope.launch {
                queue.add(QueuedUtterance(UUID.randomUUID().toString(), clean, source, clock()))
                addItem(ConversationItem.Kind.System, "Held until your PC is reachable (up to 30 minutes).")
                if (source == PhoneMessage.SOURCE_VOICE) speechOut.speak("Lost connection. I'll hold that.")
            }
        }
    }

    private fun awaitReply() {
        core.update { it.copy(awaitingReply = true, progressLabel = null) }
        workingJob?.cancel()
        workingJob = scope.launch {
            delay(WORKING_EARCON_AFTER_MS)
            if (core.value.awaitingReply && !speechOut.speaking.value && !speechIn.listening.value) earcons.working()
            delay(AWAIT_REPLY_TIMEOUT_MS)
            core.update { it.copy(awaitingReply = false) }
        }
    }

    // ================================================================== Kill / cancel / sessions

    /** Big red button or "stop everything". Never needs the unlock window and never asks for confirmation. */
    fun killEverything() {
        val sent = connection.send(PhoneMessage.Kill)
        listenJob?.cancel(); confirmJob?.cancel(); drainJob?.cancel(); workingJob?.cancel(); confirmExpiryJob?.cancel()
        confirmQueue.clear()
        heldSpeech.clear()
        speechOut.stopAll()
        core.update { it.copy(confirm = null, queueQuestion = null, awaitingReply = false, progressLabel = null) }
        addItem(
            if (sent) ConversationItem.Kind.System else ConversationItem.Kind.Error,
            if (sent) "Stop everything sent to your PC." else "Couldn't reach your PC to stop it.",
        )
        val line = if (sent) "Stopping everything." else "I can't reach your PC right now."
        if (core.value.driveActive) speechOut.speak(line, SpeakPriority.Interrupt) else notice(line)
    }

    fun cancelCurrentTurn() {
        val turnId = core.value.activeTurns.firstOrNull()
        if (connection.send(PhoneMessage.TurnCancel(turnId))) {
            addItem(ConversationItem.Kind.System, "Cancel requested.")
        } else {
            notice("Not connected to your PC.")
        }
    }

    fun selectSession(id: String) = sendCommand(PhoneMessage.SessionSelect(id))
    fun newSession(name: String) = sendCommand(PhoneMessage.SessionNew(name.trim()))
    fun resetSession(id: String?) = sendCommand(PhoneMessage.SessionReset(id))

    /** Ask the PC for its recent Claude Code sessions (read-only, so no Drive session needed). */
    fun loadCatalog() {
        if (connection.send(PhoneMessage.CatalogList)) {
            core.update { it.copy(catalogLoading = true) }
            catalogTimeoutJob?.cancel()
            catalogTimeoutJob = scope.launch {
                delay(CATALOG_TIMEOUT_MS)
                if (core.value.catalogLoading) {
                    core.update { it.copy(catalogLoading = false, catalog = it.catalog ?: emptyList()) }
                    notice("Your PC didn't send its session list. Try again.")
                }
            }
        } else {
            notice("Not connected to your PC.")
        }
    }
    private var catalogTimeoutJob: Job? = null

    /** Continue an existing PC session from the phone (hand-off). */
    fun attachSession(claudeSessionId: String) = sendCommand(PhoneMessage.SessionAttach(claudeSessionId))

    /** Hand a session back to the PC: the phone lets go of it so the desktop app can carry on. */
    fun releaseSession(sessionId: String) = sendCommand(PhoneMessage.SessionRelease(sessionId))

    /** Tells the PC whether Claude should keep its spoken updates plain (no file names or code). */
    fun setPlainUpdates(on: Boolean) {
        if (connection.send(PhoneMessage.SettingsSet(plainUpdates = on))) {
            core.update { it.copy(plainUpdates = on) }
        } else {
            notice("Not connected to your PC.")
        }
    }

    /** Turning it on loosens safety, so it needs an unlocked Drive session; turning it off never does. */
    fun setSkipConfirmations(on: Boolean) {
        if (on && !core.value.driveActive) {
            notice("Start a Drive session to turn this on.")
            return
        }
        if (connection.send(PhoneMessage.SettingsSet(skipConfirmations = on))) {
            core.update { it.copy(skipConfirmations = on) }
        } else {
            notice("Not connected to your PC.")
        }
    }

    private fun sendCommand(msg: PhoneMessage): Boolean {
        if (!core.value.driveActive) {
            notice("Start a Drive session to send commands.")
            return false
        }
        touch()
        val ok = connection.send(msg)
        if (!ok) notice("Not connected to your PC.")
        return ok
    }

    // ================================================================== Speech out

    private fun onSpeak(text: String, priority: SpeakPriority) {
        workingJob?.cancel()
        core.update { it.copy(awaitingReply = false) }
        if (!core.value.driveActive) {
            // Replies are only read aloud during a Drive session. Say so, instead of leaving it looking like a fault.
            if (priority != SpeakPriority.Low) noteUnspoken("A reply came in but wasn't spoken, because no Drive session is running. Tap Unlock to start one.")
            return
        }
        touch()
        val busy = speechIn.listening.value || listenJob?.isActive == true || dialogActive
        if (busy) {
            if (priority == SpeakPriority.Low) return // low may be dropped while listening
            if (priority == SpeakPriority.Interrupt) heldSpeech.addFirst(text to priority) else heldSpeech.addLast(text to priority)
            return
        }
        speechOut.speak(text, priority)
    }

    private fun releaseHeldSpeech() {
        if (speechIn.listening.value || listenJob?.isActive == true || dialogActive) return
        while (heldSpeech.isNotEmpty()) {
            val (t, p) = heldSpeech.removeFirst()
            speechOut.speak(t, if (p == SpeakPriority.Interrupt) SpeakPriority.Normal else p)
        }
    }

    fun testVoice() {
        speechOut.init()
        speechOut.speak("G'day. This is how I'll sound in the car.", SpeakPriority.Interrupt)
    }

    /** Loads the voice list (the speech engine must be started first). */
    fun loadVoices() = speechOut.init()

    /** Switch voice straight away and play a sample; the caller saves the choice. */
    fun previewVoice(name: String?) {
        speechOut.voiceName = name
        testVoice()
    }

    // ================================================================== Frames

    private fun onFrame(f: HelperFrame) {
        if (f.replay) {
            onReplayFrame(f)
            return
        }
        if (collapser.hasPending) flushReplay()
        when (val m = f.message) {
            is HelperMessage.AuthOk -> {
                // A different session may have been made active (from the PC or a browser) while this phone was away.
                val switched = core.value.activeSessionId.let { it != null && it != m.activeSessionId }
                core.update {
                    it.copy(
                        conversation = if (switched) emptyList() else it.conversation,
                        helperName = m.helperName,
                        sessions = m.sessions,
                        activeSessionId = m.activeSessionId,
                        pcDisabled = m.disabled,
                        pcBusy = m.sessions.any { s -> s.busy },
                        activeTurns = emptySet(),
                        awaitingReply = false,
                    )
                }
                if (m.disabled) notice("Roam Desk is switched off on your PC.")
                // An empty Conversation tab (fresh install, update, or the app was closed) is refilled from the PC.
                if (core.value.conversation.isEmpty()) loadHistory(manual = false)
                maybeDrainQueue()
            }
            is HelperMessage.TurnStarted -> core.update {
                it.copy(activeTurns = it.activeTurns + m.turnId, awaitingReply = false, progressLabel = null)
            }
            is HelperMessage.ReplyDelta -> appendDelta(m.turnId, m.text)
            is HelperMessage.TurnProgress -> onProgress(m.turnId, m.label, live = true)
            is HelperMessage.Speak -> onSpeak(m.text, m.speakPriority)
            is HelperMessage.TurnDone -> onTurnDone(m)
            is HelperMessage.TurnFailed -> onTurnFailed(m)
            is HelperMessage.ConfirmRequest -> onConfirmRequest(m)
            is HelperMessage.ConfirmResolved -> onConfirmResolved(m)
            is HelperMessage.SessionList -> {
                val switched = core.value.activeSessionId.let { it != null && m.activeSessionId != null && it != m.activeSessionId }
                core.update {
                    it.copy(sessions = m.sessions, activeSessionId = m.activeSessionId, conversation = if (switched) emptyList() else it.conversation)
                }
                if (switched) loadSessionHistory()
            }
            is HelperMessage.Catalog -> {
                catalogTimeoutJob?.cancel()
                core.update { it.copy(catalog = m.items, catalogLoading = false) }
            }
            is HelperMessage.FileOffer -> onFileOffer(m)
            is HelperMessage.AppUpdate -> Unit // handled by AppUpdater
            is HelperMessage.History -> onHistory(m)
            is HelperMessage.Status -> core.update {
                it.copy(pcBusy = m.busy, pcQueued = m.queued, pcDisabled = m.disabled, skipConfirmations = m.skipConfirmations, plainUpdates = m.plainUpdates)
            }
            is HelperMessage.HelperError -> {
                core.update { it.copy(catalogLoading = false) }
                addItem(ConversationItem.Kind.Error, "PC error: ${m.message.ifBlank { m.code }}")
                core.update { it.copy(awaitingReply = false) }
            }
            is HelperMessage.Unknown -> {
                if (m.malformed) Log.w(TAG, "Malformed ${m.type} frame ignored")
                if (m.type == "catalog") {
                    catalogTimeoutJob?.cancel()
                    core.update { it.copy(catalogLoading = false, catalog = it.catalog ?: emptyList()) }
                    notice("Couldn't read the session list from your PC.")
                }
            }
            HelperMessage.Pong, is HelperMessage.AuthChallenge, is HelperMessage.AuthFail -> Unit
        }
    }

    private fun onReplayFrame(f: HelperFrame) {
        collapser.offer(f, clock())
        when (val m = f.message) {
            is HelperMessage.ReplyDelta -> appendDelta(m.turnId, m.text)
            is HelperMessage.TurnProgress -> onProgress(m.turnId, m.label, live = false)
            is HelperMessage.TurnDone -> onTurnDone(m)
            is HelperMessage.TurnFailed -> onTurnFailed(m)
            is HelperMessage.SessionList -> core.update { it.copy(sessions = m.sessions, activeSessionId = m.activeSessionId) }
            is HelperMessage.Status -> core.update {
                it.copy(pcBusy = m.busy, pcQueued = m.queued, pcDisabled = m.disabled, skipConfirmations = m.skipConfirmations, plainUpdates = m.plainUpdates)
            }
            is HelperMessage.ConfirmResolved -> onConfirmResolved(m)
            is HelperMessage.FileOffer -> onFileOffer(m)
            // A replayed confirm.request is stale: the PC denies pending confirmations when the socket drops.
            else -> Unit
        }
        replayFlushJob?.cancel()
        replayFlushJob = scope.launch {
            delay(REPLAY_QUIET_MS)
            flushReplay()
        }
    }

    private fun flushReplay() {
        replayFlushJob?.cancel()
        val lines = collapser.flush()
        lines.forEach { u ->
            if (u.text.startsWith("While you were away")) addItem(ConversationItem.Kind.System, u.text)
            onSpeak(u.text, u.priority)
        }
    }

    private fun appendDelta(turnId: String, text: String) {
        val existing = replyItemByTurn[turnId]
        if (existing == null) {
            val id = addItem(ConversationItem.Kind.Reply, text, turnId)
            replyItemByTurn[turnId] = id
        } else {
            core.update { c -> c.copy(conversation = c.conversation.map { if (it.id == existing) it.copy(text = it.text + text) else it }) }
        }
    }

    private fun onProgress(turnId: String, label: String, live: Boolean) {
        if (live) {
            touch()
            core.update { it.copy(progressLabel = label) }
        }
        val last = core.value.conversation.lastOrNull()
        if (last?.kind == ConversationItem.Kind.Progress && last.turnId == turnId && last.text == label) return
        addItem(ConversationItem.Kind.Progress, label, turnId)
    }

    private fun onTurnDone(m: HelperMessage.TurnDone) {
        val existing = replyItemByTurn.remove(m.turnId)
        if (existing != null && m.text.isNotBlank()) {
            core.update { c -> c.copy(conversation = c.conversation.map { if (it.id == existing) it.copy(text = m.text) else it }) }
        } else if (existing == null && m.text.isNotBlank()) {
            addItem(ConversationItem.Kind.Reply, m.text, m.turnId)
        }
        core.update {
            it.copy(
                activeTurns = it.activeTurns - m.turnId,
                lastReply = m.text.ifBlank { it.lastReply },
                progressLabel = null,
                awaitingReply = false,
            )
        }
    }

    private fun onTurnFailed(m: HelperMessage.TurnFailed) {
        replyItemByTurn.remove(m.turnId)
        addItem(ConversationItem.Kind.Error, m.error.ifBlank { "The task stopped." }, m.turnId)
        core.update {
            it.copy(
                activeTurns = it.activeTurns - m.turnId,
                lastReply = m.error.ifBlank { "The task stopped." },
                progressLabel = null,
                awaitingReply = false,
            )
        }
    }

    private fun onDisconnected() {
        workingJob?.cancel()
        // PROTOCOL.md: if the socket drops, the PC denies the pending confirmation. Never queue one.
        val hadConfirm = core.value.confirm != null || confirmQueue.isNotEmpty()
        confirmJob?.cancel(); confirmExpiryJob?.cancel(); drainJob?.cancel()
        confirmQueue.clear()
        core.update { it.copy(confirm = null, queueQuestion = null, awaitingReply = false, activeTurns = emptySet(), pcBusy = false, progressLabel = null) }
        addItem(ConversationItem.Kind.System, "Lost connection to your PC.")
        if (core.value.driveActive) {
            if (hadConfirm) {
                speechOut.speak("Lost connection. That approval was cancelled.", SpeakPriority.Interrupt)
            } else {
                earcons.problem()
            }
        }
    }

    private fun onUnpaired() {
        endDrive(EndReason.Unpaired)
        confirmQueue.clear()
        replyItemByTurn.clear()
        collapser.reset()
        core.value = Core(notice = core.value.notice)
    }

    // ================================================================== Confirmation (PROTOCOL.md §Spoken confirmation flow)

    private fun onConfirmRequest(req: HelperMessage.ConfirmRequest) {
        if (core.value.confirm?.request?.confirmId == req.confirmId || confirmQueue.any { it.confirmId == req.confirmId }) return
        addItem(ConversationItem.Kind.System, "Approval needed: ${req.summary}", req.turnId)
        confirmQueue.addLast(req)
        if (core.value.confirm == null) nextConfirm()
    }

    private fun nextConfirm() {
        confirmExpiryJob?.cancel()
        val req = confirmQueue.removeFirstOrNull()
        if (req == null) {
            core.update { it.copy(confirm = null) }
            releaseHeldSpeech()
            maybeDrainQueue()
            return
        }
        val pending = PendingConfirm(req, clock() + req.expiresInS * 1000L)
        core.update { it.copy(confirm = pending) }
        confirmExpiryJob = scope.launch {
            delay(req.expiresInS * 1000L + 1_000L)
            if (core.value.confirm?.request?.confirmId == req.confirmId) {
                // The PC has treated it as a timeout by now; just clear our side.
                confirmJob?.cancel()
                addItem(ConversationItem.Kind.System, "Approval timed out: ${req.summary}")
                nextConfirm()
            }
        }
        if (core.value.driveActive) runVoiceConfirm(pending)
    }

    private fun runVoiceConfirm(pending: PendingConfirm) {
        val req = pending.request
        drainJob?.cancel()
        listenJob?.cancel()
        confirmJob?.cancel()
        speechOut.stopAll() // interrupt any current speech
        confirmJob = scope.launch {
            var heard = ""
            val prompt = "${req.summary.trim().trimEnd('.')}. Say '${req.phrase}' to go ahead, or 'cancel'."
            val remaining = pending.deadlineMs - clock()
            val decision = withTimeoutOrNull(remaining.coerceAtLeast(1)) {
                for (attempt in 0 until 2) {
                    speechOut.speakAndWait(if (attempt == 0) prompt else "Sorry, I didn't catch that. $prompt")
                    earcons.listenStart()
                    delay(EARCON_GAP_MS)
                    val r = speechIn.listen(SpeechInput.Config.Confirmation)
                    earcons.listenStop()
                    heard = r.text.orEmpty()
                    if (PhraseMatcher.isStopEverything(heard)) return@withTimeoutOrNull null
                    when (PhraseMatcher.matchConfirmation(heard, req.phrase, req.tier)) {
                        ConfirmMatch.Confirm -> return@withTimeoutOrNull Decision.CONFIRM
                        ConfirmMatch.Cancel -> return@withTimeoutOrNull Decision.CANCEL
                        ConfirmMatch.Unclear -> Unit
                    }
                }
                Decision.CANCEL // still unclear after one repeat → cancel
            }
            when {
                decision == null && PhraseMatcher.isStopEverything(heard) -> {
                    respondConfirm(req, Decision.CANCEL, heard, spokenFeedback = false)
                    killEverything()
                }
                decision == null -> respondConfirm(req, Decision.TIMEOUT, heard, spokenFeedback = true)
                else -> respondConfirm(req, decision, heard, spokenFeedback = true)
            }
        }.also { it.releaseSpeechWhenDone() }
    }

    /** On-screen Confirm / Cancel (for when parked). */
    fun onConfirmButton(confirm: Boolean) {
        val pending = core.value.confirm ?: return
        if (confirm && !core.value.driveActive) {
            notice("Start a Drive session to approve.")
            return
        }
        confirmJob?.cancel()
        speechOut.stopAll()
        respondConfirm(pending.request, if (confirm) Decision.CONFIRM else Decision.CANCEL, HEARD_SCREEN, spokenFeedback = false)
    }

    private fun respondConfirm(req: HelperMessage.ConfirmRequest, decision: String, heard: String, spokenFeedback: Boolean) {
        if (core.value.confirm?.request?.confirmId != req.confirmId) return
        if (decision == Decision.CONFIRM && !core.value.driveActive) return
        touch()
        val sent = connection.send(PhoneMessage.ConfirmResponse(req.confirmId, decision, heard))
        val (item, spoken) = when (decision) {
            Decision.CONFIRM -> "Approved: ${req.summary}" to "Going ahead."
            Decision.CANCEL -> "Cancelled: ${req.summary}" to "Cancelled."
            else -> "Timed out: ${req.summary}" to "That approval timed out."
        }
        addItem(ConversationItem.Kind.System, item, req.turnId)
        if (!sent) addItem(ConversationItem.Kind.Error, "Couldn't send that. Your PC will treat it as declined.")
        if (spokenFeedback && core.value.driveActive) speechOut.speak(spoken)
        nextConfirm()
    }

    private fun onConfirmResolved(m: HelperMessage.ConfirmResolved) {
        confirmQueue.removeAll { it.confirmId == m.confirmId }
        if (core.value.confirm?.request?.confirmId != m.confirmId) return
        confirmJob?.cancel()
        speechOut.stopAll()
        if (m.by == "server") {
            val text = when (m.decision) {
                Decision.TIMEOUT -> "That approval timed out."
                Decision.CONFIRM -> "Approved on your PC."
                else -> "That approval was cancelled."
            }
            addItem(ConversationItem.Kind.System, text)
            if (core.value.driveActive) speechOut.speak(text)
        }
        nextConfirm()
    }

    // ================================================================== Offline queue ("Still want me to …?")

    private fun maybeDrainQueue() {
        val c = core.value
        if (!c.driveActive || !connection.isConnected || c.confirm != null || drainJob?.isActive == true) return
        drainJob = scope.launch {
            try {
                delay(QUEUE_DRAIN_DELAY_MS) // let any "While you were away" summary go first
                while (isActive) {
                    val item = queue.pending().firstOrNull() ?: break
                    if (!connection.isConnected || !core.value.driveActive || core.value.confirm != null) break
                    listenJob?.join()
                    speechOut.speaking.first { !it }
                    core.update { it.copy(queueQuestion = item.text) }
                    val question = "Still want me to ${asContinuation(item.text)}?"
                    var answer = YesNo.Unclear
                    for (attempt in 0 until 2) {
                        speechOut.speakAndWait(if (attempt == 0) question else "Sorry, yes or no? $question")
                        earcons.listenStart()
                        delay(EARCON_GAP_MS)
                        val r = speechIn.listen(SpeechInput.Config.YesNo)
                        earcons.listenStop()
                        if (PhraseMatcher.isStopEverything(r.text)) {
                            core.update { it.copy(queueQuestion = null) }
                            killEverything()
                            return@launch
                        }
                        answer = PhraseMatcher.matchYesNo(r.text)
                        if (answer != YesNo.Unclear) break
                    }
                    core.update { it.copy(queueQuestion = null) }
                    if (answer == YesNo.Yes) {
                        val sent = connection.send(
                            PhoneMessage.Utterance(text = item.text, source = item.source, queuedAt = item.queuedAt),
                        )
                        if (!sent) break // stays queued
                        queue.remove(item.id)
                        touch()
                        addItem(ConversationItem.Kind.User, item.text)
                        awaitReply()
                    } else {
                        queue.remove(item.id)
                        addItem(ConversationItem.Kind.System, "Dropped: ${item.text}")
                        speechOut.speakAndWait("Okay, I've dropped that.")
                    }
                }
            } finally {
                core.update { it.copy(queueQuestion = null) }
            }
        }.also { it.releaseSpeechWhenDone() }
    }

    private fun asContinuation(text: String): String {
        val t = text.trim().trimEnd('.', '?', '!')
        if (t.isEmpty()) return t
        val first = t.substringBefore(' ')
        return if (first == "I" || first.startsWith("I'")) t else t.replaceFirstChar { it.lowercase() }
    }

    // ================================================================== UI helpers

    private fun addItem(kind: ConversationItem.Kind, text: String, turnId: String? = null): Long {
        val id = nextItemId++
        core.update { c ->
            val list = (c.conversation + ConversationItem(id, kind, text, turnId, clock())).takeLast(MAX_ITEMS)
            c.copy(conversation = list)
        }
        return id
    }

    private var historyManual = false
    private var historyForced = false

    /** After a session switch the screen is empty, so the new session's history is loaded even if a turn is running elsewhere. */
    private fun loadSessionHistory() {
        loadHistory(manual = false)
        historyForced = true
    }

    /** Asks the PC for the recent conversation of the active session (read from Claude's own session record there). */
    fun loadHistory(manual: Boolean = true) {
        historyManual = manual
        if (!connection.send(PhoneMessage.HistoryGet()) && manual) notice("Not connected to your PC.")
    }

    /**
     * The PC's copy replaces what's on screen: it already contains every finished turn, so nothing is lost.
     * Files Claude sent are kept (they aren't in Claude's record), and nothing is touched while a turn is running.
     */
    private fun onHistory(m: HelperMessage.History) {
        val manual = historyManual
        historyManual = false
        val forced = historyForced
        historyForced = false
        if (!forced && (core.value.activeTurns.isNotEmpty() || core.value.awaitingReply)) {
            if (manual) notice("Claude is busy right now. Try again when it has finished.")
            return
        }
        if (m.items.isEmpty()) {
            if (manual) notice("No earlier conversation found on your PC for this session.")
            return
        }
        val fromPc = m.items.map {
            ConversationItem(
                nextItemId++,
                if (it.role == "user") ConversationItem.Kind.User else ConversationItem.Kind.Reply,
                it.text,
                null,
                if (it.ts > 0) it.ts else clock(),
            )
        }
        core.update { c ->
            val files = c.conversation.filter { it.kind == ConversationItem.Kind.File }
            c.copy(conversation = (fromPc + files).sortedBy { it.ts }.takeLast(MAX_ITEMS))
        }
    }

    /** A file from Claude: show a card in the conversation (once) and start fetching it. */
    private fun onFileOffer(o: HelperMessage.FileOffer) {
        files?.receive(o)
        if (core.value.conversation.any { it.file?.fileId == o.fileId }) return
        val id = nextItemId++
        core.update { c ->
            c.copy(conversation = (c.conversation + ConversationItem(id, ConversationItem.Kind.File, o.name, o.turnId, clock(), o)).takeLast(MAX_ITEMS))
        }
    }

    private fun notice(text: String) {
        core.update { it.copy(notice = Notice(nextItemId++, text)) }
    }

    fun consumeNotice(id: Long) {
        core.update { if (it.notice?.id == id) it.copy(notice = null) else it }
    }

    private fun linkOf(s: HelperConnection.State): Pair<LinkStatus, String> = when (s) {
        HelperConnection.State.NotPaired -> LinkStatus.NotPaired to "Not paired"
        HelperConnection.State.Stopped -> LinkStatus.Offline to "Not connected"
        is HelperConnection.State.Connecting -> LinkStatus.Connecting to "Connecting to ${s.host}"
        is HelperConnection.State.Connected -> LinkStatus.Online to "Connected via ${s.host}"
        is HelperConnection.State.Waiting -> LinkStatus.Offline to s.reason
        is HelperConnection.State.AuthFailed -> LinkStatus.Rejected to s.reason
    }

    companion object {
        private const val TAG = "DriveStateMachine"
        const val HOLD_DRIVE = "drive"
        const val HEARD_SCREEN = "[on-screen button]"
        private const val EARCON_GAP_MS = 180L
        private const val WORKING_EARCON_AFTER_MS = 1_500L
private const val CATALOG_TIMEOUT_MS = 10_000L
        private const val AWAIT_REPLY_TIMEOUT_MS = 90_000L
        private const val REPLAY_QUIET_MS = 800L
        private const val UNSPOKEN_NOTICE_GAP_MS = 30_000L
        private const val QUEUE_DRAIN_DELAY_MS = 1_500L
        private const val MAX_ITEMS = 300
    }
}
