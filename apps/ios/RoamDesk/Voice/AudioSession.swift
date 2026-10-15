import AVFoundation

/// One shared audio session for speaking and listening, so replies reach the car or headset over Bluetooth.
enum AudioSession {
    static func activate() {
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
            )
            try s.setActive(true)
        } catch {
            // The next speak or listen reports the real failure to the user; nothing useful to do here.
        }
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
