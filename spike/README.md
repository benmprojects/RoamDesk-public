# Phase 0 Spike

**Approach:** the helper drives the official `claude` CLI in headless mode, using the **Team subscription you're already signed in with**. No API key is needed. Every tool call goes through the policy gate in `hooks/policy.mjs`, a PreToolUse hook that writes to `results/audit.jsonl`. `--permission-prompts none` means anything that would otherwise pop up an approval prompt is denied.

| # | Question | How | Status |
|---|---|---|---|
| 1 | Does the CLI + PowerShell + policy + resume work on Windows, on the subscription? | `npm run smoke` | ✅ Passed 07/10/2026 |
| 2 | Is it fast enough for voice? | `npm run latency`, then `npm run persistent -- <model> <effort>` | ✅ Done 07/10/2026; see results |
| 3 | Does it keep working while the PC is **locked**? | `npm run locked` (you press Win+L) | ✅ Passed 07/10/2026: shell work ran normally while locked. The screenshot captured the **lock screen**, not the desktop |
| 4 | Is Remote Control + Android voice typing good enough already? | Manual (below) | ⏳ Needs you |
| 5 | Does it work while **logged out** or after a reboot? | Manual, optional (below) | ⏳ Optional |

## Results so far (07/10/2026)

**Test 1: smoke (Opus 5.5, effort medium)**
- `apiKeySource: none`: the run used the subscription sign-in, not an API key.
- The PowerShell tool is available. Disk space and uptime were answered with read-only commands.
- The policy denied a compound command (`;` / `$(...)`). Claude retried with simple commands, which were allowed.
- **The write was denied** (`Write`, logged in the audit file). No file was created.
- Resume works: turn 3 recalled the first question.
- The CLI's notional cost for the three turns was about US$0.98. On a subscription this counts against your usage limits; you aren't billed for it.

**Test 2: latency, time to first spoken text**

| Setup | Model | First text, median | Notes |
|---|---|---|---|
| New CLI process per turn | Haiku 4.5 | ~4.5 s | Start-up cost dominates |
| New CLI process per turn | Sonnet 5.5 (low) | ~2.5 s | |
| New CLI process per turn | Opus 5.5 (low) | ~2.5 s | |
| **One long-lived process** | **Sonnet 5.5 (low)** | **~1.0 s** (2.2 s on the first turn) | ✅ Meets the < 1 s goal on warm turns |
| One long-lived process | Haiku 4.5 | ~1.7–3.0 s | Slower than Sonnet in this test; also wouldn't use tools on its own |

**Conclusions**
- Run **one long-lived CLI process per session** (`--input-format stream-json`), not one process per turn.
- Use **Sonnet 5.5 at low effort** for the voice tier. Haiku gives no speed advantage.
- Use the full model ID `claude-sonnet-5-5`. The alias `sonnet` resolves to the older `claude-sonnet-5`. CLI 2.1.282 logs a harmless `unrecognized_model` warning for the full ID, but the right model runs.

**Issues to fix in the MVP**
- The regex allowlist is too strict. Sonnet gave up on "free space on C:" after one denial. Fix by classifying commands with the PowerShell AST parser and telling the model in its prompt which command shapes are allowed.
- The CLI exposes tools we don't want (Artifact, Workflow, Cron, WebSearch and others). Restrict them with `--tools` / `--disallowedTools`.
- `--permission-prompt-tool` is hidden in CLI 2.1.282. Spoken approvals will go through the PreToolUse hook instead: the hook calls the helper, which asks the phone.

## Test 3: Does it keep working while locked?
```powershell
npm run locked
```
Press **Win+L** straight away and leave the PC locked for about 3 minutes. Then unlock it and open `results/locked.json`.

What I expect:
- `agent.ok: true`
- the screenshot is black or fails

## Test 4: Remote Control baseline (manual, about 30 min)
1. Run `claude --remote-control` and pair your phone with the Claude app on Android.
2. Parked, with the phone on Bluetooth, use keyboard **voice typing** to ask for:
   - free disk space
   - the last 3 files you changed
   - something that needs your approval
3. Note what didn't work without looking at the screen. That becomes the MVP backlog.

## Test 5 (optional): Logged out or after a reboot
Register `npm run smoke` as a Task Scheduler task:
- Set it to **"Run whether user is logged on or not"** under your account. Enter your password yourself.
- Sign out, or reboot, and trigger the task.
- If `results/smoke.json` updates, a background helper works while you're logged out.
- Also check the CLI's sign-in is still valid in that context. It reads `%USERPROFILE%\.claude`.
