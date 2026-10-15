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
| Android Auto / CarPlay | media app and templated car app | none yet. CarPlay needs an entitlement that Apple grants by request |
| Self-update from the PC | yes | no. Install through TestFlight or Xcode |

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
- The plain `ws://` fallback to Tailscale addresses needs App Transport Security relaxed (`NSAllowsArbitraryLoads` in `Info.plist`). The encrypted `wss://` link is always tried first, and non-Tailscale addresses are refused. For an App Store build, remove the fallback and require the encrypted link, as the Google Play build does.
- The helper accepts `platform: "ios"` when pairing (shown as **iPhone** on the dashboard).
