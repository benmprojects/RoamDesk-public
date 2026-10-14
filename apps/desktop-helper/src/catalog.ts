// Catalogue of existing Claude Code sessions on this PC (desktop app, terminal and phone), so the phone can continue them.
// Reads ~/.claude/projects/<project>/<sessionId>.jsonl — head for cwd/first prompt, tail for title/last activity.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { desktopSessionInfo } from "./desktop.js";

export interface CatalogItem {
  claudeSessionId: string;
  title: string;
  project: string; // folder name, e.g. "Roam Desk"
  cwd: string;
  origin: "desktop" | "terminal" | "phone" | "other";
  lastActiveAt: number; // epoch ms
  /** Modified in the last few minutes — probably still open somewhere. */
  activeRecently: boolean;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const RECENT_MS = 3 * 60 * 1000;
const CHUNK = 256 * 1024;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue; // partial line at a chunk edge
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial line */
    }
  }
  return out;
}

function promptText(rec: any): string {
  const c = rec?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.find((b: any) => b?.type === "text" && typeof b.text === "string");
    return t?.text ?? "";
  }
  return "";
}

function cleanTitle(s: string): string {
  return s
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ") // strip injected tags like <system-reminder>…</system-reminder>
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * What the desktop app shows for a session wins over what the transcript suggests: its title (including ones you
 * renamed), its own "last activity" time, and that it's a desktop chat. Archived chats are hidden, as in the app.
 */
function withDesktopInfo(item: CatalogItem, d = desktopSessionInfo().get(item.claudeSessionId)): CatalogItem | null {
  if (!d) return item;
  if (d.archived) return null;
  return {
    ...item,
    title: d.title ? cleanTitle(d.title) : item.title,
    lastActiveAt: Math.max(item.lastActiveAt, Math.floor(d.lastActivityAt)),
    origin: item.origin === "phone" ? "phone" : "desktop",
  };
}

// Reading the start and end of every transcript is the slow part: remember it until the file changes.
const metaCache = new Map<string, { key: string; item: CatalogItem | null }>();

function readSessionMetaCached(file: string, phoneSessionIds: Set<string>): CatalogItem | null {
  const st = statSync(file);
  const key = `${st.mtimeMs}|${st.size}|${[...phoneSessionIds].sort().join(",")}`;
  const hit = metaCache.get(file);
  if (hit && hit.key === key) return hit.item ? { ...hit.item, activeRecently: Date.now() - st.mtimeMs < RECENT_MS } : null;
  const item = readSessionMeta(file, phoneSessionIds);
  metaCache.set(file, { key, item });
  return item;
}

export function readSessionMeta(file: string, phoneSessionIds: Set<string>): CatalogItem | null {
  const st = statSync(file);
  const size = st.size;
  const head = parseLines(readSlice(file, 0, Math.min(size, CHUNK)));
  const tail = size > CHUNK ? parseLines(readSlice(file, Math.max(0, size - CHUNK), CHUNK)) : head;
  const all = [...head, ...tail];

  const cwd = all.find((r) => typeof r.cwd === "string")?.cwd;
  if (!cwd) return null;
  const id = basename(file, ".jsonl");

  let title = "";
  for (const r of [...tail].reverse()) {
    if (r.type === "custom-title" && r.customTitle) { title = r.customTitle; break; }
    if (r.type === "ai-title" && (r.aiTitle || r.title)) { title = r.aiTitle ?? r.title; break; }
    if (r.type === "summary" && r.summary) { title = r.summary; break; }
  }
  if (!title) {
    const firstPrompt = head.find((r) => r.type === "user" && !r.isSidechain && !r.toolUseResult && cleanTitle(promptText(r)));
    title = firstPrompt ? cleanTitle(promptText(firstPrompt)) : "";
  }
  if (!title) {
    const lp = [...tail].reverse().find((r) => r.type === "last-prompt" && r.lastPrompt);
    title = lp ? cleanTitle(lp.lastPrompt) : "Untitled session";
  }

  const entry = all.find((r) => typeof r.entrypoint === "string")?.entrypoint ?? "";
  const origin: CatalogItem["origin"] = phoneSessionIds.has(id)
    ? "phone"
    : entry === "claude-desktop"
      ? "desktop"
      : entry === "cli"
        ? "terminal"
        : "other";

  return {
    claudeSessionId: id,
    title: cleanTitle(title),
    project: basename(cwd) || cwd,
    cwd,
    origin,
    lastActiveAt: Math.floor(st.mtimeMs), // integer: NTFS mtimes have sub-millisecond fractions

    activeRecently: Date.now() - st.mtimeMs < RECENT_MS,
  };
}

/**
 * Every session, newest first by the same "last activity" the desktop app sorts by. Skips throwaway folders (temp,
 * spike workdirs), folders that no longer exist, and chats archived in the desktop app.
 */
export function listCatalog(phoneSessionIds: Set<string>, limit = 300): CatalogItem[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const desktop = desktopSessionInfo();
  const files: { file: string; at: number }[] = [];
  for (const proj of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, proj.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile() && SESSION_FILE.test(f.name)) {
        const p = join(dir, f.name);
        files.push({ file: p, at: Math.max(statSync(p).mtimeMs, desktop.get(basename(f.name, ".jsonl"))?.lastActivityAt ?? 0) });
      }
    }
  }
  files.sort((a, b) => b.at - a.at);
  const tmp = tmpdir().toLowerCase();
  const out: CatalogItem[] = [];
  for (const { file } of files) {
    if (out.length >= limit) break;
    try {
      const base = readSessionMetaCached(file, phoneSessionIds);
      const item = base && withDesktopInfo(base, desktop.get(base.claudeSessionId));
      if (!item) continue;
      const cwd = item.cwd.toLowerCase();
      if (cwd.startsWith(tmp) || /[\\/]spike[\\/]workdir/.test(cwd) || !existsSync(item.cwd)) continue;
      out.push(item);
    } catch {
      /* unreadable file — skip */
    }
  }
  return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function sessionFile(claudeSessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId) || !existsSync(PROJECTS_DIR)) return null;
  for (const proj of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const p = join(PROJECTS_DIR, proj.name, `${claudeSessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function findSession(claudeSessionId: string, phoneSessionIds: Set<string>): CatalogItem | null {
  const p = sessionFile(claudeSessionId);
  const item = p ? readSessionMeta(p, phoneSessionIds) : null;
  if (!item) return null;
  // Archived chats are only left out of the list: they can still be continued by id.
  const d = desktopSessionInfo().get(item.claudeSessionId);
  return d ? withDesktopInfo(item, { ...d, archived: false }) : item;
}
