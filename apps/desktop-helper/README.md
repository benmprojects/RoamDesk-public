# Roam Desk — Desktop Helper

The helper runs on your Windows PC. Your paired phone sends it what you say, it runs Claude through the official `claude` CLI on your **Claude subscription** (no API key is used), and it sends back what Claude should say aloud. It also delivers files and app updates to the phone and serves a local dashboard.

## How it works

```
phone ──ws://<tailscale-ip>:8787/ws──► helper ──stdin/stdout stream-json──► claude -p (one process per session)
  │                                      ▲                                         │
  │                                      ├──── POST /hook/pretool (127.0.0.1) ◄────┤  PreToolUse hook → policy
  │                                      └──── POST /hook/send-file (127.0.0.1) ◄──┘  "phone" MCP tool → file offer
  └──── GET /file/<id>?a=…  and  GET /app/apk?a=…  (downloads, per-item access key)
```

- **Sessions.** Each named session is one long-lived `claude -p --input-format stream-json` process, started as soon as the phone connects so connectors are ready. It resumes with `--resume` after a cancel, a restart or a settings change. It loads your user, project and local Claude settings, so it has every built-in tool and every connector you've linked (claude.ai connectors and plugins), plus the helper's own `phone` MCP server (`mcp/phone.mjs`) whose `send_file` tool sends a file to the phone.
- **Instructions.** Every session gets the phone instructions from the dashboard's Settings card (built-in default in `src/voice.ts`): short spoken answers, never read commands to a driver, use Microsoft 365 for email and Teams, use `send_file` for files.
- **Policy gate.** `hooks/pretool.mjs` runs before every tool call and asks the helper for a decision. If the helper can't be reached, the call is denied. `src/policy.ts` classifies the call; PowerShell is parsed with PowerShell's own parser (`ps/classify.ps1`), not pattern matching.

  | Tier | Examples | What happens |
  |---|---|---|
  | 0 | Reading files, searching, `Get-*`, `git status/log/diff`, connector look-ups (search, list, get, read) | Runs |
  | 1 | Edits inside a project session's folder, `git add/commit`, `npm test`, `cd`, sending a file to the phone | Runs, and the phone says what it's doing |
  | 2 | Deleting, moving, installing, `git push/reset`, OneDrive or SharePoint paths, writes outside the session folder, connector sends and changes, Outlook automation, any other tool | The phone asks you to say a phrase such as "confirm delete". Silence, "cancel" or the timeout means it doesn't run |
  | Denied | Disk, boot, Defender, firewall or registry changes; user accounts; force-push; credentials or keys; the helper's own files; Windows shell automation | Never runs, and can't be approved by voice |

  Tier 2 also covers writes that make a later command run code (git hooks, `.claude` and `.vscode` settings, `package.json`, scripts), git options that launch programs (`-c`, `--output`, pagers), and web addresses or DNS look-ups that look like they're carrying data out. Credential files (`.env`, `.npmrc`, `.git-credentials`, keys, browser password stores) can't be read, and the helper's code, the shared `packages` and `node_modules` can't be changed.

  **Skip confirmations** runs tier 2 without asking and lifts the denied list too, except for credentials, keys and the helper's own files. Only the dashboard can turn it on; the phone can only turn it off. Everything is still logged and the kill switch still works.
- **Desktop hand-off.** When the phone continues a desktop Claude Code session, the helper ends the desktop app's process for it so desktop reloads the conversation when you reopen it. Handing a session back registers it with the desktop app if it was started on the phone (restart the desktop app to see it).
- **Files.** `send_file` copies the file into `%LOCALAPPDATA%\ClaudeAnywhere\outbox` (200 MB max, kept 24 h) and offers it to the phone with a random access key; the phone downloads it from `/file/<id>`.
- **App updates.** The helper offers the newest sideload build in `apps/android/app/build/outputs/apk/sideload/debug` to each phone that connects. Its version comes from `output-metadata.json`; every build has a higher `versionCode`.
- **Audit log.** Every utterance, decision and result is written to `%LOCALAPPDATA%\ClaudeAnywhere\audit\YYYY-MM-DD.jsonl`. Entries are hash-chained, and secrets are masked value by value.
- **Kill switch.** Any of these cancels running work and pending approvals: say "stop everything"; press Stop in the app or on Android Auto; click **Stop everything** on the dashboard; turn Remote access **Off** on the dashboard (writes the `DISABLED` file).

## Install and update

You need Node 24+, the `claude` CLI signed in to your subscription, and Tailscale running.

First install, from the repo folder:
```powershell
powershell -ExecutionPolicy Bypass -File apps\desktop-helper\scripts\install.ps1
```
This builds the helper and registers a Task Scheduler task called "Roam Desk Helper" for your user only. It starts hidden at sign-in, restarts every minute if it stops, and logs to `%LOCALAPPDATA%\ClaudeAnywhere\helper.log`. If `npm install` or the build fails, the script stops before touching the running helper. To remove it, run `scripts\uninstall.ps1`.

After that, use **Update helper** on the dashboard or **Update PC helper** in the app. It runs the same script with `-Quiet` in the background, logs to `update.log`, writes `update-result.json`, and the phone is told when the helper is back or why the update failed.

Development mode, with a console: `npm install` then `npm run helper`.

## Dashboard

http://127.0.0.1:8787/ (this PC only):

- Activity, Remote access on/off, Stop everything, paired phones (pair or unpair), sessions with **Continue on PC**.
- **Settings:** phone instructions (with reset to default), model, effort, approval timeout, "still working" delay, Skip confirmations.
- **Tools & connectors:** each connector's status from `claude mcp list`, with Refresh and a Sign in link for any that need it.
- **Web client extras** (Settings and the sidebar):
  - **Inbox:** the last 50 things the PC wanted you to see (Microsoft 365 dropped or came back, a routine finished, the helper updated). Kept in `%LOCALAPPDATA%\ClaudeAnywhere\inbox.json`.
  - **Routines:** a saved prompt on a schedule (daily, weekdays, weekly or once; the PC's clock). Runs unattended, so it is read-only: files, the web, and the Microsoft 365 search/read tools only. The answer goes to the Inbox. A run missed by over an hour (PC off) is skipped. Stored in `%APPDATA%\ClaudeAnywhere\routines.json`.
  - **Health check:** Claude's sign-in, helper version, Microsoft 365 and desktop control, the Tailscale link, remote access, browser tools and the audit log, each problem with a fix. Also `GET /api/doctor`.
- **"Needs authentication" cache:** after one 401, Claude Code writes the connector to `~\.claude\mcp-needs-auth-cache.json` and later sessions skip it without trying, even when the login works again (Claude Desktop is fine, and `claude mcp list` still says Connected). The helper clears a stale Microsoft 365 entry before every session starts (backing the file up first to `%LOCALAPPDATA%\ClaudeAnywhere\mcp-cache-backups`, last 10 kept) and on each connector check. After a clear it starts Claude once for real; if the entry comes back, the login really is bad and the reconnect is offered. The health check shows "Microsoft 365 skipped by Claude" while a flag is present. Other connectors' entries are never touched.
- **Microsoft 365 drops:** checked every 10 minutes. If it stays signed out for 2 minutes the phone or web client is asked "Reconnect it?"; only on a yes does a one-off Claude run click Connect in Chrome (never a password or MFA code, never Disconnect, at most 3 tries a day).
- **Update helper**, and the recent audit log.

## Configure

Most settings are on the dashboard. They're stored in `%APPDATA%\ClaudeAnywhere\config.json` (no secrets):

| Key | Default | Notes |
|---|---|---|
| `sessions[]` | Home | Each session has `{ id, name, cwd, model, effort, claudeSessionId }`. Set `cwd` to a project folder so edits there are tier 1 |
| `instructions` | empty | Custom phone instructions; empty means the built-in default |
| `skipConfirmations` | false | See the policy section |
| `plainUpdates` | true | Adds a rule to the instructions (spoken updates in everyday words, no file names, code or tool names), stops the helper reading out each routine step, and keeps "Still working" from naming the step. Steps still show on the phone's screen. A switch on the dashboard and in the app's Settings |
| `confirmTimeoutS` | 45 | How long to wait for a spoken confirmation (10–300) |
| `progressAfterS` | 8 | When to start saying "Still working…" (3–120) |
| `progressEveryS` | 20 | How often to repeat it while a request is still running (5–300) |
| `port` | 8787 | Dashboard, and the plain phone link |
| `securePort` | 8443 | HTTPS port on the PC's `.ts.net` name (tailscale serve) |
| `phonePort` | 8788 | Loopback port tailscale serve forwards to |
| `allowedUsers` | `[]` | Tailscale logins allowed on the encrypted link; empty = this PC's owner only |
| `plainTailnet` | true | Also accept the plain `ws://` link (older app versions) |
| `bind` | `["tailscale"]` | The helper also always listens on 127.0.0.1 |

Paired phones are listed in `devices.json`; their keys are stored in **Windows Credential Manager** under `ClaudeAnywhere/device/<id>`.

## Tests

```powershell
npm -w apps/desktop-helper test
npm -w apps/desktop-helper run e2e
```

- `test` runs the unit tests: HMAC, audit chain and masking, file offers and downloads.
- `e2e` starts a real helper and runs it end to end with a simulated phone and the real CLI. It uses a few turns of your subscription.

## Security notes and limits

- **Encrypted link:** at start-up the helper runs `tailscale serve --bg --https=8443 http://127.0.0.1:8788`, so phones connect to `wss://<pc>.<tailnet>.ts.net:8443/ws` with a real certificate. Tailscale adds the caller's login, and the helper only accepts the account this PC is signed in with (or the logins in `allowedUsers`). Port 8788 is loopback-only and serves just the phone routes, never the dashboard or hooks. It needs **HTTPS Certificates** switched on in the Tailscale admin console (DNS page); this publishes the PC's `.ts.net` name in public certificate logs. Remove it with `tailscale serve --https=8443 off`.
- **Plain link:** older app versions use `ws://<tailscale-ip>:8787/ws`. Set `plainTailnet` to `false` in config.json once every phone uses the encrypted link; the Google Play build never uses it.
- **Transport:** WebSocket and HTTP inside Tailscale's WireGuard tunnel (plus TLS on the encrypted link), with HMAC challenge-response both ways per connection (the phone proves itself to the PC, and the PC to the phone). The phone only connects to Tailscale addresses. File and app downloads need a per-item random access key that only authenticated phones receive. Payloads are not end-to-end encrypted beyond Tailscale.
- **Remote access off:** a paired phone can then only keep the connection alive, cancel and stop; history, sessions, settings, updates and downloads are refused.
- **Limits:** malformed messages are dropped without crashing; unauthenticated connections are capped per address; pairing attempts are limited per address.
- **Dashboard:** loopback only, with a Host header check; its write calls need a custom header, which blocks cross-site requests.
- **Locked PC:** works for files, PowerShell and connectors. Screenshots show the lock screen and nothing can click on the desktop until it's unlocked.
- **Logged out:** the helper doesn't run while you're logged out.
- **Usage:** it uses your Claude seat's usage limits.
