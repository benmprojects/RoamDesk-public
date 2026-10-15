import Foundation

/// Build-time switches.
enum AppConfig {
    /// Whether the app may fall back to the plain ws:// / http:// link on a Tailscale address when the PC has no
    /// encrypted (https) address. Off: the app only talks to the PC over the encrypted link (`tailscale serve`), so
    /// App Transport Security needs no exceptions. The Google Play build of the Android app does the same.
    static let allowPlainLink = false
}
