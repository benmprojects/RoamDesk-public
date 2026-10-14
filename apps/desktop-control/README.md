# Desktop control

A Claude Code plugin that lets Claude use this Windows PC's screen, mouse and keyboard quickly and reliably.

Claude can't watch video: it sees the screen only when a tool returns a picture. So speed comes from the tools, not
from a frame rate:

- **Controls by id.** `screen` lists the active window's buttons, fields, links and list items (Windows UI Automation),
  numbered. Clicking `element: 12` is far more reliable than guessing pixels.
- **No sleeping.** The screen is watched 5 times a second while Claude is using it (10 while it waits). `act` returns
  the moment the screen settles after its steps, and `wait_for` returns the moment it changes, settles, or some text
  appears or goes away (Windows' built-in text recognition).
- **Batched steps.** One `act` call clicks, types and presses keys in order, then looks again.
- **Between looks.** `screen` says whether, and how often, the screen changed since Claude last looked.

| Tool | What it does |
|---|---|
| `screen` | Picture of the monitor with the active window, active window and focus, changes since last look, numbered controls |
| `act` | Steps in order: click, double/right/middle click, move, drag, scroll, type, key, wait; then settle and look again |
| `wait_for` | Until `change`, `settle`, `text` or `text_gone`, with a time limit; reports where found text is |
| `zoom` | Sharper look at part of the screen, up to full resolution |
| `windows` | Open windows: title, program, monitor, minimised |
| `focus_window` | Bring a window to the front by title or program name |

## Safety

- **Desktop sessions only.** The Roam Desk helper refuses these tools in phone and car sessions, and the
  skip-confirmations setting can't change that (`apps/desktop-helper/src/policy.ts`).
- **Stops if you move the mouse** during an `act`, and **emergency stop**: push the pointer into the top-left corner of
  the leftmost screen.
- **Won't type into password fields** (it checks the focused field first) — type those yourself.
- **Can't see or click** the lock screen, UAC prompts or apps running as administrator. Windows blocks that for every
  normal program.
- Every action is logged (without what was typed) to `%LOCALAPPDATA%\ClaudeDesktopControl\actions.log`.

## Install or update

Needs the .NET 8 SDK.

```powershell
.\scripts\install.ps1
```

It builds the server into `plugin\bin`, adds this folder as the `claude-anywhere-local` marketplace and installs
`desktop-control` for your user. Start a new Claude Code session afterwards.

`DESKTOP_CONTROL_FPS` in `plugin\.mcp.json` sets the watch rate (1–15, default 5).

## Test

`node test\smoke.mjs <path to DesktopControl.exe> <scratch folder>` drives the real desktop against its own small test
window (`test\target.ps1`) — it never types into other apps. Don't touch the mouse while it runs (about 20 s).

## Layout

- `src/DesktopControl` — the MCP server (.NET 8): `Tools.cs` (the tools), `Desktop.cs` (snapshots and coordinates),
  `Frames.cs` (capture and change watching), `Uia.cs` (UI Automation), `Input.cs` (mouse and keyboard), `Ocr.cs`.
- `plugin` — the Claude Code plugin (`.mcp.json` starts `bin\DesktopControl.exe`).
- `.claude-plugin/marketplace.json` — the local marketplace the plugin installs from.
