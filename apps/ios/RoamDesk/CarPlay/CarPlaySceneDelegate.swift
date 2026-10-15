import CarPlay
import Observation
import UIKit

/// Roam Desk on the car's screen: Apple's "voice-based conversational app" category, shown with a voice control
/// template. The big state (Ready, Listening, Thinking, Speaking, Approval needed) mirrors the Drive screen, and the
/// action buttons below it are Talk, Stop everything and, when Claude asks, Confirm and Cancel.
///
/// This only comes alive once Apple has granted the `com.apple.developer.carplay-voice-based-conversation`
/// entitlement and it is in the app's provisioning profile (see apps/ios/README.md). Without it, iOS never
/// connects this scene, so the phone app is unaffected.
@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var shownKey = ""
    private var pendingRender: Task<Void, Never>?
    private var observing = false

    // MARK: scene lifecycle

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        let app = AppContainer.shared
        app.connection.acquire("carplay")
        observing = true
        render(force: true)
        observe()
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        observing = false
        pendingRender?.cancel()
        self.interfaceController = nil
        shownKey = ""
        AppContainer.shared.connection.release("carplay")
    }

    // MARK: following the Drive state

    /// Re-renders whenever something the car screen shows changes.
    private func observe() {
        guard observing else { return }
        withObservationTracking {
            _ = self.snapshot()
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.observing else { return }
                self.scheduleRender()
                self.observe()
            }
        }
    }

    /// The car applies its own rate limit to state changes, so bursts are folded into one update.
    private func scheduleRender() {
        pendingRender?.cancel()
        pendingRender = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            if !Task.isCancelled { self?.render(force: false) }
        }
    }

    private struct Snapshot: Equatable {
        var state: CarState
        var headline: String
        var detail: String
        var driveActive: Bool
        var confirmId: String?
    }

    enum CarState: String { case idle, listening, thinking, speaking, attention, locked, offline }

    private func snapshot() -> Snapshot {
        let d = AppContainer.shared.drive
        let state: CarState
        var headline = "", detail = ""
        if let c = d.confirm {
            state = .attention
            headline = "Approval needed"
            detail = c.request.summary
        } else if !d.paired {
            state = .locked
            headline = "Not paired"
            detail = "Pair Roam Desk with your PC on your iPhone"
        } else if d.link != .online {
            state = .offline
            headline = "Offline"
            detail = d.linkDetail
        } else if !d.driveActive {
            state = .locked
            headline = "Unlock on your iPhone"
            detail = "Start a Drive session to talk"
        } else {
            switch d.phase {
            case .listening: state = .listening; headline = "Listening"; detail = d.partialTranscript
            case .thinking: state = .thinking; headline = "Working on it"; detail = d.progressLabel ?? ""
            case .speaking: state = .speaking; headline = "Speaking"
            case .confirming: state = .attention; headline = "Approval needed"
            default: state = .idle; headline = "Ready"; detail = "Press Talk"
            }
        }
        return Snapshot(state: state, headline: headline, detail: String(detail.prefix(90)),
                        driveActive: d.driveActive, confirmId: d.confirm?.request.confirmId)
    }

    // MARK: building the template

    private func render(force: Bool) {
        guard let interfaceController else { return }
        let s = snapshot()
        let key = "\(s.state.rawValue)|\(s.headline)|\(s.detail)|\(s.driveActive)|\(s.confirmId ?? "")"
        guard force || key != shownKey else { return }
        shownKey = key

        let titles = [s.detail.isEmpty ? nil : "\(s.headline). \(s.detail)", s.headline].compactMap { $0 }
        let state = CPVoiceControlState(identifier: s.state.rawValue, titleVariants: titles,
                                        image: Self.icon(for: s.state), repeats: s.state == .listening || s.state == .thinking)
        if #available(iOS 26.4, *) { state.actionButtons = Self.buttons(for: s) }
        let template = CPVoiceControlTemplate(voiceControlStates: [state])
        interfaceController.setRootTemplate(template, animated: false, completion: nil)
    }

    @available(iOS 26.4, *)
    private static func buttons(for s: Snapshot) -> [CPButton] {
        let app = AppContainer.shared
        func button(_ title: String, _ symbol: String, enabled: Bool = true, _ action: @escaping @MainActor () -> Void) -> CPButton {
            let b = CPButton(image: symbolImage(symbol)) { _ in Task { @MainActor in action() } }
            b.title = title
            b.isEnabled = enabled
            return b
        }
        var out: [CPButton] = []
        if s.confirmId != nil {
            out.append(button("Confirm", "checkmark.circle.fill", enabled: s.driveActive) { app.drive.onConfirmButton(true) })
            out.append(button("Cancel", "xmark.circle.fill") { app.drive.onConfirmButton(false) })
        } else if s.driveActive {
            out.append(button(s.state == .listening ? "Done" : "Talk", s.state == .listening ? "stop.fill" : "mic.fill") { app.drive.onTalk() })
        }
        out.append(button("Stop everything", "stop.circle.fill") { app.drive.killEverything() })
        return Array(out.prefix(max(1, CPVoiceControlState.maximumActionButtonCount)))
    }

    // MARK: images (display-ready, at most 150 x 150 pt)

    private static func symbolImage(_ name: String) -> UIImage {
        let cfg = UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold)
        return (UIImage(systemName: name, withConfiguration: cfg) ?? UIImage()).withRenderingMode(.alwaysTemplate)
    }

    private static func icon(for state: CarState) -> UIImage {
        let (symbol, colour): (String, UIColor) = {
            switch state {
            case .idle: return ("waveform", UIColor(hex: 0x8E99AB))
            case .listening: return ("mic.fill", UIColor(hex: 0xF0936A))
            case .thinking: return ("ellipsis.circle.fill", UIColor(hex: 0xA594FF))
            case .speaking: return ("speaker.wave.3.fill", UIColor(hex: 0x45C7AE))
            case .attention: return ("exclamationmark.shield.fill", UIColor(hex: 0xF5BE4F))
            case .locked: return ("lock.fill", UIColor(hex: 0x8E99AB))
            case .offline: return ("wifi.slash", UIColor(hex: 0x6B7380))
            }
        }()
        let cfg = UIImage.SymbolConfiguration(pointSize: 96, weight: .regular)
        return (UIImage(systemName: symbol, withConfiguration: cfg) ?? UIImage())
            .withTintColor(colour, renderingMode: .alwaysOriginal)
    }
}
