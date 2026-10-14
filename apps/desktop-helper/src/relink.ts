// Re-links Microsoft 365 when it drops, but only after the user says yes on their phone or in the web client (the
// server asks first). A one-off Claude run then drives the PC's signed-in Chrome through the claude.ai connector page.
// It never types a password or MFA code; if Microsoft asks for one it stops and says so.
import { execFile } from "node:child_process";

const WAIT_BEFORE_MS = 2 * 60_000; // it has to stay down this long first (a blip fixes itself)
const RETRY_AFTER_MS = 30 * 60_000;
const MAX_PER_DAY = 3;
const RUN_TIMEOUT_MS = 6 * 60_000;

export interface RelinkState {
  downSince: number | null;
  attempts: number[]; // start times of recent attempts
  running: boolean;
}

export const newRelinkState = (): RelinkState => ({ downSince: null, attempts: [], running: false });

/** Called after each connector check. Returns true when it's time to try a re-link. */
export function relinkDue(s: RelinkState, down: boolean, now: number): boolean {
  if (!down) {
    s.downSince = null;
    return false;
  }
  s.downSince ??= now;
  s.attempts = s.attempts.filter((t) => now - t < 24 * 3_600_000);
  if (s.running || now - s.downSince < WAIT_BEFORE_MS) return false;
  if (s.attempts.length >= MAX_PER_DAY) return false;
  if (s.attempts.length && now - s.attempts[s.attempts.length - 1] < RETRY_AFTER_MS) return false;
  return true;
}

const PROMPT = `Re-link the Microsoft 365 connector on claude.ai, using the Chrome browser tools.
1. Open https://claude.ai/customize/connectors/id/microsoft-365 in a new tab.
2. If the page shows a Connect button (the connector is NOT connected), click it and follow the Microsoft flow: choose the already signed-in account if asked ("Continue as ..."), and click Accept/Allow on the Microsoft 365 connector's consent screen. Nothing else.
3. If the page already says Connected, do nothing: reply "Already connected".
Hard rules: never type or paste a password, MFA code or any secret; never click Disconnect or Remove; do not touch any other connector or setting. If Microsoft asks for a password, an MFA approval or anything you can't do by clicking, stop and reply "NEEDS YOU:" followed by one short sentence saying what it wants. Close the tab you opened when finished. Reply with one sentence: "Re-linked", "Already connected" or "NEEDS YOU: ...".`;

/** Runs the re-link. Resolves with Claude's one-line outcome. */
export function runRelink(claudePath: string): Promise<{ ok: boolean; message: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // the subscription sign-in, like every other run
  return new Promise((resolve) => {
    execFile(
      claudePath,
      ["-p", PROMPT, "--chrome", "--allowedTools", "mcp__claude-in-chrome__*", "--max-turns", "40", "--output-format", "text"],
      { env, windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const text = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
        if (err && !text) return resolve({ ok: false, message: `NEEDS YOU: the automatic re-link didn't finish (${String(err.message).slice(0, 80)}).` });
        resolve({ ok: /^(re-linked|already connected)/i.test(text), message: text.slice(0, 300) || "NEEDS YOU: no answer from the automatic re-link." });
      },
    );
  });
}
