import SwiftUI

struct SessionsView: View {
    @Environment(AppContainer.self) private var app
    @State private var showNew = false
    @State private var newName = ""
    @State private var showCatalog = false
    @State private var resetTarget: Session?
    @State private var releaseTarget: Session?

    var body: some View {
        let d = app.drive
        NavigationStack {
            List {
                Section {
                    Button { showCatalog = true; d.loadCatalog() } label: {
                        Label("Continue a session from your PC", systemImage: "desktopcomputer")
                    }
                }
                Section("Sessions") {
                    if d.sessions.isEmpty { Text("No sessions yet.").foregroundStyle(Theme.muted) }
                    ForEach(d.sessions) { s in
                        Button { d.selectSession(s.id) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.name).font(.headline).foregroundStyle(Theme.onBackground)
                                    Text(s.cwd).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                                }
                                Spacer()
                                if s.busy { ProgressView() }
                                if s.id == d.activeSessionId { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent) }
                            }
                        }
                        .swipeActions {
                            Button("Reset") { resetTarget = s }.tint(.orange)
                            if s.claudeSessionId != nil { Button("Hand back") { releaseTarget = s }.tint(.blue) }
                        }
                    }
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button { showNew = true } label: { Image(systemName: "plus") } }
            }
            .alert("New session", isPresented: $showNew) {
                TextField("Name, e.g. home", text: $newName)
                Button("Create") { d.newSession(newName); newName = "" }
                Button("Cancel", role: .cancel) { newName = "" }
            }
            .alert("Reset “\(resetTarget?.name ?? "")”?", isPresented: Binding(get: { resetTarget != nil }, set: { if !$0 { resetTarget = nil } })) {
                Button("Reset", role: .destructive) { if let s = resetTarget { d.resetSession(s.id) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Starts a fresh conversation in this session. Claude forgets what was said before.") }
            .alert("Hand “\(releaseTarget?.name ?? "")” back to your PC?", isPresented: Binding(get: { releaseTarget != nil }, set: { if !$0 { releaseTarget = nil } })) {
                Button("Hand back") { if let s = releaseTarget { d.releaseSession(s.id) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("The phone lets go of this conversation and it shows as a desktop session again. You can continue it from the phone again later.") }
            .sheet(isPresented: $showCatalog) { ContinueSessionSheet() }
        }
    }
}

struct ContinueSessionSheet: View {
    @Environment(AppContainer.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var warn: CatalogItem?

    var body: some View {
        let d = app.drive
        NavigationStack {
            List {
                if d.catalogLoading { HStack { ProgressView(); Text("Asking your PC…") } }
                if let items = d.catalog, items.isEmpty, !d.catalogLoading {
                    Text("No recent sessions found on your PC.").foregroundStyle(Theme.muted)
                }
                ForEach(d.catalog ?? []) { item in
                    Button {
                        if item.activeRecently { warn = item } else { attach(item) }
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.title.isEmpty ? "(untitled)" : item.title).font(.headline).foregroundStyle(Theme.onBackground).lineLimit(2)
                            Text("\(item.project) · \(originLabel(item.origin)) · \(relative(item.lastActiveAt))")
                                .font(.caption).foregroundStyle(Theme.muted)
                            if item.activeRecently { Text("In use in the last 3 minutes").font(.caption.weight(.semibold)).foregroundStyle(Theme.color(.confirming)) }
                        }
                    }
                }
            }
            .navigationTitle("Continue from your PC")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .alert("This session is in use", isPresented: Binding(get: { warn != nil }, set: { if !$0 { warn = nil } })) {
                Button("Continue anyway") { if let w = warn { attach(w) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("It was used in the last 3 minutes. Don't use it on the PC and the phone at the same time.") }
        }
    }

    private func attach(_ item: CatalogItem) {
        app.drive.attachSession(item.claudeSessionId)
        dismiss()
    }

    private func originLabel(_ o: String) -> String {
        switch o { case "desktop": return "Desktop app"; case "terminal": return "Terminal"; case "phone": return "Phone"; default: return "Other" }
    }

    private func relative(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        return RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
    }
}
