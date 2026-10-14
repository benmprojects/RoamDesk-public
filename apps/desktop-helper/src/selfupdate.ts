// Rebuild-and-restart of the helper itself, started from the phone or the dashboard so nobody has to type a command.
// Runs scripts/install.ps1 -Quiet fully detached (it ends this process and starts the new build).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./paths.js";

const SCRIPT = join(APP_ROOT, "scripts", "install.ps1");
const DIR = join(process.env.LOCALAPPDATA ?? "", "ClaudeAnywhere");
const PENDING = join(DIR, "update-pending.json");
const RESULT = join(DIR, "update-result.json");

let running = false;

// If an update was pending when this process started, this process IS the update: a failed build never restarts us.
let justUpdated = false;
try {
  if (existsSync(PENDING)) {
    justUpdated = Date.now() - statSync(PENDING).mtimeMs < 15 * 60_000;
    rmSync(PENDING, { force: true });
  }
} catch {
  /* ignore */
}

/** One-shot "updated" notice for the first phone that connects after an update. */
export function takeUpdatedNotice(): boolean {
  const was = justUpdated;
  justUpdated = false;
  return was;
}

export function startHelperUpdate(by: string, onFailed: (message: string) => void): { ok: boolean; message: string } {
  if (running) return { ok: false, message: "An update is already running." };
  if (!existsSync(SCRIPT)) return { ok: false, message: "The install script is missing." };
  running = true;
  const startedAt = Date.now();
  writeFileSync(PENDING, JSON.stringify({ at: startedAt, by }));
  // `start` gives PowerShell its own process tree, so ending this helper (which the script does) doesn't end the update.
  spawn("cmd.exe", ["/d", "/c", `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT}" -Quiet`], {
    windowsVerbatimArguments: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();

  // A failed build leaves this helper running: watch for the script's result and pass on the reason.
  const timer = setInterval(() => {
    try {
      if (!existsSync(RESULT) || statSync(RESULT).mtimeMs < startedAt) {
        if (Date.now() - startedAt > 6 * 60_000) {
          clearInterval(timer);
          running = false;
        }
        return;
      }
      clearInterval(timer);
      running = false;
      const r = JSON.parse(readFileSync(RESULT, "utf8").replace(/^﻿/, ""));
      if (!r.ok) {
        rmSync(PENDING, { force: true });
        onFailed(String(r.message ?? "The update failed."));
      }
    } catch {
      /* try again next tick */
    }
  }, 5000);
  timer.unref();
  return { ok: true, message: "Updating the PC helper. It will restart in about a minute." };
}
