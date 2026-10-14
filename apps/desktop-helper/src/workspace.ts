// Workspace panes for the web client: what changed in a session's folder (git), and reading a file from it.
// Read-only. Git runs with external diff tools, text converters and the file-system monitor switched off, so a
// repository's own configuration can't start programs when you look at it.
import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspaceChanges, WorkspaceFile } from "@claude-anywhere/protocol";
import { isSensitivePath } from "./policy.js";
import { sniffImage } from "./uploads.js";

const MAX_FILES = 300;
const MAX_DIFF_PER_FILE = 200_000;
const MAX_DIFF_TOTAL = 2_000_000;
const MAX_TEXT = 1_000_000;
const MAX_IMAGE = 5_000_000;
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.quotepath=false"];

function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", [...SAFE_GIT, "-C", cwd, ...args], { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, out) => (err ? rej(err) : res(out)));
  });
}

const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Split a combined `git diff` into each file's part, keyed by its path (the "b/" side). */
export function splitDiff(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  for (const part of parts) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const path = plus && plus !== "/dev/null" ? plus : header?.[2] ?? header?.[1];
    if (path) out.set(path.trim(), part);
  }
  return out;
}

/** Added and removed line counts of one file's diff. */
export function countLines(diff: string) {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** `git status --porcelain=v1 -z` entries: two status letters, a path, and the original path for renames. */
export function parseStatus(z: string): { status: string; path: string; from?: string }[] {
  const out: { status: string; path: string; from?: string }[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const path = p.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      out.push({ status: "R", path, from: parts[++i] });
      continue;
    }
    const s = xy === "??" ? "?" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
    out.push({ status: s, path });
  }
  return out;
}

function readText(file: string, max: number): { text: string; truncated: boolean; binary: boolean } {
  const size = statSync(file).size;
  const n = Math.min(size, max);
  const buf = Buffer.alloc(n);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, n, 0);
  } finally {
    closeSync(fd);
  }
  const binary = buf.subarray(0, Math.min(n, 8000)).includes(0);
  return { text: binary ? "" : buf.toString("utf8"), truncated: size > max, binary };
}

export async function workspaceChanges(cwd: string): Promise<WorkspaceChanges> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim().replace(/\//g, "\\");
  } catch {
    return { git: false, root: null, branch: null, files: [] };
  }
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null;
  const status = parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "-uall"])).slice(0, MAX_FILES);
  // Against the last commit (staged and unstaged together); a brand-new repository has none.
  const hasHead = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  const diffs = hasHead ? splitDiff(await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "HEAD", "--"]).catch(() => "")) : new Map<string, string>();
  let total = 0;
  const files = status.map((s) => {
    let diff = diffs.get(s.path) ?? "";
    if (!diff && (s.status === "?" || !hasHead)) {
      try {
        const abs = join(root, s.path);
        const t = isSensitivePath(abs) ? { text: "", truncated: false, binary: true } : readText(abs, MAX_DIFF_PER_FILE);
        // The file's last line break isn't another line.
        const lines = t.text.replace(/\r?\n$/, "");
        diff = t.binary || !t.text ? "" : `@@ new file @@\n${lines.split(/\r?\n/).map((l) => `+${l}`).join("\n")}`;
      } catch {
        diff = "";
      }
    }
    const { added, removed } = countLines(diff);
    let truncated = false;
    if (diff.length > MAX_DIFF_PER_FILE || total + diff.length > MAX_DIFF_TOTAL) {
      diff = total < MAX_DIFF_TOTAL ? diff.slice(0, Math.min(MAX_DIFF_PER_FILE, MAX_DIFF_TOTAL - total)) : "";
      truncated = true;
    }
    total += diff.length;
    return { path: s.path.replace(/\//g, "\\"), from: s.from?.replace(/\//g, "\\"), status: s.status, added, removed, diff, truncated };
  });
  return { git: true, root, branch, files, more: status.length >= MAX_FILES };
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** A file from the session's folder (or its repository) for preview. Credentials and the helper's files are refused. */
export async function readWorkspaceFile(cwd: string, path: string): Promise<WorkspaceFile> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).then((r) => r.trim().replace(/\//g, "\\"), () => cwd);
  const abs = resolve(isAbsolute(path) ? path : resolve(cwd, path));
  const base: WorkspaceFile = { path: abs, kind: "error", size: 0 };
  if (!within(abs, cwd) && !within(abs, root)) return { ...base, error: "Only files in this session's folder can be opened here." };
  if (isSensitivePath(abs)) return { ...base, error: "That file holds credentials or keys, so it isn't shown." };
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ...base, error: "That isn't a file." };
    size = st.size;
  } catch {
    return { ...base, error: "That file doesn't exist (any more)." };
  }
  if (IMAGE_EXT.has(extname(abs).toLowerCase())) {
    if (size > MAX_IMAGE) return { ...base, size, kind: "binary", error: "That picture is too big to preview." };
    const buf = readAll(abs, size);
    const mime = sniffImage(buf.subarray(0, 16)); // by its bytes, not its name
    if (mime) return { path: abs, kind: "image", size, mime, data: buf.toString("base64") };
  }
  const t = readText(abs, MAX_TEXT);
  if (t.binary) return { path: abs, kind: "binary", size };
  return { path: abs, kind: "text", size, text: t.text, truncated: t.truncated };
}

function readAll(file: string, size: number) {
  const buf = Buffer.alloc(size);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}
