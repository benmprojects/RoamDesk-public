# Roam Desk — Android app

Kotlin and Jetpack Compose (Material 3). Package `au.com.roamdesk`, Android 10 (API 29) and later.

## Build and first install

Build with Android Studio's bundled JDK:
```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat testSideloadDebugUnitTest assembleSideloadDebug
```
There are two build flavours:

| Flavour | For | Differences |
|---|---|---|
| `sideload` | Your own phone | Installed with `adb`; updates itself from the PC; Android Auto media front end |
| `play` | Google Play | No self-updater or installer permission; the full templated Android Auto app only. See [PLAY.md](PLAY.md) |

The sideload APK is `app\build\outputs\apk\sideload\debug\app-sideload-debug.apk`. Install it once with `adb install -r` over USB or wireless debugging. After that the app updates itself: every build gets a higher version, and the helper offers the newest build on the PC to the phone. The Play bundle is built with `.\gradlew.bat bundlePlayRelease`.

## What's in it

- **Drive mode:** a foreground service keeps the microphone and connection alive with the screen off. Starting it needs your fingerprint or PIN on the phone, or a press of play in Android Auto.
- **Talking:** push-to-talk from the on-screen button, steering-wheel or headset play/pause, or the notification. On-device speech recognition (en-AU), spoken replies with a choice of voice (**Settings › Voice**), and spoken "confirm …" approvals with on-screen buttons as a backup.
- **Conversation:** what you said, Claude's replies, progress, and files Claude sent, each with **Open**, **Share** and **Save**. Files up to 25 MB download automatically.
- **Sessions:** switch, create, reset, continue a session from the PC, or hand one back to the PC.
- **Settings:** connection, keep screen on, voice and speed, idle timeout, Skip confirmations, **Update PC helper**, and **Check for updates** for the app itself.
- **Android Auto:** the sideloaded app appears as a media app (enable **Unknown sources** in Android Auto's developer settings). Play/pause talks, the now-playing screen shows status and the latest reply, and buttons cover Cancel, Stop everything, Approve and Deny. The Google Play build is the full car app, with its own screens and the car's microphone.

## Permissions

Microphone, notifications, foreground service (microphone and media playback), biometrics, battery-optimisation exemption (so the phone doesn't freeze Drive mode), and install packages (for self-update; Android asks you to allow it the first time and to tap Install for each update).

## Layout

| Package | What |
|---|---|
| `protocol` | Wire messages and codec, phrase matching, replay handling |
| `data`, `data/net` | Settings, pairing storage, offline queue, the WebSocket connection |
| `drive` | The Drive state machine: voice, confirmations, conversation |
| `voice` | Speech in and out, earcons |
| `files` | Received-file downloads |
| `update` | App self-update |
| `car` | Android Auto (media front end, and the templated app for a Play release) |
| `service` | Drive foreground service and media-button session |
| `ui` | Compose screens and components |
