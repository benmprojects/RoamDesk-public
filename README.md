# Roam Desk

Talk to Claude hands-free from your Android phone, for example while driving, and have it carry out tasks on your Windows PC: files, PowerShell, the web, and your connected services such as Microsoft 365 email, calendar and Teams.

| Part | Folder | What it is |
|---|---|---|
| Desktop helper | [`apps/desktop-helper`](apps/desktop-helper/README.md) | Runs on the PC. Drives the `claude` CLI on your Claude subscription, applies the safety policy, keeps the audit log, sends files and app updates to the phone, and serves the dashboard |
| Android app | [`apps/android`](apps/android/README.md) | Voice in and out, Drive mode, steering-wheel and headset push-to-talk, Android Auto, spoken confirmations, received files, self-update |
| iPhone app | [`apps/ios`](apps/ios/README.md) | Native SwiftUI port of the Android app: pairing, voice, Drive mode, spoken approvals, sessions and files. Built with Xcode (see its README) |
| Web client | [`apps/web-client`](apps/web-client/README.md) | Use Claude Code on the PC from any browser on your tailnet, like the desktop app: formatted replies, tool calls and diffs, approvals, questions, plans, permission modes, model and effort, parallel sessions. Served by the helper; nothing to install |
| Desktop control | [`apps/desktop-control`](apps/desktop-control/README.md) | A Claude Code plugin to use the PC's screen, mouse and keyboard quickly and reliably |
| Protocol | [`packages/protocol`](packages/protocol/PROTOCOL.md) | The message format the phone and helper use to talk to each other |
| Spike | [`spike`](spike) | Phase 0 experiments (scripts only) |

## First-time setup

1. **PC.** You need Node 24+, the `claude` CLI signed in to your Claude subscription, and Tailscale. Install the helper:
   ```powershell
   powershell -ExecutionPolicy Bypass -File apps\desktop-helper\scripts\install.ps1
   ```
   It builds the helper, registers it to start hidden when you sign in, and opens the dashboard at http://127.0.0.1:8787/.
2. **Phone.** Install Tailscale and sign in to the same tailnet as the PC. Then install Roam Desk (package `au.com.roamdesk`) from Google Play. It's on the internal testing track for now: open the testing link from the maintainer on the phone, signed in to a Google account that's on the tester list, tap **Accept**, then install from Play. Play keeps the app up to date.

   Developers can still build and install the sideload version over USB or wireless debugging instead:
   ```powershell
   adb install -r apps\android\app\build\outputs\apk\sideload\debug\app-sideload-debug.apk
   ```
   That build updates itself from the PC (see below).
3. **Pair.** On the dashboard, click **Pair a device**. In the app, tap **Pair with PC** and scan the code. For a browser, open the web client's address (shown on the dashboard) and paste the pairing text.
4. **Drive.** Start a Drive session (fingerprint or PIN), then press your steering-wheel or headset play button, or the Talk button, and speak.

## Day to day

- **Settings** live on the dashboard's **Settings** card: the phone instructions (how Claude speaks and what it may do), the model and effort, approval timings, and **Skip confirmations**. Changes apply from the next request.
- **Updating the PC helper:** click **Update helper** on the dashboard, or tap **Update PC helper** in the app's Settings. It rebuilds from the latest code on the PC and restarts in about a minute; the phone says when it's back.
- **Updating the app:** from Google Play, update it in the Play Store. For the sideload build, when the PC has a newer build, the app shows an **Update available** banner. Tap **Update**, then **Install**. **Settings › App › Check for updates** checks on demand.
- **Files:** ask Claude to send you a file and it appears as a card in the app's **Conversation** view with **Open**, **Share** and **Save** (to Downloads › Roam Desk).
- **Sessions:** switch, create or reset sessions in the app. **Continue a session from your PC** picks up a desktop or terminal Claude Code conversation; the PC icon on a session hands it back to the desktop app.
- **Stop:** say "stop everything", press **Stop** in the app or on Android Auto, or click **Stop everything** on the dashboard.

## Microsoft 365

Phone sessions use your claude.ai connectors. For Microsoft 365 to send email and Teams messages and look people up:

- The organisation's Claude admin must allow the connector's send tools (claude.ai › Admin settings › Connectors › Microsoft 365).
- A Microsoft admin must grant the connector app admin consent in the Entra admin center (Enterprise applications › the app with ID `07c030f6-5743-41b7-ba00-0a6e85f37c17` › Permissions › Grant admin consent). Without it, people search fails with "Missing scope People.Read".

The dashboard's **Tools & connectors** card shows which connectors are connected and which need signing in.

## Android Auto

A sideloaded app only appears in Android Auto as a **media app** (Android Auto's "Unknown sources" developer option doesn't cover the other app types). Roam Desk shows the status and Claude's latest reply on the now-playing screen; play/pause or the steering-wheel button talks; and custom buttons cover Cancel, Stop everything and Approve or Deny. The full templated car app only appears when installed from Google Play; the `play` build and the steps to publish it are in [apps/android/PLAY.md](apps/android/PLAY.md).

## Safety

The helper checks every tool call before it runs and logs it. By default risky actions (deleting, installing, sending, pushing, writing outside the session folder) wait for you to say a confirmation phrase, and a short list of actions is always blocked. **Skip confirmations** turns both off, except that credentials, keys and the helper's own files always stay off limits; the audit log and the stop controls still work. Only the PC dashboard can turn it on; the phone can only turn it off. **Admin: allow everything** (dashboard Settings, for the PC's owner) goes further: every step runs with no questions and no blocks, including credentials, keys and the helper's own files, for 1 hour, 8 hours or until switched off. It's still all in the audit log, a red banner shows on the dashboard and in the web client while it's on, and phones and browsers can only turn it off. In the car, Drive starts with the phone locked only within 12 hours of it last being unlocked. Details are in the [helper README](apps/desktop-helper/README.md).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). You can use and change Roam Desk for personal and other non-commercial purposes; you can't sell it or use it commercially. See [NOTICE](NOTICE). Source-available, not open source.
