# Web client

Use Claude Code on your PC from any browser on your Tailscale network, the way you'd use the Claude desktop app's Code tab. The desktop helper serves it over its encrypted link, so there's nothing to install.

**Address:** `https://<your PC>.<tailnet>.ts.net:8443/` (shown on the helper dashboard under **Paired devices**).

## What it does (phase 1)

- **Conversation like the desktop app:** formatted replies (headings, lists, tables, code blocks with Copy), streamed as Claude writes, thinking, and every tool call as a card you can expand: the command or input, the result, and file edits as a diff.
- **Approvals in the browser:** a risky step shows Allow / Deny under its tool card.
- **Permission modes per session:** **Ask** (routine steps run, risky ones ask), **Accept edits** (file edits also run), **Plan** (Claude plans without changing anything, then you approve the plan), **Bypass permissions** (everything runs; needs you to accept a warning). Credentials, keys, the helper's own files, password fields and the lock screen stay off limits in every mode.
- **Claude's questions:** when Claude needs a choice, it asks with buttons (its `ask_user` tool), and you can type your own answer.
- **Model and effort** per session, **context used** (click to compact), **Stop** (or Esc), messages typed while Claude works are **queued**.
- **New session folder:** type a path or click **Browse…** to pick a folder on the PC (drives, Home, Desktop, Documents, OneDrive and recent session folders; folder names only, local drives only).
- **Parallel sessions:** each session runs on its own; the sidebar shows which are working and which have something new.
- **Full history:** opening a session shows its whole conversation from Claude Code's own transcript on the PC (your messages, replies, thinking, tool calls with results and diffs, compactions), loading older parts as you scroll up. Works for sessions continued from the desktop app too.
- **Files** Claude sends appear as download cards. **Continue a session from this PC** picks up a desktop-app or terminal conversation; **Hand back** returns it.

Requests typed in the browser aren't read aloud on the phone, and the phone still uses its voice rules for its own requests.

## Workspace panes (phase 3)

The **Terminal**, **Changes** and **Files** buttons at the top open a pane beside the conversation (full screen on a phone):

- **Terminal:** the commands Claude ran in this session and their output, live, including ones waiting for approval. Read-only: you can't type into it, so everything still goes through the approvals and the audit log.
- **Changes:** every file changed in the session's folder since the last commit (git), with diffs; it refreshes when Claude finishes. In a folder that isn't a git repository, the files Claude edited in the conversation instead. **Open** shows the file.
- **Files:** find a file in the session's folder and read it: code with line numbers, Markdown rendered (or its source), pictures shown. Tool cards for Read, Edit and Write have **Open file** too. Read-only; only files in the session's folder (or its repository), never credentials or the helper's own files. Git runs with external diff tools, text converters and the file-system monitor switched off.

## Rich input (phase 2)

- **Attachments:** the 📎 button, pasting (a screenshot, or a file copied in Explorer) or dropping files anywhere on the page. Up to 10 per message, 25 MB each. Pictures (PNG, JPEG, GIF, WebP up to about 3.7 MB) go to Claude inline, so it sees them; other files are saved on the PC in `%LOCALAPPDATA%\ClaudeAnywhereUploads` (kept a week) and Claude is told where they are. Each upload goes into a one-time slot the helper hands out over the authenticated connection.
- **@-mentions:** type `@` and part of a name to pick a file from the session's folder (git's file list when it's a repository, otherwise a quick search that skips build and dependency folders). Claude Code reads the file in.
- **Dictation:** the microphone button types what you say into the message box (Australian English); press it again to stop. Nothing is sent until you press Enter. It uses the browser's own speech recognition, so it shows in Chrome, Edge and Safari but not Firefox, and Chrome and Edge send the audio to their speech service. The browser asks for the microphone the first time; the helper allows it for this page only.
- **Slash commands and skills:** type `/` at the start of a message for the session's commands and skills, e.g. `/compact`, `/context`, or a skill. Commands that only work in a terminal aren't offered.

## Pairing

On the PC dashboard click **Pair a device**, copy the pairing text, open the web client and paste it. The browser stores a key it can't export (WebCrypto, kept in IndexedDB). To remove it, use **Settings › Unpair this browser**, and unpair it on the dashboard.

Every connection needs **both** your Tailscale login (only the PC owner's, or the dashboard's allowed users) **and** the paired browser key. The helper and the browser each prove they hold the key.

## Security

- No HTML from Claude, tools or the PC is ever inserted into the page: markdown is parsed to a tree and built with `textContent` (`js/markdown.js`, `js/view.js`). Links are only `http(s)` and `mailto`.
- The helper serves the page with a strict Content-Security-Policy (scripts and styles only from the page itself, no inline code, no framing) and refuses WebSocket and API requests whose `Origin` isn't its own address.
- Downloads are sent as attachments with `nosniff` and a sandbox policy, so a file can never run as a page.
- The client's files are protected like the helper's own: Claude can't edit them from a phone or browser session.

## Develop

Plain ES modules, no build step.

```bash
npm test --prefix apps/web-client
```

```bash
node apps/web-client/test/mock-helper.mjs 8799
```

The mock helper serves the client at http://127.0.0.1:8799/, pairs with any text, and plays a scripted conversation with every kind of entry. Send a message containing "plan" for the plan flow.

| File | What it is |
|---|---|
| `js/state.js` | Sessions and conversations built from the helper's messages (tested) |
| `js/markdown.js` | Markdown to a safe tree (tested) |
| `js/diff.js`, `js/tools.js` | Line diffs and tool-call summaries (tested) |
| `js/composer.js` | @-mention and /command detection, insertion and ranking (tested) |
| `js/attach.js`, `js/suggest.js` | Attachments and the suggestions popup |
| `js/view.js` | Rendering |
| `js/link.js`, `js/keystore.js` | Connection, mutual authentication, the browser's key |
| `js/main.js` | Wiring and controls |

## Not yet

Committing and pushing from the browser, and git worktrees (not chosen for phase 3). An interactive terminal is deliberately not offered.
