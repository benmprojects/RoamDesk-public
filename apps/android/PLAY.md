# Putting Roam Desk on Google Play (for Android Auto)

A sideloaded app can only appear in Android Auto as a media app. The full car app (status, your last request and Claude's reply, Talk, Sessions, Cancel, Stop all, Approve/Deny, and the car's own microphone) only appears when the app is installed from Google Play. This file is the checklist.

## What's already built

| | |
|---|---|
| Flavours | `sideload` (adb install, updates itself from the PC) and `play` (for Google Play) |
| Play build | No self-updater, no installer permission, no battery-exemption permission, and only the templated car app (no media-player entry) |
| Bundle | `apps\android\app\build\outputs\bundle\playRelease\app-play-release.aab` |
| Build command | `.\gradlew.bat bundlePlayRelease` (from `apps\android`, with `JAVA_HOME` set to Android Studio's `jbr`) |
| Signing | An **upload key** at `%USERPROFILE%\ClaudeAnywhereKeys\` (`upload-keystore.jks`, `keystore.properties`). Not in the repository. **Back this folder up.** If it's lost, Google can reset the upload key, but it takes a support request |
| Upload key SHA-256 | `51:27:E0:D6:4E:29:08:25:AB:BE:1A:9C:EB:00:C2:DB:2A:54:6A:CB:28:87:80:D9:14:3C:10:83:D0:11:B5:35` |
| Package name | `au.com.roamdesk`. **Permanent once the first bundle is uploaded** |
| Car app category | IoT (`androidx.car.app.category.IOT`) |
| Release host check | Release builds only accept Google's Android Auto and Automotive hosts; debug builds accept any host, so the Desktop Head Unit works |

Each build gets a higher version number automatically, which Play requires for every upload.

## What you need to do in Play Console

1. **Developer account.** Register at play.google.com/console (a one-off registration fee applies) and complete identity verification. Check in Play Console which account type applies to your organisation; an organisation account is verified differently from a personal one, and personal accounts have extra testing requirements before production.
2. **Create the app.** Name: Roam Desk. Free. Default language: English (Australia).
3. **Play App Signing.** Accept it. When you upload the first bundle, Google keeps the app signing key and your upload key above signs future uploads.
4. **Form factors.** App settings › Advanced settings › Form factors › **Add Android Auto**.
5. **Internal testing.** Testing › Internal testing › create a release › upload the `.aab` › add testers by email. Testers opt in through the link Play gives you and install from Play. Google's documentation says internal testing needs no Android Auto review and closed testing is non-blocking, so this is the practical route for a company-only app.
6. **App content declarations** (all required before a release can roll out):
   - Privacy policy URL: **[you supply a hosted URL; I can draft the policy]**
   - Data safety form. The honest answers: no data goes to the developer; the pairing key and settings stay on the phone; speech goes to the phone's speech recogniser; messages go only to the user's own PC over Tailscale.
   - Foreground service declarations for **microphone** and **media playback**, with a short video showing Drive mode.
   - Permissions: `RECORD_AUDIO`, notifications, biometrics (all standard).
   - App access: reviewers can't pair with your PC. For internal testing this isn't needed; for production you would have to explain it or provide a demo setup.
   - Content rating questionnaire, target audience, ads declaration (no ads).
7. **Store listing.** App icon 512×512, feature graphic 1024×500, phone screenshots, short and full descriptions. **[Contact email and website: you supply]**

## Test before you upload (Google's Desktop Head Unit)

1. Android Studio › SDK Manager › SDK Tools › **Android Auto Desktop Head Unit Emulator**.
2. On the phone: Android Auto settings › tap Version ten times › menu › **Start head unit server**.
3. `adb forward tcp:5277 tcp:5277`, then run `desktop-head-unit.exe`.
4. Install the debug build and open Roam Desk in the emulated car screen.

I haven't been able to run this: the phone's debugging connection kept dropping, and I can't test in your car.

## Review risks (production only, not internal testing)

Google's IoT guidelines let an app **show device state**, offer **simple one-touch on/off controls**, and send **notifications**. They don't allow **selecting devices or systems** or setting up routines while driving. Talk, Cancel, Stop all and Approve/Deny fit. The **Sessions** and **Continue a PC session** screens are selection screens and could be rejected. A voice assistant that runs commands on a PC is also not what the IoT category is for, so Google may refuse the category. Nothing here is approved by Google. If a production release matters later, the first thing to try is removing those two screens from the Play build.

## Updating after Play

Play delivers updates. The PC helper's **Update helper** button still works. The sideloaded app and the Play app have the same package name and different signatures, so a phone has one or the other, not both; installing from Play over a sideloaded copy needs the sideloaded one uninstalled first, which clears its pairing.
