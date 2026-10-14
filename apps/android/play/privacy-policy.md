# Roam Desk — Privacy Policy

Effective date: 14/10/2026
Developer: benmprojects
Contact: open an issue at https://github.com/benmprojects/RoamDesk-public/issues

## Summary

Roam Desk is a voice remote control for **your own Windows PC**. It talks only to the Roam Desk helper you install on that PC, over your own private network. The developer runs no servers for this app and receives none of your data. There are no ads, no analytics and no tracking.

## How the app works

1. You pair the app with your PC by scanning a code shown on the PC.
2. When you talk to the app, your phone turns your speech into text.
3. The app sends that text to the helper on your PC over your private network (Tailscale, which encrypts the connection end to end between your devices), inside an HTTPS connection to your PC. Your PC only accepts your own Tailscale account.
4. On your PC, the helper passes your request to Claude Code using **your own Claude account**, then sends the reply back to the phone, which reads it aloud.

## Information the app handles

| Information | Where it goes | Why |
|---|---|---|
| Your voice | Processed by your phone's speech recogniser, on the device where available. If your phone uses an online speech service, that service handles the audio under its own privacy policy. The app does not record or keep audio | To turn what you say into text |
| What you say (as text) and Claude's replies | Your own PC, over your private network. Shown in the app's Conversation tab and kept in memory while the app runs | To carry out your request |
| Files Claude sends you | Downloaded from your PC into the app's private storage on the phone and deleted after 7 days, unless you save or share them yourself | So you can open, share or save them |
| Pairing details: your PC's name and network addresses, a device ID, and a pairing key | Stored on your phone. The pairing key is encrypted with the phone's Android Keystore | To reconnect securely to your PC |
| Settings (voice, speed, timeouts and similar) | Stored on your phone | To remember your choices |
| Requests you make while offline | Stored on your phone until they can be sent to your PC, or until you discard them | So nothing you say is lost when you lose signal |

The developer does not receive any of this information.

## What happens on your PC

Your PC runs the Roam Desk helper, which is software you install and control. It sends your requests to Claude through your own Claude account, so **Anthropic** processes them under your agreement with Anthropic. If you have connected other services to Claude, such as Microsoft 365, Claude may use them to carry out your requests. The helper keeps an activity log on your PC, which you can view, keep or delete. None of this passes through the developer.

## Permissions

| Permission | Used for |
|---|---|
| Microphone | Hearing your request, only after you press Talk (on screen, on your steering wheel or headset, or in Android Auto) |
| Notifications | Showing that a Drive session is running, with Talk and Stop buttons |
| Foreground service (microphone, media playback) | Keeping the Drive session working while the screen is off, and receiving steering-wheel button presses |
| Biometrics | Unlocking a Drive session with your fingerprint, face or PIN |
| Internet and network state | Connecting to your PC over your private network |
| Camera (through Google's code scanner) | Scanning the pairing code. Scanning is handled by Google Play services' code scanner; the app does not get camera access itself |

## Sharing and selling

We do not sell, share or rent any information. We do not use it for advertising.

## Keeping and deleting your information

Everything the app stores is on your phone. To delete it, unpair the app in Settings or uninstall it. Information on your PC is deleted by removing the helper or its data folder on the PC. Information held by Anthropic or by services you have connected to Claude is covered by their own policies and your accounts with them.

## Children

This app is not directed at children under 13.

## Changes

If this policy changes, the new version will be posted at this address with a new effective date.

## Contact

Questions about this policy: open an issue at https://github.com/benmprojects/RoamDesk-public/issues.
