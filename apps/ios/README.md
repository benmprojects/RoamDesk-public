# Roam Desk for iPhone

Native SwiftUI iPhone app. It talks to the desktop helper over the same wire protocol as the Android app ([PROTOCOL.md](../../packages/protocol/PROTOCOL.md)): pair by QR, voice in and out, Drive mode, spoken confirmations, sessions, received files and the offline queue.

Requires iOS 17 or later, Tailscale on the iPhone (same account as the PC), and the helper running on the PC.

## What matches Android, and what differs

| | Android | iPhone |
|---|---|---|
| Pairing, login, replay, reconnect | yes | yes, same logic |
| Voice in and out, "stop everything", spoken approvals | yes | yes (Apple speech recognition and `AVSpeechSynthesizer`, en-AU) |
| Drive unlock | fingerprint / PIN | Face ID / passcode |
| Steering-wheel and headset button | media session | headset and car play/pause via the lock-screen remote commands, kept alive by a silent audio loop while Drive is running |
| Android Auto / CarPlay | media app and templated car app | CarPlay voice screen (code is in; it switches on once Apple grants the entitlement, see below) |
| Self-update from the PC | yes | no. Install through TestFlight or Xcode |

## CarPlay

Roam Desk uses Apple's **voice-based conversational app** CarPlay category (iOS 26.4 or later): a voice control template showing the state (Ready, Listening, Working on it, Speaking, Approval needed) with action buttons for **Talk**, **Stop everything** and, when Claude asks for approval, **Confirm** and **Cancel**. Steering-wheel and headset play/pause still act as Talk. The Drive session itself is started and unlocked on the phone; the car screen says "Unlock on your iPhone" until it is.

The code is in `RoamDesk/CarPlay/CarPlaySceneDelegate.swift` and the scene is registered in `Info.plist`. iOS only connects that scene when the app has the CarPlay entitlement, so until then it does nothing and the phone app is unaffected.

To turn it on:

1. Request the entitlement `com.apple.developer.carplay-voice-based-conversation` at https://developer.apple.com/contact/carplay (the Account Holder does this and agrees to Apple's CarPlay Entitlement Addendum). Apple reviews each request.
2. When Apple grants it, enable the CarPlay capability on the app's App ID (Certificates, Identifiers & Profiles) and let Xcode create a new profile.
3. In `project.yml`, under the `RoamDesk` target's `settings: base:`, add `CODE_SIGN_ENTITLEMENTS: RoamDesk/CarPlay.entitlements`, run `xcodegen generate`, and build. **Don't add that line before Apple grants the entitlement**: a build whose profile lacks it fails to sign.
4. Test in Xcode's CarPlay simulator, then in a real car. The voice category has its own App Store review rules; see the CarPlay Developer Guide.

## Layout

```
project.yml            XcodeGen spec (the .xcodeproj is generated, not committed)
RoamDesk/
  Protocol/            wire types, codec, phrase matching, replay collapsing
  Security/            HMAC login, Keychain, Face ID gate
  Data/                settings, pairing record, offline queue
  Net/                 WebSocket link, helper connection, pairing
  Voice/               speech in/out, earcons, audio session
  Drive/               DriveModel (the state machine), headset buttons
  Files/               files Claude sends to the phone
  UI/                  SwiftUI screens
RoamDeskTests/         unit tests (same cases and HMAC vector as the Android tests)
```

## Build (on a Mac with Xcode 26 or later)

```bash
brew install xcodegen          # or download xcodegen.zip from its GitHub releases
cd apps/ios
xcodegen generate
open RoamDesk.xcodeproj
```

In Xcode: select the **RoamDesk** target › Signing & Capabilities › choose your Team. Plug in the iPhone (Developer Mode on) and Run.

Command line, simulator:

```bash
xcodebuild test -scheme RoamDesk -destination "platform=iOS Simulator,name=iPhone 17" CODE_SIGNING_ALLOWED=NO
```

Set `DEVELOPMENT_TEAM` in `project.yml` (or pass it to `xcodebuild`) for device builds. A free Apple ID works for 7 days at a time; the paid Developer Program removes that limit and allows TestFlight.

## Notes

- The pairing secret is kept in the Keychain (`AfterFirstUnlockThisDeviceOnly`), so Drive can reconnect with the screen locked.
- The app only talks to the PC over the encrypted link (`wss://`/`https://` on the PC's `.ts.net` name, served by `tailscale serve`), so App Transport Security needs no exceptions. A pairing code without that link is refused with a message asking to switch on HTTPS certificates in Tailscale and show a fresh QR code. The plain `ws://` fallback to Tailscale addresses is compiled out (`AppConfig.allowPlainLink = false`), as in the Google Play build of the Android app.
- The helper accepts `platform: "ios"` when pairing (shown as **iPhone** on the dashboard).
