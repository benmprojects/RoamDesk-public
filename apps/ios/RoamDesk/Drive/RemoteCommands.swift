import AVFoundation
import MediaPlayer

/// Headset, earbud and car play/pause buttons become Talk, like the steering-wheel button on Android.
///
/// iOS only sends those buttons to the app that is playing audio, so while a Drive session is active a silent
/// loop keeps this app the "now playing" one. It also keeps the app running with the screen locked.
@MainActor
final class RemoteCommands {
    private var player: AVAudioPlayer?
    private var tokens: [(MPRemoteCommand, Any)] = []
    var onTalk: (() -> Void)?

    func start(title: String) {
        AudioSession.activate()
        if player == nil, let data = Earcons.wav([(0, 1.0)], gap: 0) {
            player = try? AVAudioPlayer(data: data)
            player?.numberOfLoops = -1
            player?.volume = 0
        }
        player?.play()

        let c = MPRemoteCommandCenter.shared()
        let all: [MPRemoteCommand] = [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.nextTrackCommand, c.previousTrackCommand]
        for cmd in all {
            cmd.isEnabled = true
            let t = cmd.addTarget { [weak self] _ in
                self?.onTalk?()
                return .success
            }
            tokens.append((cmd, t))
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: "Drive session",
            MPMediaItemPropertyArtist: title,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
    }

    func stop() {
        player?.stop()
        for (cmd, t) in tokens { cmd.removeTarget(t) }
        tokens.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
