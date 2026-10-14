// Claude Code's "needs authentication" cache (~/.claude/mcp-needs-auth-cache.json).
// After a single 401 from a claude.ai connector, Claude Code records it there and every later session skips that
// connector without trying, even once the login works again (Claude Desktop is fine, `claude mcp list` still says
// "Connected" because it doesn't test the login). That is what left Microsoft 365 unusable on a phone session.
// The helper clears a stale entry for the connectors it cares about, and checks with a real start whether it comes back.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./paths.js";

const BACKUPS = join(DATA_DIR, "mcp-cache-backups");
const KEEP_BACKUPS = 10;

export const cacheFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "mcp-needs-auth-cache.json");

/** The cache text without the entries whose names match. Anything unreadable is left exactly as it is. */
export function dropFlags(raw: string, re: RegExp): { text: string; removed: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { text: raw, removed: [] };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { text: raw, removed: [] };
  const map = obj as Record<string, unknown>;
  const removed = Object.keys(map).filter((k) => re.test(k));
  for (const k of removed) delete map[k];
  return { text: JSON.stringify(map), removed };
}

/** Names in the cache that match (the connectors Claude Code is currently skipping). */
export function flaggedNames(re: RegExp, path = cacheFile()): string[] {
  try {
    if (!existsSync(path)) return [];
    return dropFlags(readFileSync(path, "utf8"), re).removed;
  } catch {
    return [];
  }
}

/** Removes matching entries (after backing the file up). Returns the names removed. */
export function clearFlags(re: RegExp, path = cacheFile(), backupDir = BACKUPS): string[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const { text, removed } = dropFlags(raw, re);
  if (!removed.length) return [];
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(path, join(backupDir, `mcp-needs-auth-cache.${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  const old = readdirSync(backupDir).filter((f) => f.startsWith("mcp-needs-auth-cache.")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) rmSync(join(backupDir, f), { force: true });
  const tmp = `${path}.helper-tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    writeFileSync(path, text); // the file was busy; write it in place instead
  }
  return removed;
}

/**
 * A fresh Claude start, which tries each connector for real. If a login is genuinely bad the connector is flagged again,
 * so the caller looks at the cache afterwards. Costs one tiny request, so it's only run after a flag was cleared.
 */
export function runProbe(claudePath: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    execFile(claudePath, ["-p", "Reply with the single word OK.", "--max-turns", "1", "--output-format", "text", "--no-chrome"], { env, windowsHide: true, timeout: 120_000, maxBuffer: 1 << 20 }, () => resolve());
  });
}
