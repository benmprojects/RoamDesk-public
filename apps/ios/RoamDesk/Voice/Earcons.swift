import AVFoundation

/// Short generated tones (no audio assets), played on the shared audio session so they reach the car over Bluetooth.
@MainActor
final class Earcons {
    private var player: AVAudioPlayer?

    /// Mic opening.
    func listenStart() { play([(880, 0.09)]) }

    /// Mic closed.
    func listenStop() { play([(660, 0.06), (880, 0.06)]) }

    /// Soft "working on it" when nothing has been spoken 1.5 s after an utterance.
    func working() { play([(520, 0.07), (520, 0.07)], gap: 0.06) }

    /// Connection lost, or couldn't do that.
    func problem() { play([(330, 0.12), (247, 0.18)]) }

    private func play(_ notes: [(freq: Double, seconds: Double)], gap: Double = 0.02) {
        guard let data = Self.wav(notes, gap: gap), let p = try? AVAudioPlayer(data: data) else { return }
        p.volume = 0.5
        p.prepareToPlay()
        p.play()
        player = p
    }

    /// 16-bit mono PCM WAV of sine notes with a short fade in and out so there are no clicks.
    static func wav(_ notes: [(freq: Double, seconds: Double)], gap: Double) -> Data? {
        let rate = 22_050.0
        var samples = [Int16]()
        for (i, n) in notes.enumerated() {
            let count = Int(n.seconds * rate)
            let fade = max(1, Int(0.008 * rate))
            for k in 0..<count {
                let env = min(1.0, Double(k) / Double(fade), Double(count - k) / Double(fade))
                let v = sin(2 * .pi * n.freq * Double(k) / rate) * env * 0.6
                samples.append(Int16(v * Double(Int16.max)))
            }
            if i < notes.count - 1 { samples.append(contentsOf: [Int16](repeating: 0, count: Int(gap * rate))) }
        }
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        let dataBytes = UInt32(samples.count * 2)
        d.append("RIFF".data(using: .ascii)!); u32(36 + dataBytes); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(dataBytes)
        samples.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }
}
