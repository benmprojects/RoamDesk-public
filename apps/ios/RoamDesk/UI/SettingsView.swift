import SwiftUI

struct SettingsView: View {
    @Environment(AppContainer.self) private var app
    @State private var confirmUnpair = false

    var body: some View {
        @Bindable var settings = app.settings
        let d = app.drive
        NavigationStack {
            Form {
                Section("Your PC") {
                    LabeledContent("Connection") { Text(d.linkDetail).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing) }
                    if !d.helperName.isEmpty { LabeledContent("PC", value: d.helperName) }
                    Button("Reconnect") { app.connection.reconnectNow() }
                    Button("Unpair", role: .destructive) { confirmUnpair = true }
                }

                Section("Voice") {
                    VStack(alignment: .leading) {
                        Text("Speaking speed  \(settings.speechRate, specifier: "%.1f")×")
                        Slider(value: $settings.speechRate, in: 0.6...1.6, step: 0.1)
                            .onChange(of: settings.speechRate) { _, _ in d.applyPrefs() }
                    }
                    NavigationLink {
                        VoicePicker()
                    } label: {
                        LabeledContent("Voice", value: currentVoiceName)
                    }
                    Button("Test voice") { d.testVoice() }
                }

                Section("Claude") {
                    Toggle("Plain updates", isOn: Binding(get: { d.plainUpdates }, set: { d.setPlainUpdates($0) }))
                    Toggle("Skip confirmations", isOn: Binding(get: { d.skipConfirmations }, set: { d.setSkipConfirmations($0) }))
                    Text("Skip confirmations runs actions without asking. It can only be turned on during an unlocked Drive session.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }

                Section("Drive") {
                    Toggle("Keep screen on", isOn: $settings.keepScreenOn)
                    Picker("End after idle", selection: $settings.idleTimeoutMin) {
                        ForEach(SettingsStore.idleTimeoutChoices, id: \.self) { Text("\($0) min").tag($0) }
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                }
            }
            .navigationTitle("Settings")
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .alert("Unpair this phone?", isPresented: $confirmUnpair) {
                Button("Unpair", role: .destructive) { app.unpair() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Deletes this phone's key for \(d.helperName.isEmpty ? "your PC" : d.helperName). You'll need a new QR code from the PC to pair again. Held requests are discarded.")
            }
        }
    }

    private var currentVoiceName: String {
        guard let id = app.settings.voiceId, let v = app.speechOut.voices.first(where: { $0.id == id }) else { return "Automatic" }
        return v.name
    }
}

struct VoicePicker: View {
    @Environment(AppContainer.self) private var app

    var body: some View {
        List {
            row(id: nil, title: "Automatic", subtitle: "Best Australian English voice installed")
            ForEach(app.speechOut.voices) { v in
                row(id: v.id, title: v.name, subtitle: "\(v.language) · \(v.quality)")
            }
            Text("Install better voices in iOS Settings › Accessibility › Spoken Content › Voices.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
        .navigationTitle("Choose a voice")
        .onAppear { app.speechOut.prepare() }
    }

    private func row(id: String?, title: String, subtitle: String) -> some View {
        Button {
            app.settings.voiceId = id
            app.drive.previewVoice(id)
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(title).foregroundStyle(Theme.onBackground)
                    Text(subtitle).font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer()
                if app.settings.voiceId == id { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }
        }
    }
}
