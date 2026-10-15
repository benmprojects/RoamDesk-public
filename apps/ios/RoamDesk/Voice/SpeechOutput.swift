import AVFoundation
import Observation

/// Speaks replies through AVSpeechSynthesizer, preferring an Australian English voice.
@MainActor
@Observable
final class SpeechOutput: NSObject, AVSpeechSynthesizerDelegate {
    struct VoiceOption: Identifiable, Equatable {
        let id: String
        let name: String
        let language: String
        let quality: String
    }

    private(set) var speaking = false
    private(set) var voices: [VoiceOption] = []
    var rate: Double = 1.0
    /// Identifier of the chosen voice; nil = automatic.
    var voiceId: String?

    private let synth = AVSpeechSynthesizer()
    private var inFlight = 0
    private var waiters: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Loads the voice list and prepares the speech engine.
    func prepare() {
        voices = Self.installedVoices()
    }

    static func installedVoices() -> [VoiceOption] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .sorted { a, b in
                let au = { (v: AVSpeechSynthesisVoice) in v.language == "en-AU" ? 0 : 1 }
                if au(a) != au(b) { return au(a) < au(b) }
                if a.quality.rawValue != b.quality.rawValue { return a.quality.rawValue > b.quality.rawValue }
                return a.name < b.name
            }
            .map { VoiceOption(id: $0.identifier, name: $0.name, language: $0.language, quality: qualityName($0.quality)) }
    }

    private static func qualityName(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q {
        case .premium: return "Premium"
        case .enhanced: return "Enhanced"
        default: return "Standard"
        }
    }

    private func chosenVoice() -> AVSpeechSynthesisVoice? {
        if let voiceId, let v = AVSpeechSynthesisVoice(identifier: voiceId) { return v }
        let au = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-AU" }
        return au.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "en-AU")
    }

    /// Queues `text` to be spoken. `.interrupt` stops whatever is being said first.
    func speak(_ text: String, _ priority: SpeakPriority = .normal) {
        let clean = SpeechText.clean(text)
        guard !clean.isEmpty else { return }
        if priority == .interrupt { stopAll() }
        enqueue(clean, waiter: nil)
    }

    /// Speaks `text` and returns when it has finished (or was stopped).
    func speakAndWait(_ text: String) async {
        let clean = SpeechText.clean(text)
        guard !clean.isEmpty else { return }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                if Task.isCancelled { cont.resume(); return }
                enqueue(clean, waiter: cont)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.stopAll() }
        }
    }

    func stopAll() {
        synth.stopSpeaking(at: .immediate)
        resumeAllWaiters()
    }

    private func enqueue(_ text: String, waiter: CheckedContinuation<Void, Never>?) {
        let u = AVSpeechUtterance(string: text)
        u.voice = chosenVoice()
        let r = Float(AVSpeechUtteranceDefaultSpeechRate) * Float(rate)
        u.rate = min(max(r, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
        u.postUtteranceDelay = 0.05
        if let waiter { waiters[ObjectIdentifier(u)] = waiter }
        inFlight += 1
        speaking = true
        synth.speak(u)
    }

    private func finished(_ u: AVSpeechUtterance) {
        inFlight = max(0, inFlight - 1)
        if inFlight == 0 { speaking = false }
        waiters.removeValue(forKey: ObjectIdentifier(u))?.resume()
    }

    private func resumeAllWaiters() {
        let all = waiters
        waiters.removeAll()
        inFlight = 0
        speaking = false
        for (_, w) in all { w.resume() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.finished(utterance) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.finished(utterance) }
    }
}
