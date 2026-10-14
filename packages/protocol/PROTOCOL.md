# Roam Desk — Wire Protocol v1 (MVP)

This is the contract between the Android app (`apps/android`) and the desktop helper (`apps/desktop-helper`). The TypeScript types are in `src/index.ts`. The Kotlin side mirrors them with kotlinx.serialization.

## Transport

- **MVP is Tailscale only.** The helper listens on port `8787`, on its Tailscale IP and on `127.0.0.1`.
  - Pairing: HTTP `POST /pair`
  - Messages: WebSocket `ws://<host>:8787/ws`
- Plain `ws://`/`http://` is acceptable for the MVP because the traffic is inside Tailscale's WireGuard tunnel. Authentication happens at the app layer (below). End-to-end encryption arrives with the relay in Phase 3.
- Each WebSocket text frame carries one JSON object, encoded as UTF-8.

## Envelope

Every frame, in either direction, uses this envelope:

```json
{ "v": 1, "type": "utterance", "id": "uuid-v4", "ts": 1760000000000, "seq": 42, "payload": { } }
```

- `seq` is set **only on frames from the PC to the phone**. It increases by one per paired device and is used for replay. Frames from the phone don't carry it.
- `ts` is milliseconds since the Unix epoch.
- Unknown `type`s must be ignored, not treated as errors.

## Pairing (one-time)

1. The helper's dashboard (`http://127.0.0.1:8787/`) shows a QR code. It encodes this JSON:
   ```json
   {"v":1,"kind":"claude-anywhere-pair","name":"my-pc","hosts":["100.64.0.5","my-pc.tail1234.ts.net"],"port":8787,"code":"<base64url 16 bytes>","exp":1760000300,"secureHost":"my-pc.tail1234.ts.net","securePort":8443}
   ```
   - `code` can be used once and expires at `exp` (Unix seconds), 5 minutes after it is issued.
   - `secureHost`/`securePort` are present when the encrypted link (`tailscale serve`) is up. `hosts` lists the plain link's addresses, and is empty when the plain link is switched off.
2. The phone sends `POST https://<secureHost>:<securePort>/pair` (or `http://<host>:8787/pair` on the plain link) with this body:
   ```json
   {"code":"…","deviceName":"Pixel 8","platform":"android"}
   ```
   It tries the encrypted link first, then each host in `hosts`, until one answers. The Google Play build uses the encrypted link only.
3. The helper replies `200` with:
   ```json
   {"deviceId":"dev_…","deviceSecret":"<base64url 32 bytes>","helperId":"hlp_…","helperName":"my-pc"}
   ```
   It replies `401` if the code is wrong or expired, and `403` on the encrypted link if the phone's Tailscale account isn't allowed.
4. The phone stores `deviceSecret` encrypted, using a key held in Android Keystore. The secret never travels over the network again.

## Connect and authenticate

1. The phone opens `wss://<secureHost>:<securePort>/ws` (or `ws://<host>:8787/ws` on the plain link). File and app downloads use the same scheme, host and port.
2. The PC sends `auth.challenge`, with payload `{ "nonce": "<base64url 32 bytes>", "helperId": "hlp_…" }`.
3. The phone answers with `auth.response`, with payload `{ "deviceId", "mac", "lastSeq", "phoneNonce" }`.
   - `mac` is `base64url(HMAC-SHA256(key = base64url-decoded deviceSecret, message = UTF-8 of nonce + "|" + deviceId))`.
   - `lastSeq` is the highest `seq` the phone has processed. Send `0` on first connect.
   - `phoneNonce` is the phone's own random challenge (base64url, 32 bytes).
4. The PC replies with either:
   - `auth.ok`, with payload `{ "helperName", "sessions": Session[], "activeSessionId", "replayFrom": number, "disabled": boolean, "proof" }`. Next, the PC replays every buffered frame with `seq > lastSeq`, with `"replay": true` added inside each one's payload. After that, live frames follow.
     - `proof` is `base64url(HMAC-SHA256(deviceSecret, "helper|" + phoneNonce + "|" + nonce + "|" + deviceId + "|" + helperId))`. The phone closes the connection if it is missing or wrong, so a machine that doesn't hold the secret can't pose as the PC.
   - `auth.fail`, with payload `{ "reason" }`. The PC then closes the socket.

The PC closes the socket if `auth.response` doesn't arrive within 10 seconds.

## Phone → PC

| type | payload | meaning |
|---|---|---|
| `utterance` | `{ text, sessionId?, source: "voice" \| "typed", queuedAt? }` | A user turn. If `sessionId` is omitted, the active session is used. If the session is busy, the PC queues the turn (FIFO). |
| `confirm.response` | `{ confirmId, decision: "confirm" \| "cancel" \| "timeout", heard }` | The answer to `confirm.request`. `heard` is the raw transcript, kept for the audit log. |
| `turn.cancel` | `{ turnId? }` | Interrupts the current turn. If `turnId` is omitted, it cancels whatever is running. |
| `kill` | `{}` | Stops all turns in all sessions, rejects pending confirmations, and kills the child processes. |
| `session.new` | `{ name, cwd? }` | Creates a named session and makes it active. |
| `session.select` | `{ sessionId }` | Changes the active session. |
| `session.reset` | `{ sessionId? }` | Starts a fresh conversation in that session. |
| `catalog.list` | `{}` | Asks for recent Claude Code sessions on the PC (desktop app, terminal, phone). The PC answers `catalog`. |
| `session.attach` | `{ claudeSessionId }` | Continues that existing session from the phone (hand-off: same session, not a copy). It becomes the active session. If it's already attached, the PC just selects it. |
| `ack` | `{ seq }` | Lets the PC trim its replay buffer. Send at most once a second. |
| `ping` | `{}` | Heartbeat, every 15 seconds. The PC answers `pong`. |

## PC → Phone

| type | payload | meaning |
|---|---|---|
| `turn.started` | `{ turnId, sessionId, text }` | A turn has begun. `text` echoes the utterance. |
| `reply.delta` | `{ turnId, text }` | Streaming assistant text, for the **screen only**. Never spoken. |
| `turn.progress` | `{ turnId, label }` | What Claude is doing, e.g. "Checking disk space". Shown on screen. |
| `speak` | `{ turnId?, text, priority: "normal" \| "low" \| "interrupt" }` | **The only frame type the phone speaks.** `interrupt` stops current speech and speaks straight away. `low` may be dropped if the phone is listening or already speaking. |
| `turn.done` | `{ turnId, text, durationMs }` | Final answer (the same text as the final `speak`). |
| `turn.failed` | `{ turnId, error }` | The turn ended with an error or was cancelled. |
| `confirm.request` | `{ confirmId, turnId, tier: 1 \| 2, summary, command, phrase, expiresInS }` | Approval is needed (see below). |
| `confirm.resolved` | `{ confirmId, decision: "confirm" \| "cancel" \| "timeout", by: "phone" \| "server" }` | Lets the phone stop listening if the request timed out on the PC. |
| `session.list` | `{ sessions: Session[], activeSessionId }` | Sent after any session change. |
| `catalog` | `{ items: CatalogItem[] }` | Reply to `catalog.list`. Most recent first, up to 30. Not buffered or replayed. |
| `status` | `{ busy: boolean, queued: number, disabled: boolean }` | Sent whenever the status changes. |
| `error` | `{ code, message }` | A protocol or helper error. |
| `pong` | `{}` | Answer to `ping`. |

`Session = { id, name, cwd, model, busy, claudeSessionId? }`

`CatalogItem = { claudeSessionId, title, project, cwd, origin: "desktop" | "terminal" | "phone" | "other", lastActiveAt (epoch ms), activeRecently, attachedSessionId? }`

### Continuing a session from the phone (hand-off)

- The phone continues the **same** Claude Code session, so anything done from the phone appears when the session is reopened on the PC.
- Don't use the session in both places at once. If `activeRecently` is true (the session was used in the last 3 minutes), the phone shows a warning before attaching. After attaching, the PC also says so aloud.
- The continued session runs under the phone's policy (tiers, denylist, audit), in the session's own project folder. It uses the helper's default voice model, not the model the session originally used.

## Spoken confirmation flow

1. The PC sends `confirm.request`. For example:
   ```json
   {"confirmId":"c_1","turnId":"t_9","tier":2,"summary":"Delete 4 log files in Downloads","command":"Remove-Item C:\\Users\\ben\\Downloads\\*.log","phrase":"confirm delete","expiresInS":45}
   ```
   - `phrase` changes per request. It is always "confirm" plus one verb, e.g. "confirm delete", "confirm install", "confirm push".
   - For tier 2, `summary` names the exact target.
2. The phone **interrupts** any current speech and says: *"{summary}. Say '{phrase}' to go ahead, or 'cancel'."* Then it opens the mic in a dedicated confirmation window of 8 seconds, extended once if it hears speech.
3. How the phone matches what it heard (lower-cased, punctuation stripped):
   - **confirm:** the transcript contains every word of `phrase` in order, **and** contains no "cancel", "no", "stop" or "don't". For tier 1, the single word "yes" or "confirm" is also accepted.
   - **cancel:** it hears "cancel", "no", "stop" or "don't".
   - **unclear or silence:** the phone repeats the prompt once. If still unclear, it sends `cancel`.
4. The phone sends `confirm.response`. If nothing arrives within `expiresInS`, the PC treats it as `timeout` (deny).
5. A confirmation is **never** queued offline. If the socket drops, the PC denies the pending request.

## Browsers (the web client)

The web client (`apps/web-client`) is served by the helper on the same HTTPS link, pairs with `platform: "browser"`, and authenticates exactly like the phone (it always sends `phoneNonce` and checks `proof`). The helper tells phones and browsers apart by the paired device's platform:

- **Who gets what.** `turn.item`, `turn.usage`, `ask.request` and `ask.resolved` go to browsers only. `confirm.request` goes to the kind of device that sent the request being worked on (`turn.started.origin`): voice confirmation on the phone, Allow/Deny in the browser, which also gets `sessionId`, `tool`, `toolUseId` and `input` so it can show the call in full.
- **`turn.item`** carries one finished piece of a turn: `text`, `thinking`, `tool_use` (`id` = Claude's tool_use id), `tool_result` (`toolUseId`, `output` cut to 20,000 characters with `truncated`), or `plan` (a plan written in plan mode). `reply.delta` still streams the text as it's written; a `text` item replaces what was streamed for that block.
- **Permission modes.** `session.settings` sets a session's `permissionMode` (browsers only), `model`, `effort` or `name`. `bypassPermissions` needs `bypassAcknowledged: true`. Modes apply to requests sent from a browser; phone requests keep the voice rules.
- **Questions.** Claude's `ask_user` tool sends `ask.request` with up to 4 questions of 2 to 8 options; the browser answers with `ask.response` (`answers` keyed by question text, or `null` to skip). From a phone request, the tool tells Claude to ask in its reply instead.
- **Speech.** Requests sent from a browser produce no `speak` frames for the reply or "still working".
- **Origin check.** Requests and WebSocket upgrades that carry an `Origin` header must come from the helper's own HTTPS address.
- **Attachments.** The browser sends `upload.begin` (`ref`, `name`, `size`, `mime`); the helper answers `upload.ready` (`ref`, `uploadId`, `token`) or an `error` with code `upload_refused`. The browser then POSTs the bytes to `/upload/<uploadId>` with header `x-ca-upload: <token>` (exactly `size` bytes, up to 25 MB; one use). `utterance.attachments` lists the upload ids. Pictures recognised by their bytes (PNG, JPEG, GIF, WebP, up to about 3.7 MB) are sent to Claude inline; other files stay on the PC and their paths are added to the text Claude gets. `turn.started.attachments` describes them for the conversation.
- **@-mentions.** `files.search` (`sessionId`, `query`) is answered with `files` (`items`: paths relative to the session's folder, best matches first). Claude Code expands `@path` itself.
- **Commands.** `commands.get` is answered with `commands` (`name`, `skill`): the slash commands and skills the session's CLI offers, without terminal-only ones. Browsers also get `commands` when the list changes. A message that starts with `/name` runs it (e.g. `/compact`, after which `turn.usage` reports the smaller context).

## Replay and resume

- The PC keeps the last 500 frames, or 24 hours, per device, in memory and on disk.
- On reconnect, frames with `seq > lastSeq` are replayed with `payload.replay = true`.
- For replayed `speak` frames more than 60 seconds old, the phone does not speak each one. It collapses them into one sentence, "While you were away: <last turn.done text>".
- If the phone loses the connection before an `utterance` has been sent, it keeps it in a local queue for up to 30 minutes. When it reconnects, it asks "Still want me to …?" before sending.
