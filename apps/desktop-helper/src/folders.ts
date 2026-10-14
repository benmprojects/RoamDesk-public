// Folder browsing for "New session" in the web client: local drives and folder names only (never file names or
// contents), so the user can pick where a session works without typing a path.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

const MAX_FOLDERS = 1000;
// System folders nobody starts a Claude session in; hidden from the list (still reachable by typing a path).
const NOISE = /^(\$recycle\.bin|system volume information|recovery|config\.msi|msocache|\$windows\.~bt|\$windows\.~ws|\$sysreset|documents and settings)$/i;

export interface FolderListing {
  path: string | null; // null: the top level (drives and shortcuts)
  parent: string | null;
  folders: string[]; // names, not paths
  shortcuts: { name: string; path: string }[];
  /** Top level: what each drive is, e.g. "DataNew · network: \\server\Accounts". */
  labels?: Record<string, string>;
  error?: string;
}

/** A local drive folder (C:\...), never a network share or device path. */
export function isLocalPath(p: string) {
  return /^[a-z]:[\\/]/i.test(p) && !/[\\/]{2}/.test(p.slice(2)) && !/^\\\\/.test(p);
}

/**
 * Whether a directory entry is a folder worth listing. Node reports every Windows reparse point as a link, and that
 * includes OneDrive's online-only folders (cloud placeholders), so those are checked properly: a placeholder has no
 * link target, while junctions and symlinks only count if they can actually be opened (which drops Windows' old
 * "My Documents"-style junctions).
 */
function isFolder(parent: string, d: Dirent): boolean {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  const full = join(parent, d.name);
  try {
    if (!statSync(full).isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    readlinkSync(full);
  } catch {
    return true; // a cloud placeholder (OneDrive files on demand), not a link
  }
  try {
    readdirSync(full);
    return true;
  } catch {
    return false;
  }
}

function drives(): string[] {
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    try {
      if (existsSync(d)) out.push(d);
    } catch {
      /* not ready (empty card reader) */
    }
  }
  return out;
}

// What kind each drive is (a mapped network share looks like any other letter). Asked once, kept 5 minutes.
let driveInfo: { at: number; labels: Record<string, string> } = { at: 0, labels: {} };
function driveLabels(): Record<string, string> {
  if (Date.now() - driveInfo.at < 300_000) return driveInfo.labels;
  const labels: Record<string, string> = {};
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_LogicalDisk | ForEach-Object { \"$($_.DeviceID)|$($_.DriveType)|$($_.ProviderName)|$($_.VolumeName)\" }"],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    for (const line of out.split(/\r?\n/)) {
      const [id, type, provider, volume] = line.split("|");
      if (!/^[A-Z]:$/i.test(id ?? "")) continue;
      const kind = type === "4" ? `network: ${provider || "share"}` : type === "2" ? "removable" : type === "5" ? "CD/DVD" : "";
      labels[`${id.toUpperCase()}\\`] = [volume, kind].filter(Boolean).join(" · ");
    }
  } catch {
    /* labels are a nicety */
  }
  driveInfo = { at: Date.now(), labels };
  return labels;
}

// This PC's cloud-synced folders: OneDrive (personal and work) and the SharePoint libraries a work OneDrive syncs,
// which land in a home folder named after the organisation ("OneDrive - Example Ltd" → "Example Ltd"). Kept 5 minutes.
let syncCache: { at: number; roots: string[] } = { at: 0, roots: [] };
export function syncRoots(home = homedir()): string[] {
  if (home === homedir() && Date.now() - syncCache.at < 300_000) return syncCache.roots;
  const roots: string[] = [];
  try {
    for (const d of readdirSync(home, { withFileTypes: true })) {
      const m = /^OneDrive(?: - (.+?))?(?: \(\d+\))?$/i.exec(d.name);
      if (!m || !isFolder(home, d)) continue;
      roots.push(join(home, d.name));
      const org = m[1] ? join(home, m[1]) : null;
      if (org && existsSync(org) && statSync(org).isDirectory() && !roots.includes(org)) roots.push(org);
    }
  } catch {
    /* none */
  }
  if (home === homedir()) syncCache = { at: Date.now(), roots };
  return roots;
}

function shortcuts(recent: string[]): { name: string; path: string }[] {
  const home = homedir();
  const candidates: { name: string; path: string }[] = [
    { name: "Home", path: home },
    { name: "Desktop", path: join(home, "Desktop") },
    { name: "Documents", path: join(home, "Documents") },
    { name: "Downloads", path: join(home, "Downloads") },
  ];
  // OneDrive folders (personal and work) and synced SharePoint libraries sit in the home folder.
  for (const p of syncRoots(home)) candidates.push({ name: parse(p).base, path: p });
  for (const p of recent) candidates.push({ name: `Recent: ${parse(p).base || p}`, path: p });
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.path.toLowerCase();
    if (seen.has(key) || !isLocalPath(c.path) || !existsSync(c.path)) return false;
    seen.add(key);
    return true;
  });
}

/** The folders inside `path`, or drives and shortcuts when no path is given. */
export function listFolders(path: string | undefined, recent: string[] = []): FolderListing {
  if (!path) return { path: null, parent: null, folders: drives(), shortcuts: shortcuts(recent), labels: driveLabels() };
  const p = resolve(path);
  const parentOf = (x: string) => (parse(x).root === x ? null : dirname(x));
  if (!isLocalPath(p)) return { path: p, parent: null, folders: [], shortcuts: [], error: "Only folders on this PC's own drives can be used." };
  let entries;
  try {
    if (!statSync(p).isDirectory()) throw new Error("not a folder");
    entries = readdirSync(p, { withFileTypes: true });
  } catch (e: any) {
    const why = e?.code === "EPERM" || e?.code === "EACCES" ? "Windows doesn't allow access to that folder." : e?.code === "ENOENT" ? "That folder doesn't exist." : "That folder can't be opened.";
    return { path: p, parent: parentOf(p), folders: [], shortcuts: [], error: why };
  }
  const folders = entries
    .filter((d) => !NOISE.test(d.name) && isFolder(p, d))
    .map((d) => d.name)
    .sort((a, b) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b, "en-AU", { sensitivity: "base", numeric: true }))
    .slice(0, MAX_FOLDERS);
  return { path: p, parent: parentOf(p), folders, shortcuts: [] };
}
