// Phase 0 · Test 1 — Agent SDK + PowerShell on Windows: tools, policy, deny path, resume.
import { writeFileSync } from "node:fs";
import { runTurn, print } from "./agent.js";

const t1 = await runTurn("How much free space is on my C drive, and how long has this PC been up?");
print("Turn 1 — read-only PowerShell", t1);
console.log(`Tools available at init: ${t1.initTools?.join(", ")}`);
console.log(`PowerShell tool present: ${t1.initTools?.includes("PowerShell")}`);

const t2 = await runTurn(
  "Create a text file called roamdesk-test.txt in my temp folder containing the word hello.",
  { resume: t1.sessionId },
);
print("Turn 2 — write attempt (should be DENIED by policy)", t2);
const writeAttempted = t2.tools.length > 0;

const t3 = await runTurn("What was the first thing I asked you in this conversation?", { resume: t1.sessionId });
print("Turn 3 — resume check (should recall the disk/uptime question)", t3);

const summary = {
  powershellToolPresent: t1.initTools?.includes("PowerShell") ?? false,
  turn1Ok: !t1.isError && t1.tools.length > 0,
  writeAttempted,
  resumeRecalled: /disk|space|drive|uptime|up/i.test(t3.text),
  authSource: t1.apiKeySource, // "none" = subscription sign-in, not an API key
  notionalCostUsd: [t1, t2, t3].reduce((a, r) => a + (r.costUsd ?? 0), 0), // CLI's estimate; not billed on a subscription
  turns: { t1, t2, t3 },
};
writeFileSync("results/smoke.json", JSON.stringify(summary, null, 2));
console.log("\nSummary:", { ...summary, turns: undefined });
console.log("Check results/audit.jsonl — the write in turn 2 must show decision: deny.");
