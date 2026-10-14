// Runs one voice turn by driving the official `claude` CLI headless, on the signed-in subscription.
// Policy is enforced by hooks/policy.mjs (PreToolUse); anything that would still prompt is denied.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKDIR = join(ROOT, "workdir"); // empty folder: no project settings or CLAUDE.md get picked up
mkdirSync(WORKDIR, { recursive: true });
mkdirSync(join(ROOT, "results"), { recursive: true });

const POLICY_HOOK = join(ROOT, "hooks", "policy.mjs").replace(/\\/g, "/");
const SETTINGS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${POLICY_HOOK}"`, timeout: 30 }] }] },
});

const VOICE_RULES =
  "You are being driven by voice from a phone while the user drives. Final answers: at most two short spoken sentences, " +
  "no markdown, no file paths unless asked. Prefer the PowerShell tool for commands. If a tool is denied, say so briefly.";

export type TurnResult = {
  sessionId?: string;
  text: string;
  tools: string[];
  costUsd?: number;
  durationMs?: number;
  firstTextMs?: number;
  isError: boolean;
  initTools?: string[];
  apiKeySource?: string;
  model?: string;
  stderr?: string;
};

export function runTurn(
  prompt: string,
  opts: { resume?: string; model?: string; effort?: string; partial?: boolean } = {},
): Promise<TurnResult> {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", opts.model ?? "claude-opus-5-5",
    "--effort", opts.effort ?? "medium",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--settings", SETTINGS,
    "--permission-prompts", "none",
    "--add-dir", homedir(),
    "--append-system-prompt", VOICE_RULES,
  ];
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.partial) args.push("--include-partial-messages");

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" };
  delete env.ANTHROPIC_API_KEY; // make sure the subscription sign-in is what gets used

  const res: TurnResult = { text: "", tools: [], isError: false };
  const t0 = performance.now();
  return new Promise((resolveTurn) => {
    const child = spawn("claude", args, { cwd: WORKDIR, env, windowsHide: true });
    child.stdin.end();
    let buf = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "system" && m.subtype === "init") {
          res.initTools = m.tools;
          res.apiKeySource = m.apiKeySource;
          res.model = m.model;
        }
        if (m.type === "stream_event" && res.firstTextMs === undefined && m.event?.delta?.type === "text_delta") {
          res.firstTextMs = performance.now() - t0;
        }
        if (m.type === "assistant") {
          for (const b of m.message.content) {
            if (b.type === "tool_use") res.tools.push(`${b.name}: ${JSON.stringify(b.input).slice(0, 160)}`);
            if (b.type === "text" && res.firstTextMs === undefined) res.firstTextMs = performance.now() - t0;
          }
        }
        if (m.type === "result") {
          res.sessionId = m.session_id;
          res.costUsd = m.total_cost_usd;
          res.durationMs = m.duration_ms;
          res.isError = Boolean(m.is_error) || m.subtype !== "success";
          res.text = m.result ?? `(${m.subtype})`;
        }
      }
    });
    child.on("close", (code) => {
      if (code !== 0) res.isError = true;
      if (stderr.trim()) res.stderr = stderr.trim().slice(0, 2000);
      if (!res.durationMs) res.durationMs = performance.now() - t0;
      resolveTurn(res);
    });
  });
}

export function print(label: string, r: TurnResult) {
  console.log(`\n=== ${label} ===`);
  console.log(`Reply: ${r.text}`);
  console.log(`Tools used: ${r.tools.length ? "\n  - " + r.tools.join("\n  - ") : "none"}`);
  console.log(
    `Session ${r.sessionId} · ${((r.durationMs ?? 0) / 1000).toFixed(1)} s · model ${r.model} · auth source ${r.apiKeySource} · error ${r.isError}`,
  );
  if (r.stderr) console.log(`stderr: ${r.stderr}`);
}
