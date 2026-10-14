// PreToolUse policy hook — the permission gate for every tool call the CLI makes.
// Claude Code passes the tool call as JSON on stdin; we print a decision as JSON on stdout.
// Spike behaviour: Tier 0 (read-only) is allowed, everything else is denied.
// Later: Tier 1/2 will call the helper, which asks the phone for a spoken approval.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
mkdirSync(RESULTS, { recursive: true });

const input = JSON.parse(readFileSync(0, "utf8"));
const tool = input.tool_name;
const args = input.tool_input ?? {};

const HARD_DENY = /\b(format|diskpart|bcdedit|cipher\s+\/w)\b|Remove-Item\s+.*C:\\(Windows|Users)\\?\s*$|Set-MpPreference|netsh\s+advfirewall/i;
const SAFE_SEGMENT = /^\s*(Get-[A-Za-z]+|Test-[A-Za-z]+|Measure-Object|Select-Object|Sort-Object|Where-Object|ForEach-Object|Format-[A-Za-z]+|Out-String|git\s+(status|log|diff|branch)|hostname|whoami|dir|ls)\b/i;
const UNSAFE_TOKENS = /[;&`>]|\$\(|\b(Remove|Set|New|Invoke|Start|Stop|Rename|Move|Copy|Clear|Add|Out-File)-/i;

function decide() {
  const cmd = String(args.command ?? "");
  if (HARD_DENY.test(cmd)) return ["deny", "hard denylist"];
  if (["Read", "Glob", "Grep", "TodoWrite"].includes(tool)) return ["allow", "tier0 read"];
  if (tool === "PowerShell" || tool === "Bash") {
    const ok = cmd.split("|").every((s) => SAFE_SEGMENT.test(s)) && !UNSAFE_TOKENS.test(cmd);
    return ok ? ["allow", "tier0 read-only command"] : ["deny", "not on read-only allowlist (spike)"];
  }
  return ["deny", `tool ${tool} not permitted in spike`];
}

const [decision, reason] = decide();
appendFileSync(
  join(RESULTS, "audit.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), session: input.session_id, tool, input: args, decision, reason }) + "\n",
);
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: `Roam Desk policy: ${reason}` },
  }),
);
