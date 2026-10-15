import SwiftUI

struct ConversationView: View {
    @Environment(AppContainer.self) private var app
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        let d = app.drive
        VStack(spacing: 0) {
            HStack {
                Text("Conversation").font(.largeTitle.weight(.semibold))
                Spacer()
                Button { d.loadHistory() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Load recent conversation from your PC")
            }
            .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 8)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if d.conversation.isEmpty {
                            Text("Nothing yet. Start a Drive session and talk, or type below.")
                                .foregroundStyle(Theme.muted).padding(.top, 24)
                        }
                        ForEach(d.conversation) { item in
                            ItemRow(item: item).id(item.id)
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 8)
                }
                .onChange(of: d.conversation.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
                .onChange(of: d.conversation.last?.text) { _, _ in
                    if let id = d.conversation.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }

            if !d.driveActive {
                HStack {
                    Text("Typed messages need an unlocked Drive session.").font(.footnote).foregroundStyle(Theme.muted)
                    Spacer()
                }.padding(.horizontal, 20).padding(.top, 6)
            }
            HStack(spacing: 10) {
                TextField("Type to Claude…", text: $draft, axis: .vertical)
                    .focused($focused)
                    .lineLimit(1...4)
                    .padding(12)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .submitLabel(.send)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 34))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
    }

    private func send() {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if !app.drive.driveActive {
            Task {
                guard await UnlockGate.unlock(reason: "Send this to your PC") else { return }
                if !SpeechInput.permissionsGranted { _ = await SpeechInput.requestPermissions() }
                app.drive.startDrive()
                app.drive.submitUtterance(t, source: PhoneMessage.sourceTyped)
                draft = ""
            }
        } else {
            app.drive.submitUtterance(t, source: PhoneMessage.sourceTyped)
            draft = ""
        }
    }
}

private struct ItemRow: View {
    let item: ConversationItem

    var body: some View {
        switch item.kind {
        case .user:
            HStack { Spacer(minLength: 48)
                Text(item.text).padding(12)
                    .background(Theme.accentContainer, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        case .reply:
            Text(markdown(item.text)).textSelection(.enabled).padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        case .progress:
            Label(item.text, systemImage: "ellipsis").font(.footnote).foregroundStyle(Theme.muted)
        case .system:
            Text(item.text).font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .center)
        case .error:
            Label(item.text, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(Theme.danger)
        case .file:
            if let f = item.file { FileCard(offer: f) }
        }
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

struct FileCard: View {
    @Environment(AppContainer.self) private var app
    let offer: FileOffer

    var body: some View {
        let state = app.files.states[offer.fileId] ?? .waiting
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Label(offer.name, systemImage: "doc.fill").font(.headline)
                if !offer.caption.isEmpty { Text(offer.caption).font(.subheadline).foregroundStyle(Theme.muted) }
                switch state {
                case .waiting:
                    Button("Download (\(ByteCountFormatter.string(fromByteCount: offer.size, countStyle: .file)))") { app.files.download(offer.fileId) }
                case let .downloading(bytes, total):
                    ProgressView(value: total > 0 ? Double(bytes) / Double(total) : nil)
                case let .ready(url):
                    ShareLink(item: url) { Label("Open or share", systemImage: "square.and.arrow.up") }
                case let .failed(msg):
                    Text(msg).font(.footnote).foregroundStyle(Theme.danger)
                    Button("Retry") { app.files.download(offer.fileId) }
                }
            }
        }
    }
}
