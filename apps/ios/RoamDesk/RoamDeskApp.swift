import SwiftUI

@main
struct RoamDeskApp: App {
    @State private var container = AppContainer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(container)
                .tint(Theme.accent)
                .onChange(of: scenePhase) { _, phase in
                    // The link runs while the app is on screen, and while a Drive session holds it in the background.
                    if phase == .active { container.connection.acquire("ui") } else { container.connection.release("ui") }
                }
                .onAppear { container.connection.acquire("ui") }
        }
    }
}
