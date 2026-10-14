// File names in a session's folder, for @-mentions in the web client. Uses git's file list when the folder is a
// repository (fast, honours .gitignore), otherwise a bounded walk that skips build and dependency folders.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "bin", "obj", ".venv", "venv", "__pycache__", ".next", ".gradle", ".idea", ".vs", "target", "coverage", "AppData", ".cache"]);
const MAX_FILES = 20_000;
const WALK_BUDGET_MS = 1500;
const CACHE_MS = 30_000;

const cache = new Map<string, { at: number; files: string[] }>();

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    // fsmonitor off: a repository's own config must never get to run a program here.
    execFile("git", ["-c", "core.fsmonitor=false", "-C", cwd, "ls-files", "-co", "--exclude-standard"], { timeout: 4000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      resolve(out.split(/\r?\n/).filter(Boolean).slice(0, MAX_FILES));
    });
  });
}

function walk(cwd: string): string[] {
  const out: string[] = [];
  const started = Date.now();
  const queue: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
  while (queue.length && out.length < MAX_FILES && Date.now() - started < WALK_BUDGET_MS) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && depth < 8) queue.push({ dir: p, depth: depth + 1 });
      } else if (e.isFile()) out.push(relative(cwd, p).replace(/\\/g, "/"));
    }
  }
  return out;
}

async function listFiles(cwd: string) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = (await gitFiles(cwd)) ?? walk(cwd);
  cache.set(cwd, { at: Date.now(), files });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return files;
}

/** Best matches first: exact name, name starts with, name contains, path contains, letters in order. */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase().replace(/\\/g, "/");
  if (!q) return files.slice().sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length).slice(0, limit);
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let s = -1;
    if (name === q) s = 0;
    else if (name.startsWith(q)) s = 1;
    else if (name.includes(q)) s = 2;
    else if (lower.includes(q)) s = 3;
    else {
      let i = 0;
      for (const c of lower) if (c === q[i]) i++;
      if (i === q.length) s = 4;
    }
    if (s >= 0) scored.push({ f, s });
  }
  return scored.sort((a, b) => a.s - b.s || a.f.length - b.f.length).slice(0, limit).map((x) => x.f);
}

export async function searchFiles(cwd: string, query: string, limit = 50) {
  return rankFiles(await listFiles(cwd), query, limit);
}
