import SwiftUI

/// Glanceable: ring, one line of context, a big Talk button and Stop everything. Nothing to read while moving.
struct DriveView: View {
    @Environment(AppContainer.self) private var app
    let openSessions: () -> Void
    @State private var unlocking = false

    var body: some View {
        let d = app.drive
        VStack(spacing: 12) {
            HStack {
                SessionChip(name: d.activeSession?.name, busy: d.pcBusy, action: openSessions)
                Spacer(minLength: 8)
                ConnectionPill(link: d.link, helperName: d.helperName)
            }

            Spacer(minLength: 0)
            VStack(spacing: 16) {
                StateRing(phase: d.phase)
                contextLine(d)
            }
            Spacer(minLength: 0)

            if d.offlineQueued > 0 {
                Label("\(d.offlineQueued) held until your PC is back", systemImage: "clock")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            }

            if d.driveActive {
                Button { d.onTalk() } label: {
                    Label(talkTitle(d.phase), systemImage: d.phase == .listening ? "stop.fill" : "mic.fill")
                }
                .buttonStyle(BigButtonStyle(fill: d.phase == .listening ? Theme.color(.listening) : Theme.accent, height: 96))
                HStack {
                    Label("Unlocked · ends after \(d.settings.idleTimeoutMin) min idle", systemImage: "lock.open")
                        .font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                    if d.phase == .thinking && d.link == .online {
                        Button("Cancel task") { d.cancelCurrentTurn() }.font(.footnote.weight(.semibold))
                    }
                    Button("End drive") { d.endDrive(.user) }.font(.footnote.weight(.semibold))
                }
            } else {
                Button {
                    Task {
                        unlocking = true
                        defer { unlocking = false }
                        guard await UnlockGate.unlock() else { return }
                        if !SpeechInput.permissionsGranted, !(await SpeechInput.requestPermissions()) {
                            d.notice = Notice(id: Int.random(in: 1...Int.max), text: "Allow the microphone and speech recognition in Settings to use Drive.")
                            return
                        }
                        d.startDrive()
                    }
                } label: {
                    Label("Start Drive session", systemImage: "lock.fill")
                }
                .buttonStyle(BigButtonStyle(height: 88))
                .disabled(!d.paired || unlocking)
                Text("Unlock with Face ID or your passcode. Commands only go to your PC during a Drive session.")
                    .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            StopEverythingButton { d.killEverything() }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    private func talkTitle(_ p: DrivePhase) -> String {
        switch p {
        case .listening: return "Done"
        case .speaking: return "Interrupt & talk"
        default: return "Talk"
        }
    }

    @ViewBuilder
    private func contextLine(_ d: DriveModel) -> some View {
        let (text, emphasise): (String, Bool) = {
            if d.phase == .listening { return (d.partialTranscript.isEmpty ? "Go ahead…" : d.partialTranscript, true) }
            if let q = d.queueQuestion { return ("Still want me to: \(q)?", true) }
            if d.phase == .thinking, let p = d.progressLabel { return (p, false) }
            if d.phase == .offline && d.link != .online { return (d.linkDetail, false) }
            if !d.lastReply.isEmpty { return (d.lastReply, false) }
            if d.driveActive { return ("Press your headset button or Talk.", false) }
            return ("", false)
        }()
        if !text.isEmpty {
            Text(text)
                .font(emphasise ? .title2.weight(.medium) : .title3)
                .foregroundStyle(emphasise ? Theme.onBackground : Theme.muted)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .frame(minHeight: 70)
                .padding(.horizontal, 12)
        }
    }
}
