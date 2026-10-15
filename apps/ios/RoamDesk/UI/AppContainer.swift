import Observation
import SwiftUI
import UIKit

/// Builds and owns the app's long-lived objects.
@MainActor
@Observable
final class AppContainer {
    /// One instance for the whole process: the phone UI and the CarPlay scene must share the same Drive session.
    static let shared = AppContainer()

    let settings: SettingsStore
    let queue: OfflineQueue
    let connection: HelperConnection
    let speechIn: SpeechInput
    let speechOut: SpeechOutput
    let earcons: Earcons
    let files: FileInbox
    let drive: DriveModel
    let pairing: PairingRepository

    init() {
        let settings = SettingsStore()
        let queue = OfflineQueue(fileURL: OfflineQueue.defaultURL())
        let connection = HelperConnection(settings: settings)
        let speechIn = SpeechInput()
        let speechOut = SpeechOutput()
        let earcons = Earcons()
        let files = FileInbox(connection: connection)
        self.settings = settings
        self.queue = queue
        self.connection = connection
        self.speechIn = speechIn
        self.speechOut = speechOut
        self.earcons = earcons
        self.files = files
        self.pairing = PairingRepository(settings: settings, queue: queue)
        self.drive = DriveModel(connection: connection, settings: settings, queue: queue,
                                speechIn: speechIn, speechOut: speechOut, earcons: earcons, files: files)
        connection.onStateChange = { [weak self] in self?.drive.connectionStateChanged() }
        speechOut.prepare()
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "demo") { drive.loadDemo() }
        #endif
    }

    /// Pair from a scanned or pasted code. On success the link starts as soon as the app is on screen.
    func pair(_ text: String) async -> PairResult {
        let r = await pairing.pair(qrJson: text)
        if case .success = r { connection.pairingChanged() }
        return r
    }

    func unpair() {
        pairing.unpair()
        drive.pairingCleared()
        connection.pairingChanged()
    }
}
