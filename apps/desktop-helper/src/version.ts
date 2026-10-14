// Which version of Roam Desk is running (the commit it was built from) and whether GitHub has a newer one.
// The commit is read once at start-up: "Update helper" pulls, rebuilds and restarts, so it always matches the code
// running. The check fetches from GitHub at most every few minutes and never prompts for a sign-in.
import { execFile, execFileSync } from "node:child_process";
import type { VersionInfo } from "@claude-anywhere/protocol";
import { REPO_ROOT } from "./paths.js";

const RECHECK_MS = 5 * 60_000;
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function running(): Pick<VersionInfo, "commit" | "date"> {
  try {
    const out = execFileSync("git", ["-C", REPO_ROOT, "log", "-1", "--format=%h|%cI"], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: gitEnv }).trim();
    const [commit, date] = out.split("|");
    return { commit: commit || null, date: date || null };
  } catch {
    return { commit: null, date: null };
  }
}

function git(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", timeout, windowsHide: true, env: gitEnv }, (e, out) => (e ? reject(e) : resolve(out))),
  );
}

let info: VersionInfo = { ...running(), behind: null, checkedAt: null };
let checking: Promise<VersionInfo> | null = null;

export const versionInfo = (): VersionInfo => info;

/** Asks GitHub whether there's a newer version, unless it was asked in the last few minutes. */
export function checkForUpdate(force = false): Promise<VersionInfo> {
  if (!force && info.checkedAt && Date.now() - info.checkedAt < RECHECK_MS) return Promise.resolve(info);
  checking ??= (async () => {
    try {
      await git(["fetch", "--quiet", "origin"]);
      const behind = Number((await git(["rev-list", "--count", "HEAD..@{u}"])).trim()) || 0;
      info = { ...info, behind, checkedAt: Date.now(), error: undefined };
    } catch {
      info = { ...info, checkedAt: Date.now(), error: "Couldn't check GitHub for updates." };
    } finally {
      checking = null;
    }
    return info;
  })();
  return checking;
}
