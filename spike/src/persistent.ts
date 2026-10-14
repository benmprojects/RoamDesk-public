// Phase 0 · Test 2b — latency with ONE long-lived CLI process per session (stream-json in and out).
// This is how the real helper would run: no start-up cost per voice turn.
// Usage: npm run persistent -- [model] [effort]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.argv[2] ?? "claude-sonnet-5-5";
const effort = process.argv[3] ?? "low";
const POLICY_HOOK = join(ROOT, "hooks", "policy.mjs").replace(/\\/g, "/");

const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" };
delete env.ANTHROPIC_API_KEY;

const child = spawn(
  "claude",
  [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model", model,
    "--effort", effort,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${POLICY_HOOK}"`, timeout: 30 }] }] } }),
    "--permission-prompts", "none",
    "--add-dir", homedir(),
    "--append-system-prompt", "Voice assistant for a driver. At most two short spoken sentences. No markdown.",
  ],
  { cwd: join(ROOT, "workdir"), env, windowsHide: true },
);
child.stderr.on("data", (d) => process.stderr.write(d));

type Waiter = { t0: number; first?: number; resolve: (r: { first: number; total: number; text: string }) => void };
let waiter: Waiter | null = null;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line || !waiter) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "stream_event" && waiter.first === undefined && m.event?.delta?.type === "text_delta") waiter.first = performance.now() - waiter.t0;
    if (m.type === "result") {
      const w = waiter;
      waiter = null;
      w.resolve({ first: w.first ?? NaN, total: performance.now() - w.t0, text: m.result ?? "" });
    }
  }
});

const ask = (text: string) =>
  new Promise<{ first: number; total: number; text: string }>((res) => {
    waiter = { t0: performance.now(), resolve: res };
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  });

const turns = [
  "Hey, are you there? Don't use any tools.",
  "Without tools, summarise for a driver: 'Ran git status in tender-tool. 3 files modified, 1 untracked, 2 commits ahead of origin/main.'",
  "Without tools, in 15 words or fewer: 'Installed 412 npm packages, 86 tests, 84 passed, 2 failed in pricing.test.ts.'",
  "What's the free space on my C drive?",
  "Thanks. What did I ask you first?",
];
const results = [];
for (const t of turns) {
  const r = await ask(t);
  results.push({ prompt: t, ...r });
  console.log(`first text ${r.first.toFixed(0)} ms · total ${r.total.toFixed(0)} ms · ${r.text}`);
}
child.stdin.end();
writeFileSync(`results/persistent-${model}-${effort}.json`, JSON.stringify(results, null, 2));
