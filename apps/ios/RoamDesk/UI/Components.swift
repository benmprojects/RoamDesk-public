import SwiftUI

/// The big glanceable ring: one colour and one word per phase.
struct StateRing: View {
    let phase: DrivePhase
    @State private var pulse = false
    @State private var spin = false

    var body: some View {
        let colour = Theme.color(phase)
        ZStack {
            Circle()
                .stroke(colour.opacity(0.18), lineWidth: 14)
            if phase == .thinking {
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(colour, style: StrokeStyle(lineWidth: 14, lineCap: .round))
                    .rotationEffect(.degrees(spin ? 360 : 0))
                    .animation(.linear(duration: 1.1).repeatForever(autoreverses: false), value: spin)
            } else {
                Circle()
                    .stroke(colour, lineWidth: 14)
                    .opacity(phase == .offline ? 0.35 : 1)
            }
            if phase == .listening || phase == .speaking {
                Circle()
                    .stroke(colour.opacity(0.35), lineWidth: 6)
                    .scaleEffect(pulse ? 1.16 : 1.0)
                    .opacity(pulse ? 0 : 0.8)
                    .animation(.easeOut(duration: 1.1).repeatForever(autoreverses: false), value: pulse)
            }
            Text(phase.rawValue)
                .font(.system(size: 36, weight: .semibold))
                .foregroundStyle(Theme.onBackground)
        }
        .frame(width: 230, height: 230)
        .onAppear { pulse = true; spin = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Status: \(phase.rawValue)")
    }
}

struct ConnectionPill: View {
    let link: LinkStatus
    let helperName: String

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(colour).frame(width: 9, height: 9)
            Text(label).font(.subheadline.weight(.medium)).foregroundStyle(Theme.onBackground).lineLimit(1)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface, in: Capsule())
    }

    private var colour: Color {
        switch link {
        case .online: return Theme.color(.speaking)
        case .connecting: return Theme.color(.confirming)
        case .rejected: return Theme.danger
        default: return Theme.color(.offline)
        }
    }

    private var label: String {
        switch link {
        case .online: return helperName.isEmpty ? "Online" : helperName
        case .connecting: return "Connecting"
        case .rejected: return "Rejected"
        case .notPaired: return "Not paired"
        case .offline: return "Offline"
        }
    }
}

struct SessionChip: View {
    let name: String?
    let busy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                Text(name ?? "No session").lineLimit(1)
                if busy { ProgressView().controlSize(.mini) }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.onBackground)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.surface, in: Capsule())
        }
    }
}

/// Needs a deliberate press and hold so it can't be hit by accident on a bumpy road.
struct StopEverythingButton: View {
    let onKill: () -> Void
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            Label("Stop everything", systemImage: "stop.circle.fill")
                .font(.headline)
                .foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity, minHeight: 52)
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.danger.opacity(0.6), lineWidth: 1.5))
        }
        .confirmationDialog("Stop everything on your PC?", isPresented: $showing, titleVisibility: .visible) {
            Button("Stop everything", role: .destructive, action: onKill)
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("Cancels every running task and any waiting approvals.")
        }
    }
}

struct ConfirmCard: View {
    let pending: PendingConfirm
    let driveActive: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(pending.request.tier == 2 ? "Approval needed" : "Quick check", systemImage: "exclamationmark.shield.fill")
                .font(.headline).foregroundStyle(Theme.color(.confirming))
            Text(pending.request.summary).font(.title3.weight(.semibold)).foregroundStyle(Theme.onBackground)
            if !pending.request.command.isEmpty {
                Text(pending.request.command)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.muted).lineLimit(4)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surfaceHigh, in: RoundedRectangle(cornerRadius: 12))
            }
            Text(driveActive ? "Say “\(pending.request.phrase)” to go ahead, or “cancel”." : "Start a Drive session to approve this.")
                .font(.subheadline).foregroundStyle(Theme.muted)
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let left = max(0, Int(pending.deadline.timeIntervalSince(ctx.date)))
                Text("Expires in \(left) s").font(.footnote).foregroundStyle(Theme.muted)
            }
            HStack(spacing: 12) {
                Button("Cancel", action: onCancel)
                    .buttonStyle(BigButtonStyle(fill: Theme.surfaceHighest, textColor: Theme.onBackground, height: 60))
                Button("Confirm", action: onConfirm)
                    .buttonStyle(BigButtonStyle(height: 60))
                    .disabled(!driveActive).opacity(driveActive ? 1 : 0.4)
            }
        }
        .padding(20)
        .background(Theme.background, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(Theme.line, lineWidth: 1))
        .shadow(radius: 24)
    }
}
