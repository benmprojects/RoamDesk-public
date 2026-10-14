// Claude Code PreToolUse hook: forwards the tool call to the desktop helper for a policy decision.
// Fails CLOSED: if the helper can't be reached or answers badly, the tool call is denied.
import { readFileSync } from "node:fs";

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Roam Desk: ${reason}` } }),
  );
  process.exit(0);
};

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  deny("unreadable hook input");
}

const url = process.env.CA_HOOK_URL;
const token = process.env.CA_HOOK_TOKEN;
if (!url || !token) deny("helper not configured");

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ca-token": token },
    body: JSON.stringify({ sessionId: process.env.CA_SESSION_ID, tool: input.tool_name, input: input.tool_input ?? {}, toolUseId: input.tool_use_id }),
    signal: AbortSignal.timeout(590_000),
  });
  if (!res.ok) deny(`helper returned ${res.status}`);
  const body = await res.json();
  if (body?.hookSpecificOutput?.permissionDecision !== "allow" && body?.hookSpecificOutput?.permissionDecision !== "deny") deny("bad helper response");
  process.stdout.write(JSON.stringify(body));
} catch (e) {
  deny(`helper unreachable (${e?.name ?? "error"})`);
}
