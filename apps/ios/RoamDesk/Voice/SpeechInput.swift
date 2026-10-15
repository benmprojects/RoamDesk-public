import AVFoundation
import Observation
import Speech

/// Apple speech recognition, en-AU, on-device when the phone supports it, with partial results for the screen.
@MainActor
@Observable
final class SpeechInput {
    struct Config {
        /// Hard limit on how long the microphone stays open.
        let windowS: TimeInterval
        /// Extend the window once (by `windowS`) if speech is heard. Used by the confirmation window.
        let extendOnceOnSpeech: Bool
        /// Close the microphone if nothing at all is said within this long.
        let noSpeechS: TimeInterval
        /// Close it once the transcript has stopped changing for this long after speech.
        let trailingSilenceS: TimeInterval

        static let utterance = Config(windowS: 30, extendOnceOnSpeech: false, noSpeechS: 8, trailingSilenceS: 2.0)
        static let confirmation = Config(windowS: 8, extendOnceOnSpeech: true, noSpeechS: 6, trailingSilenceS: 1.2)
        static let yesNo = Config(windowS: 8, extendOnceOnSpeech: true, noSpeechS: 6, trailingSilenceS: 1.2)
    }

    struct Result {
        let text: String?
        let heardSpeech: Bool
        let error: String?
        var isEmpty: Bool { (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private(set) var listening = false
    private(set) var partial = ""

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-AU")) ?? SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var timer: Task<Void, Never>?
    private var continuation: CheckedContinuation<Result, Never>?

    private var lastText = ""
    private var heardSpeech = false
    private var lastChange = Date()
    private var finishing = false
    private var failure: String?

    var isAvailable: Bool { recognizer?.isAvailable ?? false }

    static func requestPermissions() async -> Bool {
        let speech = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        let mic = await AVAudioApplication.requestRecordPermission()
        return speech && mic
    }

    static var permissionsGranted: Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized && AVAudioApplication.shared.recordPermission == .granted
    }

    func clearPartial() { partial = "" }

    /// Stops listening now and returns what was heard so far.
    func finish() {
        guard listening, !finishing else { return }
        beginFinish()
    }

    /// Opens the mic once and returns the best transcript (or nil text on silence or error). Cancellable.
    func listen(_ config: Config) async -> Result {
        guard let recognizer, recognizer.isAvailable else {
            return Result(text: nil, heardSpeech: false, error: "Speech recognition isn't available right now.")
        }
        abort()
        AudioSession.activate()

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        lastText = ""; heardSpeech = false; lastChange = Date(); finishing = false; failure = nil; partial = ""

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            return Result(text: nil, heardSpeech: false, error: "The microphone isn't available.")
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            req.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            return Result(text: nil, heardSpeech: false, error: "The microphone didn't start (\(error.localizedDescription)).")
        }
        listening = true

        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<Result, Never>) in
                continuation = cont
                task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                    let text = result?.bestTranscription.formattedString
                    let final = result?.isFinal ?? false
                    let message = error?.localizedDescription
                    Task { @MainActor in self?.handle(text: text, isFinal: final, error: message) }
                }
                startTimer(config)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.abort() }
        }
    }

    // MARK: internals

    private func startTimer(_ config: Config) {
        timer?.cancel()
        let started = Date()
        timer = Task { [weak self] in
            var extended = false
            var limit = config.windowS
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, self.listening, !self.finishing else { return }
                let elapsed = Date().timeIntervalSince(started)
                if elapsed >= limit {
                    if config.extendOnceOnSpeech, self.heardSpeech, !extended {
                        extended = true
                        limit += config.windowS
                    } else {
                        self.beginFinish(); return
                    }
                }
                if !self.heardSpeech, elapsed >= config.noSpeechS { self.beginFinish(); return }
                if self.heardSpeech, Date().timeIntervalSince(self.lastChange) >= config.trailingSilenceS { self.beginFinish(); return }
            }
        }
    }

    private func handle(text: String?, isFinal: Bool, error: String?) {
        guard listening else { return }
        if let text, !text.isEmpty {
            if text != lastText { lastText = text; lastChange = Date() }
            heardSpeech = true
            partial = text
        }
        if let error, !isFinal, !finishing {
            // "No speech detected" arrives as an error; treat it as an empty result rather than a fault.
            if !heardSpeech { failure = nil } else { failure = error }
            beginFinish()
            return
        }
        if isFinal { resolve() }
    }

    private func beginFinish() {
        guard !finishing else { return }
        finishing = true
        timer?.cancel()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // The recogniser normally delivers a final result straight away; don't wait on it for long.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            self?.resolve()
        }
    }

    private func resolve() {
        guard let cont = continuation else { return }
        continuation = nil
        timer?.cancel()
        task?.cancel()
        task = nil
        request = nil
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        listening = false
        let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
        cont.resume(returning: Result(text: text.isEmpty ? nil : text, heardSpeech: heardSpeech, error: text.isEmpty ? failure : nil))
    }

    /// Cancels without waiting for a final result (the listening job was cancelled).
    private func abort() {
        guard listening || continuation != nil else { return }
        finishing = true
        resolve()
    }
}
