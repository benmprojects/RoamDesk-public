import Foundation
import Observation
import os

/// The single source of truth for a Drive session: voice in/out, the PC link, confirmations,
/// the offline queue and the conversation. Everything runs on the main actor.
///
/// Unlock window: commands (utterance, session.*, confirm) are only sent while a Drive session is active.
/// kill, turn.cancel and a *cancel* confirm.response are always allowed because they only stop things.
@MainActor
@Observable
final class DriveModel {
    // MARK: observable state

    private(set) var driveActive = false
    private(set) var helperName = ""
    private(set) var sessions: [Session] = []
    private(set) var activeSessionId: String?
    /// Recent Claude Code sessions on the PC; nil until requested.
    private(set) var catalog: [CatalogItem]?
    private(set) var catalogLoading = false
    private(set) var pcBusy = false
    private(set) var pcQueued = 0
    private(set) var pcDisabled = false
    private(set) var skipConfirmations = false
    private(set) var plainUpdates = true
    private(set) var activeTurns: Set<String> = []
    private(set) var awaitingReply = false
    private(set) var progressLabel: String?
    private(set) var lastReply = ""
    private(set) var lastHeard = ""
    private(set) var confirm: PendingConfirm?
    private(set) var queueQuestion: String?
    private(set) var conversation: [ConversationItem] = []
    var notice: Notice?
    #if DEBUG
    private(set) var demoPhase: DrivePhase?
    #endif

    // MARK: collaborators

    let connection: HelperConnection
    let settings: SettingsStore
    let queue: OfflineQueue
    let speechIn: SpeechInput
    let speechOut: SpeechOutput
    let earcons: Earcons
    let files: FileInbox
    let remote = RemoteCommands()

    private let log = Logger(subsystem: "au.com.roamdesk.ios", category: "Drive")
    private let clock: () -> Int64

    // MARK: private state

    private let collapser = ReplayCollapser()
    private let listenJob = JobSlot()
    private let confirmJob = JobSlot()
    private let confirmExpiryJob = JobSlot()
    private let drainJob = JobSlot()
    private let workingJob = JobSlot()
    private let idleJob = JobSlot()
    private let replayFlushJob = JobSlot()
    private let catalogTimeoutJob = JobSlot()
    private var confirmQueue: [ConfirmRequest] = []
    private var heldSpeech: [(String, SpeakPriority)] = []
    private var replyItemByTurn: [String: Int] = [:]
    private var nextItemId = 1
    private var wasConnected = false
    private var lastUnspokenNoticeAt: Int64 = 0
    private var lastActivityMs: Int64 = 0
    private var historyManual = false
    private var historyForced = false

    private static let holdDrive = "drive"
    static let heardScreen = "[on-screen button]"
    private let earconGap: UInt64 = 180_000_000
    private let maxItems = 300

    init(connection: HelperConnection, settings: SettingsStore, queue: OfflineQueue,
         speechIn: SpeechInput, speechOut: SpeechOutput, earcons: Earcons, files: FileInbox,
         clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.connection = connection
        self.settings = settings
        self.queue = queue
        self.speechIn = speechIn
        self.speechOut = speechOut
        self.earcons = earcons
        self.files = files
        self.clock = clock
        connection.onFrame = { [weak self] f in self?.onFrame(f) }
        remote.onTalk = { [weak self] in self?.onTalk() }
        applyPrefs()
    }

    // MARK: derived state for the UI

    var paired: Bool { settings.pairing != nil }
    var offlineQueued: Int { queue.count }
    var activeSession: Session? { sessions.first { $0.id == activeSessionId } }
    var partialTranscript: String { speechIn.listening ? speechIn.partial : "" }

    var link: LinkStatus {
        #if DEBUG
        if demoPhase != nil { return .online }
        #endif
        return Self.linkOf(connection.state).0
    }
    var linkDetail: String { Self.linkOf(connection.state).1 }

    var phase: DrivePhase {
        #if DEBUG
        if let demoPhase { return demoPhase }
        #endif
        let l = link
        if confirm != nil && driveActive { return .confirming }
        if speechIn.listening { return .listening }
        if speechOut.speaking { return .speaking }
        if l != .online { return .offline }
        if confirm != nil { return .confirming }
        if !activeTurns.isEmpty || awaitingReply || pcBusy || queueQuestion != nil { return .thinking }
        return .idle
    }

    private static func linkOf(_ s: HelperConnection.State) -> (LinkStatus, String) {
        switch s {
        case .notPaired: return (.notPaired, "Not paired")
        case .stopped: return (.offline, "Not connected")
        case let .connecting(host): return (.connecting, "Connecting to \(host)")
        case let .connected(host, _, _): return (.online, "Connected via \(host)")
        case let .waiting(_, reason): return (.offline, reason)
        case let .authFailed(reason): return (.rejected, reason)
        }
    }

    /// Pushes saved settings into the speech engine. Call after they change.
    func applyPrefs() {
        speechOut.rate = settings.speechRate
        if speechOut.voiceId != settings.voiceId { speechOut.voiceId = settings.voiceId }
    }

    /// Called by the app when the connection state changes, so a drop is noticed (drives the "lost connection" handling).
    func connectionStateChanged() {
        let now = connection.isConnected
        if wasConnected && !now { onDisconnected() }
        wasConnected = now
        if !paired && driveActive { endDrive(.unpaired) }
    }

    func pairingCleared() {
        endDrive(.unpaired)
        confirmQueue.removeAll()
        replyItemByTurn.removeAll()
        collapser.reset()
        sessions = []; activeSessionId = nil; catalog = nil; conversation = []
        confirm = nil; queueQuestion = nil; activeTurns = []; awaitingReply = false
        lastReply = ""; lastHeard = ""; progressLabel = nil; helperName = ""
    }

    // MARK: Drive session

    /// Call only after the unlock gate succeeded.
    func startDrive() {
        guard !driveActive else { return }
        speechOut.prepare()
        AudioSession.activate()
        driveActive = true
        lastActivityMs = clock()
        connection.acquire(Self.holdDrive)
        remote.start(title: helperName.isEmpty ? "Roam Desk" : helperName)
        startIdleWatch()
        speechOut.speak(connection.isConnected ? "Ready." : "Ready. Still connecting to your PC.")
        if let c = confirm, !confirmJob.running { runVoiceConfirm(c) }
        maybeDrainQueue()
    }

    func endDrive(_ reason: EndReason) {
        guard driveActive else { return }
        listenJob.cancel(); confirmJob.cancel(); drainJob.cancel(); workingJob.cancel(); idleJob.cancel()
        heldSpeech.removeAll()
        speechOut.stopAll()
        driveActive = false
        queueQuestion = nil
        awaitingReply = false
        remote.stop()
        connection.release(Self.holdDrive)
        switch reason {
        case .idle:
            speechOut.speak("Drive session ended.")
            addItem(.system, "Drive session ended after \(settings.idleTimeoutMin) minutes idle.")
        default:
            addItem(.system, "Drive session ended.")
        }
    }

    private func touch() { lastActivityMs = clock() }

    private func startIdleWatch() {
        idleJob.start { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let timeoutMs = Int64(self.settings.idleTimeoutMin) * 60_000
                let remaining = self.lastActivityMs + timeoutMs - self.clock()
                if remaining <= 0 {
                    self.endDrive(.idle)
                    return
                }
                try? await Task.sleep(nanoseconds: UInt64(min(remaining, 15_000)) * 1_000_000)
            }
        }
    }

    // MARK: Push-to-talk

    private var dialogActive: Bool { confirmJob.running || (drainJob.running && queueQuestion != nil) }

    /// Headset button, or the on-screen Talk button.
    func onTalk() {
        guard driveActive else {
            notify("Start a Drive session to talk.")
            return
        }
        touch()
        if dialogActive {
            if speechIn.listening { speechIn.finish() } else if speechOut.speaking { speechOut.stopAll() }
        } else if listenJob.running {
            speechIn.finish() // press while listening: stop listening
        } else if speechOut.speaking { // barge-in
            speechOut.stopAll()
            heldSpeech.removeAll()
            startListening()
        } else {
            startListening()
        }
    }

    private func startListening() {
        listenJob.start({ [weak self] in
            guard let self else { return }
            defer { self.speechIn.clearPartial() }
            self.earcons.listenStart()
            try? await Task.sleep(nanoseconds: self.earconGap)
            if Task.isCancelled { return }
            let r = await self.speechIn.listen(.utterance)
            self.earcons.listenStop()
            if let text = r.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                self.lastHeard = text
                self.submitUtterance(text, source: PhoneMessage.sourceVoice)
            } else if let e = r.error {
                self.notify("The microphone didn't work (\(e)). Try again.")
            }
        }, onDone: { [weak self] in self?.releaseHeldSpeech() })
    }

    /// Voice or typed user turn. "Stop everything" always becomes a kill.
    func submitUtterance(_ text: String, source: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if PhraseMatcher.isStopEverything(clean) {
            killEverything()
            return
        }
        guard driveActive else {
            notify("Start a Drive session to send commands.")
            return
        }
        touch()
        addItem(.user, clean)
        if connection.isConnected && connection.send(.utterance(text: clean, source: source)) {
            awaitReply()
        } else {
            queue.add(QueuedUtterance(id: ProtocolCodec.newId(), text: clean, source: source, queuedAt: clock()))
            addItem(.system, "Held until your PC is reachable (up to 30 minutes).")
            if source == PhoneMessage.sourceVoice { speechOut.speak("Lost connection. I'll hold that.") }
        }
    }

    private func awaitReply() {
        awaitingReply = true
        progressLabel = nil
        workingJob.start { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, !Task.isCancelled else { return }
            if self.awaitingReply && !self.speechOut.speaking && !self.speechIn.listening { self.earcons.working() }
            try? await Task.sleep(nanoseconds: 90_000_000_000)
            if !Task.isCancelled { self.awaitingReply = false }
        }
    }

    // MARK: Kill / cancel / sessions

    /// Big red button or "stop everything". Never needs the unlock window and never asks for confirmation.
    func killEverything() {
        let sent = connection.send(.kill)
        listenJob.cancel(); confirmJob.cancel(); drainJob.cancel(); workingJob.cancel(); confirmExpiryJob.cancel()
        confirmQueue.removeAll()
        heldSpeech.removeAll()
        speechOut.stopAll()
        confirm = nil; queueQuestion = nil; awaitingReply = false; progressLabel = nil
        addItem(sent ? .system : .error, sent ? "Stop everything sent to your PC." : "Couldn't reach your PC to stop it.")
        let line = sent ? "Stopping everything." : "I can't reach your PC right now."
        if driveActive { speechOut.speak(line, .interrupt) } else { notify(line) }
    }

    func cancelCurrentTurn() {
        if connection.send(.turnCancel(turnId: activeTurns.first)) {
            addItem(.system, "Cancel requested.")
        } else {
            notify("Not connected to your PC.")
        }
    }

    func selectSession(_ id: String) { _ = sendCommand(.sessionSelect(sessionId: id)) }
    func newSession(_ name: String) { _ = sendCommand(.sessionNew(name: name.trimmingCharacters(in: .whitespaces))) }
    func resetSession(_ id: String?) { _ = sendCommand(.sessionReset(sessionId: id)) }
    func attachSession(_ claudeSessionId: String) { _ = sendCommand(.sessionAttach(claudeSessionId: claudeSessionId)) }
    func releaseSession(_ id: String) { _ = sendCommand(.sessionRelease(sessionId: id)) }

    /// Ask the PC for its recent Claude Code sessions (read-only, so no Drive session needed).
    func loadCatalog() {
        guard connection.send(.catalogList) else { notify("Not connected to your PC."); return }
        catalogLoading = true
        catalogTimeoutJob.start { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard let self, !Task.isCancelled, self.catalogLoading else { return }
            self.catalogLoading = false
            if self.catalog == nil { self.catalog = [] }
            self.notify("Your PC didn't send its session list. Try again.")
        }
    }

    /// Tells the PC whether Claude should keep its spoken updates plain (no file names or code).
    func setPlainUpdates(_ on: Bool) {
        if connection.send(.settingsSet(plainUpdates: on)) { plainUpdates = on } else { notify("Not connected to your PC.") }
    }

    /// Turning it on loosens safety, so it needs an unlocked Drive session; turning it off never does.
    func setSkipConfirmations(_ on: Bool) {
        if on && !driveActive { notify("Start a Drive session to turn this on."); return }
        if connection.send(.settingsSet(skipConfirmations: on)) { skipConfirmations = on } else { notify("Not connected to your PC.") }
    }

    private func sendCommand(_ msg: PhoneMessage) -> Bool {
        guard driveActive else { notify("Start a Drive session to send commands."); return false }
        touch()
        let ok = connection.send(msg)
        if !ok { notify("Not connected to your PC.") }
        return ok
    }

    // MARK: Speech out

    private func noteUnspoken(_ text: String) {
        let now = clock()
        if now - lastUnspokenNoticeAt < 30_000 { return }
        lastUnspokenNoticeAt = now
        addItem(.system, text)
    }

    private func onSpeak(_ text: String, _ priority: SpeakPriority) {
        workingJob.cancel()
        awaitingReply = false
        guard driveActive else {
            // Replies are only read aloud during a Drive session. Say so, instead of leaving it looking like a fault.
            if priority != .low { noteUnspoken("A reply came in but wasn't spoken, because no Drive session is running. Tap Unlock to start one.") }
            return
        }
        touch()
        if speechIn.listening || listenJob.running || dialogActive {
            if priority == .low { return } // low may be dropped while listening
            if priority == .interrupt { heldSpeech.insert((text, priority), at: 0) } else { heldSpeech.append((text, priority)) }
            return
        }
        speechOut.speak(text, priority)
    }

    private func releaseHeldSpeech() {
        if speechIn.listening || listenJob.running || dialogActive { return }
        while !heldSpeech.isEmpty {
            let (t, p) = heldSpeech.removeFirst()
            speechOut.speak(t, p == .interrupt ? .normal : p)
        }
    }

    func testVoice() {
        speechOut.prepare()
        AudioSession.activate()
        speechOut.speak("G'day. This is how I'll sound in the car.", .interrupt)
    }

    func previewVoice(_ id: String?) {
        speechOut.voiceId = id
        testVoice()
    }

    // MARK: Frames

    private func onFrame(_ f: HelperFrame) {
        if f.replay { onReplayFrame(f); return }
        if collapser.hasPending { flushReplay() }
        switch f.message {
        case let .authOk(m):
            // A different session may have been made active (from the PC or a browser) while this phone was away.
            let switched = activeSessionId != nil && activeSessionId != m.activeSessionId
            if switched { conversation = [] }
            helperName = m.helperName
            sessions = m.sessions
            activeSessionId = m.activeSessionId
            pcDisabled = m.disabled
            pcBusy = m.sessions.contains { $0.busy }
            activeTurns = []
            awaitingReply = false
            if m.disabled { notify("Roam Desk is switched off on your PC.") }
            // An empty Conversation tab (fresh install, update, or the app was closed) is refilled from the PC.
            if conversation.isEmpty { loadHistory(manual: false) }
            maybeDrainQueue()
        case let .turnStarted(turnId, _, _):
            activeTurns.insert(turnId); awaitingReply = false; progressLabel = nil
        case let .replyDelta(turnId, text): appendDelta(turnId, text)
        case let .turnProgress(turnId, label): onProgress(turnId, label, live: true)
        case let .speak(_, text, priority): onSpeak(text, priority)
        case let .turnDone(turnId, text, _): onTurnDone(turnId, text)
        case let .turnFailed(turnId, error): onTurnFailed(turnId, error)
        case let .confirmRequest(req): onConfirmRequest(req)
        case let .confirmResolved(id, decision, by): onConfirmResolved(id, decision, by)
        case let .sessionList(list, active):
            let switched = activeSessionId != nil && active != nil && activeSessionId != active
            sessions = list
            activeSessionId = active
            if switched {
                conversation = []
                loadHistory(manual: false)
                historyForced = true
            }
        case let .catalog(items):
            catalogTimeoutJob.cancel()
            catalog = items
            catalogLoading = false
        case let .fileOffer(o): onFileOffer(o)
        case let .history(_, items): onHistory(items)
        case let .status(s):
            pcBusy = s.busy; pcQueued = s.queued; pcDisabled = s.disabled
            skipConfirmations = s.skipConfirmations; plainUpdates = s.plainUpdates
        case let .error(code, message):
            catalogLoading = false
            addItem(.error, "PC error: \(message.isEmpty ? code : message)")
            awaitingReply = false
        case let .unknown(type, malformed):
            if malformed { log.warning("Malformed \(type, privacy: .public) frame ignored") }
            if type == "catalog" {
                catalogTimeoutJob.cancel()
                catalogLoading = false
                if catalog == nil { catalog = [] }
                notify("Couldn't read the session list from your PC.")
            }
        case .pong, .authChallenge, .authFail: break
        }
    }

    private func onReplayFrame(_ f: HelperFrame) {
        collapser.offer(f, nowMs: clock())
        switch f.message {
        case let .replyDelta(turnId, text): appendDelta(turnId, text)
        case let .turnProgress(turnId, label): onProgress(turnId, label, live: false)
        case let .turnDone(turnId, text, _): onTurnDone(turnId, text)
        case let .turnFailed(turnId, error): onTurnFailed(turnId, error)
        case let .sessionList(list, active): sessions = list; activeSessionId = active
        case let .status(s):
            pcBusy = s.busy; pcQueued = s.queued; pcDisabled = s.disabled
            skipConfirmations = s.skipConfirmations; plainUpdates = s.plainUpdates
        case let .confirmResolved(id, decision, by): onConfirmResolved(id, decision, by)
        case let .fileOffer(o): onFileOffer(o)
        default: break // a replayed confirm.request is stale: the PC denies pending confirmations when the socket drops
        }
        replayFlushJob.start { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            if !Task.isCancelled { self?.flushReplay() }
        }
    }

    private func flushReplay() {
        replayFlushJob.cancel()
        for u in collapser.flush() {
            if u.text.hasPrefix("While you were away") { addItem(.system, u.text) }
            onSpeak(u.text, u.priority)
        }
    }

    private func appendDelta(_ turnId: String, _ text: String) {
        if let id = replyItemByTurn[turnId], let i = conversation.firstIndex(where: { $0.id == id }) {
            conversation[i].text += text
        } else {
            replyItemByTurn[turnId] = addItem(.reply, text, turnId: turnId)
        }
    }

    private func onProgress(_ turnId: String, _ label: String, live: Bool) {
        if live { touch(); progressLabel = label }
        if let last = conversation.last, last.kind == .progress, last.turnId == turnId, last.text == label { return }
        addItem(.progress, label, turnId: turnId)
    }

    private func onTurnDone(_ turnId: String, _ text: String) {
        let existing = replyItemByTurn.removeValue(forKey: turnId)
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if let existing, hasText, let i = conversation.firstIndex(where: { $0.id == existing }) {
            conversation[i].text = text
        } else if existing == nil && hasText {
            addItem(.reply, text, turnId: turnId)
        }
        activeTurns.remove(turnId)
        if hasText { lastReply = text }
        progressLabel = nil
        awaitingReply = false
    }

    private func onTurnFailed(_ turnId: String, _ error: String) {
        replyItemByTurn.removeValue(forKey: turnId)
        let msg = error.isEmpty ? "The task stopped." : error
        addItem(.error, msg, turnId: turnId)
        activeTurns.remove(turnId)
        lastReply = msg
        progressLabel = nil
        awaitingReply = false
    }

    private func onDisconnected() {
        workingJob.cancel()
        // PROTOCOL.md: if the socket drops, the PC denies the pending confirmation. Never queue one.
        let hadConfirm = confirm != nil || !confirmQueue.isEmpty
        confirmJob.cancel(); confirmExpiryJob.cancel(); drainJob.cancel()
        confirmQueue.removeAll()
        confirm = nil; queueQuestion = nil; awaitingReply = false; activeTurns = []; pcBusy = false; progressLabel = nil
        addItem(.system, "Lost connection to your PC.")
        if driveActive {
            if hadConfirm { speechOut.speak("Lost connection. That approval was cancelled.", .interrupt) } else { earcons.problem() }
        }
    }

    // MARK: Confirmation (PROTOCOL.md, Spoken confirmation flow)

    private func onConfirmRequest(_ req: ConfirmRequest) {
        if confirm?.request.confirmId == req.confirmId || confirmQueue.contains(where: { $0.confirmId == req.confirmId }) { return }
        addItem(.system, "Approval needed: \(req.summary)", turnId: req.turnId)
        confirmQueue.append(req)
        if confirm == nil { nextConfirm() }
    }

    private func nextConfirm() {
        confirmExpiryJob.cancel()
        guard !confirmQueue.isEmpty else {
            confirm = nil
            releaseHeldSpeech()
            maybeDrainQueue()
            return
        }
        let req = confirmQueue.removeFirst()
        let pending = PendingConfirm(request: req, deadline: Date().addingTimeInterval(Double(req.expiresInS)))
        confirm = pending
        confirmExpiryJob.start { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(req.expiresInS + 1) * 1_000_000_000)
            guard let self, !Task.isCancelled else { return }
            if self.confirm?.request.confirmId == req.confirmId {
                // The PC has treated it as a timeout by now; just clear our side.
                self.confirmJob.cancel()
                self.addItem(.system, "Approval timed out: \(req.summary)")
                self.nextConfirm()
            }
        }
        if driveActive { runVoiceConfirm(pending) }
    }

    private func runVoiceConfirm(_ pending: PendingConfirm) {
        let req = pending.request
        drainJob.cancel()
        listenJob.cancel()
        speechOut.stopAll() // interrupt any current speech
        confirmJob.start({ [weak self] in
            guard let self else { return }
            var heard = ""
            let summary = req.summary.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "."))
            let prompt = "\(summary). Say '\(req.phrase)' to go ahead, or 'cancel'."
            let remaining = pending.deadline.timeIntervalSinceNow
            let decision: String? = await withDeadline(max(remaining, 0.001)) { [weak self] () -> String? in
                guard let self else { return nil }
                for attempt in 0..<2 {
                    await self.speechOut.speakAndWait(attempt == 0 ? prompt : "Sorry, I didn't catch that. \(prompt)")
                    if Task.isCancelled { return nil }
                    self.earcons.listenStart()
                    try? await Task.sleep(nanoseconds: self.earconGap)
                    let r = await self.speechIn.listen(.confirmation)
                    self.earcons.listenStop()
                    heard = r.text ?? ""
                    if PhraseMatcher.isStopEverything(heard) { return nil }
                    switch PhraseMatcher.matchConfirmation(heard, phrase: req.phrase, tier: req.tier) {
                    case .confirm: return Decision.confirm
                    case .cancel: return Decision.cancel
                    case .unclear: break
                    }
                }
                return Decision.cancel // still unclear after one repeat: cancel
            }
            if Task.isCancelled { return }
            if decision == nil && PhraseMatcher.isStopEverything(heard) {
                self.respondConfirm(req, Decision.cancel, heard, spokenFeedback: false)
                self.killEverything()
            } else if let decision {
                self.respondConfirm(req, decision, heard, spokenFeedback: true)
            } else {
                self.respondConfirm(req, Decision.timeout, heard, spokenFeedback: true)
            }
        }, onDone: { [weak self] in self?.releaseHeldSpeech() })
    }

    /// On-screen Confirm / Cancel (for when parked).
    func onConfirmButton(_ yes: Bool) {
        guard let pending = confirm else { return }
        if yes && !driveActive { notify("Start a Drive session to approve."); return }
        confirmJob.cancel()
        speechOut.stopAll()
        respondConfirm(pending.request, yes ? Decision.confirm : Decision.cancel, Self.heardScreen, spokenFeedback: false)
    }

    private func respondConfirm(_ req: ConfirmRequest, _ decision: String, _ heard: String, spokenFeedback: Bool) {
        guard confirm?.request.confirmId == req.confirmId else { return }
        if decision == Decision.confirm && !driveActive { return }
        touch()
        let sent = connection.send(.confirmResponse(confirmId: req.confirmId, decision: decision, heard: heard))
        let (item, spoken): (String, String)
        switch decision {
        case Decision.confirm: (item, spoken) = ("Approved: \(req.summary)", "Going ahead.")
        case Decision.cancel: (item, spoken) = ("Cancelled: \(req.summary)", "Cancelled.")
        default: (item, spoken) = ("Timed out: \(req.summary)", "That approval timed out.")
        }
        addItem(.system, item, turnId: req.turnId)
        if !sent { addItem(.error, "Couldn't send that. Your PC will treat it as declined.") }
        if spokenFeedback && driveActive { speechOut.speak(spoken) }
        nextConfirm()
    }

    private func onConfirmResolved(_ id: String, _ decision: String, _ by: String) {
        confirmQueue.removeAll { $0.confirmId == id }
        guard confirm?.request.confirmId == id else { return }
        confirmJob.cancel()
        speechOut.stopAll()
        if by == "server" {
            let text: String
            switch decision {
            case Decision.timeout: text = "That approval timed out."
            case Decision.confirm: text = "Approved on your PC."
            default: text = "That approval was cancelled."
            }
            addItem(.system, text)
            if driveActive { speechOut.speak(text) }
        }
        nextConfirm()
    }

    // MARK: Offline queue ("Still want me to ...?")

    private func maybeDrainQueue() {
        guard driveActive, connection.isConnected, confirm == nil, !drainJob.running else { return }
        drainJob.start({ [weak self] in
            guard let self else { return }
            defer { self.queueQuestion = nil }
            try? await Task.sleep(nanoseconds: 1_500_000_000) // let any "While you were away" summary go first
            while !Task.isCancelled {
                guard let item = self.queue.pending().first else { break }
                if !self.connection.isConnected || !self.driveActive || self.confirm != nil { break }
                while (self.listenJob.running || self.speechOut.speaking) && !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
                if Task.isCancelled { return }
                self.queueQuestion = item.text
                let question = "Still want me to \(Self.asContinuation(item.text))?"
                var answer = YesNo.unclear
                for attempt in 0..<2 {
                    await self.speechOut.speakAndWait(attempt == 0 ? question : "Sorry, yes or no? \(question)")
                    if Task.isCancelled { return }
                    self.earcons.listenStart()
                    try? await Task.sleep(nanoseconds: self.earconGap)
                    let r = await self.speechIn.listen(.yesNo)
                    self.earcons.listenStop()
                    if PhraseMatcher.isStopEverything(r.text) {
                        self.queueQuestion = nil
                        self.killEverything()
                        return
                    }
                    answer = PhraseMatcher.matchYesNo(r.text)
                    if answer != .unclear { break }
                }
                self.queueQuestion = nil
                if answer == .yes {
                    let sent = self.connection.send(.utterance(text: item.text, source: item.source, queuedAt: item.queuedAt))
                    if !sent { break } // stays queued
                    self.queue.remove(id: item.id)
                    self.touch()
                    self.addItem(.user, item.text)
                    self.awaitReply()
                } else {
                    self.queue.remove(id: item.id)
                    self.addItem(.system, "Dropped: \(item.text)")
                    await self.speechOut.speakAndWait("Okay, I've dropped that.")
                }
            }
        }, onDone: { [weak self] in self?.releaseHeldSpeech() })
    }

    static func asContinuation(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: ".?!"))
        guard !t.isEmpty else { return t }
        let first = t.split(separator: " ", maxSplits: 1).first.map(String.init) ?? t
        if first == "I" || first.hasPrefix("I'") { return t }
        return t.prefix(1).lowercased() + t.dropFirst()
    }

    #if DEBUG
    /// Sample data for screenshots: `-demo YES -demoPhase listening -demoConfirm YES -demoDrive YES`.
    func loadDemo() {
        let d = UserDefaults.standard
        helperName = "MY-PC"
        sessions = [
            Session(id: "s1", name: "home", cwd: "C:\\Users\\user\\Documents", model: "sonnet", busy: false),
            Session(id: "s2", name: "reports", cwd: "C:\\Projects\\Reports", model: "sonnet", busy: true),
        ]
        activeSessionId = "s1"
        lastReply = "Done. I found three PDFs in Downloads and moved them to Reports."
        demoPhase = DrivePhase(rawValue: (d.string(forKey: "demoPhase") ?? "idle").capitalized) ?? .idle
        driveActive = d.bool(forKey: "demoDrive")
        let t = clock()
        conversation = [
            ConversationItem(id: 1, kind: .user, text: "Check the disk space on C drive.", turnId: nil, ts: t, file: nil),
            ConversationItem(id: 2, kind: .progress, text: "Checking disk space", turnId: "t1", ts: t, file: nil),
            ConversationItem(id: 3, kind: .reply, text: "C: has **412 GB** free of 953 GB. Nothing needs cleaning up yet.", turnId: "t1", ts: t, file: nil),
            ConversationItem(id: 4, kind: .user, text: "Move the PDFs in Downloads to the Reports folder.", turnId: nil, ts: t, file: nil),
            ConversationItem(id: 5, kind: .system, text: "Approval needed: Move 3 files to C:\\Projects\\Reports", turnId: "t2", ts: t, file: nil),
            ConversationItem(id: 6, kind: .reply, text: lastReply, turnId: "t2", ts: t, file: nil),
        ]
        if d.bool(forKey: "demoConfirm") {
            confirm = PendingConfirm(
                request: ConfirmRequest(confirmId: "c1", turnId: "t2", tier: 2, summary: "Move 3 files from Downloads to C:\\Projects\\Reports",
                                        command: "Move-Item C:\\Users\\user\\Downloads\\*.pdf C:\\Projects\\Reports", phrase: "confirm move", expiresInS: 45),
                deadline: Date().addingTimeInterval(40))
        }
    }
    #endif

    // MARK: UI helpers

    @discardableResult
    private func addItem(_ kind: ConversationItem.Kind, _ text: String, turnId: String? = nil) -> Int {
        let id = nextItemId
        nextItemId += 1
        conversation.append(ConversationItem(id: id, kind: kind, text: text, turnId: turnId, ts: clock(), file: nil))
        if conversation.count > maxItems { conversation.removeFirst(conversation.count - maxItems) }
        return id
    }

    /// Asks the PC for the recent conversation of the active session (read from Claude's own session record there).
    func loadHistory(manual: Bool = true) {
        historyManual = manual
        if !connection.send(.historyGet()) && manual { notify("Not connected to your PC.") }
    }

    /// The PC's copy replaces what's on screen: it already contains every finished turn, so nothing is lost.
    /// Files Claude sent are kept (they aren't in Claude's record), and nothing is touched while a turn is running.
    private func onHistory(_ items: [HistoryItem]) {
        let manual = historyManual
        historyManual = false
        let forced = historyForced
        historyForced = false
        if !forced && (!activeTurns.isEmpty || awaitingReply) {
            if manual { notify("Claude is busy right now. Try again when it has finished.") }
            return
        }
        if items.isEmpty {
            if manual { notify("No earlier conversation found on your PC for this session.") }
            return
        }
        var fromPc: [ConversationItem] = []
        for it in items {
            let id = nextItemId
            nextItemId += 1
            fromPc.append(ConversationItem(id: id, kind: it.role == "user" ? .user : .reply, text: it.text, turnId: nil, ts: it.ts > 0 ? it.ts : clock(), file: nil))
        }
        let files = conversation.filter { $0.kind == .file }
        conversation = Array((fromPc + files).sorted { $0.ts < $1.ts }.suffix(maxItems))
    }

    /// A file from Claude: show a card in the conversation (once) and start fetching it.
    private func onFileOffer(_ o: FileOffer) {
        files.receive(o)
        if conversation.contains(where: { $0.file?.fileId == o.fileId }) { return }
        let id = nextItemId
        nextItemId += 1
        conversation.append(ConversationItem(id: id, kind: .file, text: o.name, turnId: o.turnId, ts: clock(), file: o))
        if conversation.count > maxItems { conversation.removeFirst(conversation.count - maxItems) }
    }

    private func notify(_ text: String) {
        notice = Notice(id: nextItemId, text: text)
        nextItemId += 1
    }
}
