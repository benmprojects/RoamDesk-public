import SwiftUI

struct RootView: View {
    @Environment(AppContainer.self) private var app
    @State private var tab = RootView.initialTab()

    enum Tab: Hashable { case drive, conversation, sessions, settings }

    private static func initialTab() -> Tab {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "demoTab") {
        case "conversation": return .conversation
        case "sessions": return .sessions
        case "settings": return .settings
        default: break
        }
        #endif
        return .drive
    }

    var body: some View {
        let drive = app.drive
        ZStack {
            Theme.background.ignoresSafeArea()
            if !app.settings.onboarded || app.settings.pairing == nil {
                OnboardingView()
            } else {
                TabView(selection: $tab) {
                    DriveView(openSessions: { tab = .sessions })
                        .tabItem { Label("Drive", systemImage: "car.fill") }.tag(Tab.drive)
                    ConversationView()
                        .tabItem { Label("Conversation", systemImage: "bubble.left.and.bubble.right.fill") }.tag(Tab.conversation)
                    SessionsView()
                        .tabItem { Label("Sessions", systemImage: "folder.fill") }.tag(Tab.sessions)
                    SettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape.fill") }.tag(Tab.settings)
                }
                .overlay(alignment: .top) { NoticeBanner() }

                // Approval card floats over every tab.
                if let confirm = drive.confirm {
                    Color.black.opacity(0.55).ignoresSafeArea()
                    ConfirmCard(
                        pending: confirm,
                        driveActive: drive.driveActive,
                        onConfirm: { drive.onConfirmButton(true) },
                        onCancel: { drive.onConfirmButton(false) }
                    )
                    .padding(16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: drive.confirm)
        .preferredColorScheme(nil)
        // Keep the screen on while it matters (Drive), if the user wants that.
        .onChange(of: drive.driveActive) { _, active in UIApplication.shared.isIdleTimerDisabled = active && app.settings.keepScreenOn }
    }
}

struct NoticeBanner: View {
    @Environment(AppContainer.self) private var app
    @State private var shown: Notice?

    var body: some View {
        Group {
            if let n = shown {
                Text(n.text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.onBackground)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(Theme.surfaceHighest, in: Capsule())
                    .shadow(radius: 8)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut, value: shown)
        .onChange(of: app.drive.notice) { _, n in
            guard let n else { return }
            shown = n
            Task {
                try? await Task.sleep(nanoseconds: 3_500_000_000)
                if shown == n { shown = nil }
            }
        }
    }
}
