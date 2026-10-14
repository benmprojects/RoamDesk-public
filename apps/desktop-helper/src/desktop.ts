// Hand-off with the Claude desktop app: it keeps each open session in its own claude.exe process with the
// conversation in memory, so it never shows turns the phone added. Ending that process makes desktop reload the
// session from disk the next time it is opened.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_SESSIONS = join(process.env.APPDATA ?? "", "Claude", "claude-code-sessions");
// Fields copied from the user's latest desktop session so a registered session opens with the same setup.
const INHERIT = ["model", "effort", "permissionMode", "enabledMcpTools", "remoteMcpServersConfig", "chromePermissionMode"] as const;

function desktopRecords(): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^local_[0-9a-f-]{36}\.json$/i.test(e.name)) out.push({ file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(DESKTOP_SESSIONS, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export interface DesktopSessionInfo {
  title: string;
  /** The desktop app's own "last activity" (epoch ms), which is what it sorts its list by. */
  lastActivityAt: number;
  archived: boolean;
}

let infoCache: { at: number; map: Map<string, DesktopSessionInfo> } = { at: 0, map: new Map() };

/** What the desktop app knows about each Claude Code session (title, last activity, archived), by session id. */
export function desktopSessionInfo(): Map<string, DesktopSessionInfo> {
  if (Date.now() - infoCache.at < 5000) return infoCache.map;
  const map = new Map<string, DesktopSessionInfo>();
  for (const r of desktopRecords()) {
    try {
      const j = JSON.parse(readFileSync(r.file, "utf8"));
      if (typeof j.cliSessionId !== "string") continue;
      const last = Number(j.lastActivityAt) || r.mtime;
      const prev = map.get(j.cliSessionId);
      if (prev && prev.lastActivityAt >= last) continue; // several records for one session: the newest wins
      map.set(j.cliSessionId, { title: typeof j.title === "string" ? j.title.trim() : "", lastActivityAt: last, archived: j.isArchived === true });
    } catch {
      /* unreadable record: ignore */
    }
  }
  infoCache = { at: Date.now(), map };
  return map;
}

/**
 * Make a Claude Code session show up in the desktop app's Code tab. The desktop app only lists sessions it has its
 * own record for, so sessions started on the phone need one. Returns "exists", "registered" or "unavailable".
 */
export function registerWithDesktop(s: { claudeSessionId: string; cwd: string; title: string; lastActiveAt: number }): "exists" | "registered" | "unavailable" {
  if (!UUID.test(s.claudeSessionId)) return "unavailable";
  const records = desktopRecords();
  if (!records.length) return "unavailable"; // desktop app never used here, so we can't learn its folder or format
  for (const r of records) {
    try {
      if (JSON.parse(readFileSync(r.file, "utf8")).cliSessionId === s.claudeSessionId) return "exists";
    } catch {
      /* unreadable record: ignore */
    }
  }
  let template: Record<string, unknown> = {};
  try {
    template = JSON.parse(readFileSync(records[0].file, "utf8"));
  } catch {
    /* fall back to defaults */
  }
  const id = `local_${randomUUID()}`;
  const now = Date.now();
  const rec: Record<string, unknown> = {
    sessionId: id,
    cliSessionId: s.claudeSessionId,
    cwd: s.cwd,
    originCwd: s.cwd,
    lastFocusedAt: now,
    createdAt: s.lastActiveAt || now,
    lastActivityAt: Math.max(s.lastActiveAt || 0, now),
    model: "claude-opus-5-5",
    effort: "medium",
    isArchived: false,
    title: s.title || "Session from phone",
    titleSource: "auto",
    permissionMode: "default",
  };
  for (const k of INHERIT) if (template[k] !== undefined) rec[k] = template[k];
  const dir = join(records[0].file, "..");
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec));
  return "registered";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(cmd: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, encoding: "utf8" }, (_e, out) => resolve(out ?? ""));
  });
}

/** PIDs of desktop-app processes that have this Claude Code session open (never the helper's own CLI). */
export async function desktopProcesses(claudeSessionId: string): Promise<number[]> {
  if (!UUID.test(claudeSessionId)) return [];
  const script =
    `$d = Join-Path $env:APPDATA 'Claude\\claude-code\\';` +
    `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ` +
    `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, 'OrdinalIgnoreCase') -and $_.CommandLine -like '*${claudeSessionId}*' } | ` +
    `ForEach-Object { $_.ProcessId }`;
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** End the desktop app's process for this session. Returns how many were ended. */
export async function releaseFromDesktop(claudeSessionId: string): Promise<number> {
  const pids = await desktopProcesses(claudeSessionId);
  for (const pid of pids) await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  return pids.length;
}
