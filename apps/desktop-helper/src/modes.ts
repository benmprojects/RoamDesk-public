// Permission modes for turns sent from a browser, on top of the policy tiers (policy.ts).
// Phone turns don't use these: they keep the voice rules (tier 2 asks by voice; "skip confirmations" setting).
import type { PermissionMode } from "@claude-anywhere/protocol";
import type { Decision } from "./policy.js";

export type Verdict = "allow" | "ask" | "deny";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * - default ("Ask"): look-ups and routine steps run; risky steps ask in the browser.
 * - acceptEdits: as default, and file edits anywhere also run without asking.
 * - plan: as default; Claude Code itself keeps Claude to planning until the plan is approved.
 * - bypassPermissions: everything runs, including normally blocked steps. Credentials, keys and the helper's own
 *   files (locked) stay off limits, and tools that aren't enabled stay unavailable.
 */
export function browserVerdict(d: Decision, mode: PermissionMode | undefined, tool: string): { verdict: Verdict; why: string } {
  if (d.tier === "deny") {
    if (mode === "bypassPermissions" && !d.locked && !/is not enabled/.test(d.reason)) return { verdict: "allow", why: `${d.reason}; blocked list lifted (bypass permissions)` };
    return { verdict: "deny", why: d.reason };
  }
  if (d.tier === 0 || d.tier === 1) return { verdict: "allow", why: d.reason };
  if (mode === "bypassPermissions") return { verdict: "allow", why: `${d.reason}; bypass permissions` };
  if (mode === "acceptEdits" && EDIT_TOOLS.has(tool)) return { verdict: "allow", why: `${d.reason}; accept edits` };
  return { verdict: "ask", why: d.reason };
}
