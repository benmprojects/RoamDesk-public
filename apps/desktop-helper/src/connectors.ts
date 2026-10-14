// Connector (MCP server) status as the `claude` CLI sees it — the same set phone sessions load.
import { execFile } from "node:child_process";

export interface Connector {
  name: string;
  status: "connected" | "needs-auth" | "failed" | "not-configured" | "unknown";
  detail: string;
}

interface Snapshot { at: number; items: Connector[]; error?: string }
let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
const TTL_MS = 5 * 60_000;

/** claude.ai connectors are signed in on the account, not by the CLI, so this page works from a phone too. */
export const SIGN_IN_URL = "https://claude.ai/customize/connectors";

let onRecovered: (() => void) | null = null;
/** Called when a connector that needed signing in is connected on the next check, so running sessions can pick it up. */
export function onConnectorsRecovered(cb: () => void) {
  onRecovered = cb;
}

/** Only these are announced on the phone; most accounts have many other connectors that are never signed in. */
export const ANNOUNCED = /^(claude\.ai\s+)?Microsoft 365$/i;

let flaggedDown: string[] = [];
/** Connectors Claude Code still skips after its stale flag was cleared and a real start re-flagged them: genuinely signed out. */
export function setFlaggedDown(names: string[]) {
  flaggedDown = names;
}

/** Names of the announced connectors waiting for a sign-in, from the last check (empty before the first one). */
export function needsSignIn(): string[] {
  const names = new Set((cache?.items ?? []).filter((x) => x.status === "needs-auth" && ANNOUNCED.test(x.name)).map((x) => x.name));
  for (const n of flaggedDown) names.add(n);
  return [...names].map((n) => n.replace(/^claude\.ai\s+/i, ""));
}

function parse(out: string): Connector[] {
  const items: Connector[] = [];
  for (const raw of out.split(/\r?\n/)) {
    // e.g. "claude.ai Microsoft 365: https://… - √ Connected" or "plugin:x:y:  (HTTP) - - Not configured"
    const m = /^(.+?):\s+(.*?)\s+-\s+(\S)\s+(.+)$/.exec(raw.trim());
    if (!m) continue;
    const text = m[4];
    const status: Connector["status"] = /^connected/i.test(text)
      ? "connected"
      : /needs auth/i.test(text)
        ? "needs-auth"
        : /not configured/i.test(text)
          ? "not-configured"
          : /fail/i.test(text)
            ? "failed"
            : "unknown";
    items.push({ name: m[1].trim(), status, detail: text.trim() });
  }
  return items;
}

export function listConnectors(claudePath: string, refresh = false): Promise<Snapshot> {
  if (!refresh && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  inflight = new Promise<Snapshot>((resolve) => {
    execFile(claudePath, ["mcp", "list"], { env, windowsHide: true, timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const items = parse(String(stdout ?? ""));
      const snap: Snapshot = { at: Date.now(), items, error: items.length ? undefined : err ? String(err.message).slice(0, 200) : undefined };
      const waiting = new Set((cache?.items ?? []).filter((x) => x.status === "needs-auth").map((x) => x.name));
      const recovered = items.some((x) => x.status === "connected" && waiting.has(x.name));
      cache = snap;
      if (recovered) onRecovered?.();
      inflight = null;
      resolve(snap);
    });
  });
  return inflight;
}
