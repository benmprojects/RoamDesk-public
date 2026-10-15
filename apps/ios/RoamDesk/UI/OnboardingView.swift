import AVFoundation
import SwiftUI

struct OnboardingView: View {
    @Environment(AppContainer.self) private var app
    @State private var step: Step
    @State private var scanning = false
    @State private var pasted = ""
    @State private var showPaste = false
    @State private var busy = false
    @State private var error: String?
    @State private var pairedName: String?

    enum Step { case welcome, pair, permissions }

    init() {
        _step = State(initialValue: .welcome)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch step {
            case .welcome: welcome
            case .pair: pair
            case .permissions: permissions
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            if app.settings.pairing != nil { step = app.settings.onboarded ? .pair : .permissions }
            else if app.settings.onboarded { step = .pair }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Text("Roam Desk").font(.system(size: 44, weight: .semibold))
            Text("Talk to Claude hands-free and have it work on your Windows PC: files, PowerShell, the web and your connected services.")
                .font(.title3).foregroundStyle(Theme.muted)
            Text("You'll need Tailscale on this iPhone, signed in to the same account as your PC, and the Roam Desk helper running there.")
                .font(.callout).foregroundStyle(Theme.muted)
            Spacer()
            Button("Pair with my PC") { step = .pair }.buttonStyle(BigButtonStyle(height: 72))
        }
    }

    private var pair: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Pair with your PC").font(.largeTitle.weight(.semibold))
            Text("On your PC, open the helper dashboard and click **Pair a device**. Then scan the code.")
                .foregroundStyle(Theme.muted)
            if let name = pairedName {
                Card {
                    Label("Paired with \(name)", systemImage: "checkmark.circle.fill").font(.title3.weight(.semibold)).foregroundStyle(Theme.color(.speaking))
                }
                Spacer()
                Button("Continue") { step = .permissions }.buttonStyle(BigButtonStyle(height: 68))
            } else {
                if scanning {
                    QRScannerView { code in
                        scanning = false
                        Task { await submit(code) }
                    }
                    .frame(height: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    Button("Cancel scan") { scanning = false }
                } else {
                    Button { startScan() } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                        .buttonStyle(BigButtonStyle(height: 72))
                    Button("Paste pairing text instead") { showPaste.toggle() }
                }
                if showPaste {
                    TextEditor(text: $pasted)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(height: 110)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
                    Button("Pair") { Task { await submit(pasted) } }
                        .buttonStyle(BigButtonStyle(height: 56))
                        .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if busy { HStack { ProgressView(); Text("Contacting your PC…") } }
                if let error { Text(error).foregroundStyle(Theme.danger) }
                Spacer()
            }
        }
    }

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Permissions").font(.largeTitle.weight(.semibold))
            Text("Roam Desk needs the microphone and speech recognition to hear you. Everything else is optional.")
                .foregroundStyle(Theme.muted)
            Card {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Microphone and speech", systemImage: "mic.fill").font(.headline)
                    Text("Used only while a Drive session is running and you're talking.").font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            Button("Allow") {
                Task {
                    _ = await SpeechInput.requestPermissions()
                    app.settings.onboarded = true
                }
            }.buttonStyle(BigButtonStyle(height: 68))
            Button("Not now") { app.settings.onboarded = true }
            Spacer()
        }
    }

    private func startScan() {
        error = nil
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: scanning = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                Task { @MainActor in
                    if ok { scanning = true } else { error = "Allow the camera in Settings to scan, or paste the pairing text instead." }
                }
            }
        default: error = "Allow the camera in Settings to scan, or paste the pairing text instead."
        }
    }

    private func submit(_ text: String) async {
        busy = true; error = nil
        defer { busy = false }
        switch await app.pair(text) {
        case let .success(name): pairedName = name
        case let .failure(msg): error = msg
        }
    }
}

/// Camera view that reports the first QR code it sees.
struct QRScannerView: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        let session = AVCaptureSession()
        if let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) {
            session.addInput(input)
            let out = AVCaptureMetadataOutput()
            if session.canAddOutput(out) {
                session.addOutput(out)
                out.setMetadataObjectsDelegate(context.coordinator, queue: .main)
                out.metadataObjectTypes = [.qr]
            }
        }
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.session?.stopRunning()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onCode: (String) -> Void
        var session: AVCaptureSession?
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let s = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            done = true
            onCode(s)
        }
    }
}
