// Routines: a saved prompt that runs on a schedule and leaves its answer in the inbox.
// They run unattended, so they are read-only by construction: the run is only allowed to look things up (files,
// the web, and the Microsoft 365 search/read tools). It can't edit, send, run commands or touch the screen or browser.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Routine, RoutineSchedule } from "@claude-anywhere/protocol";
import { audit } from "./audit.js";
import { CONFIG_DIR } from "./paths.js";

const FILE = join(CONFIG_DIR, "routines.json");
export const MAX_ROUTINES = 20;
const RUN_TIMEOUT_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000; // a run missed by more than this (PC was off) is skipped, not run late

const M365 = "mcp__claude_ai_Microsoft_365__";
export const READ_ONLY_TOOLS = [
  "Read", "Glob", "Grep", "WebSearch", "WebFetch",
  ...["chat_message_search", "find_meeting_availability", "outlook_calendar_search", "outlook_email_search", "read_resource", "sharepoint_folder_search", "sharepoint_search"].map((t) => M365 + t),
];

const RULES = "You are running unattended on a schedule, so nobody can answer questions. You can only look things up; you cannot change, send or run anything, so don't try. Reply with the result only, in plain Australian English, under 150 words. If you couldn't get something, say what.";

/** The next time this schedule fires after `from` (the PC's local clock), or null if it never will again. */
export function nextRun(s: RoutineSchedule, from: Date): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.time);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min, 0, 0);
  if (s.kind === "once") {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date ?? "");
    if (!d) return null;
    const t = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, min, 0, 0).getTime();
    return t > from.getTime() ? t : null;
  }
  for (let i = 0; i < 8; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const t = at(day).getTime();
    if (t <= from.getTime()) continue;
    const dow = day.getDay();
    if (s.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (s.kind === "weekly" && dow !== s.day) continue;
    return t;
  }
  return null;
}

export function validSchedule(s: any): s is RoutineSchedule {
  if (!s || typeof s !== "object" || !["daily", "weekdays", "weekly", "once"].includes(s.kind)) return false;
  if (typeof s.time !== "string" || nextRun({ kind: "daily", time: s.time }, new Date(0)) === null) return false;
  if (s.kind === "weekly" && !(Number.isInteger(s.day) && s.day >= 0 && s.day <= 6)) return false;
  if (s.kind === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date ?? ""))) return false;
  return true;
}

let routines: Routine[] = [];
try {
  if (existsSync(FILE)) routines = (JSON.parse(readFileSync(FILE, "utf8")) as Routine[]).map((r) => ({ ...r, lastStatus: r.lastStatus === "running" ? undefined : r.lastStatus }));
} catch {
  routines = [];
}

function save() {
  try {
    writeFileSync(FILE, JSON.stringify(routines, null, 1));
  } catch {
    /* keep going in memory */
  }
}

export const routineList = (): Routine[] => routines;

export function saveRoutine(input: { id?: string; name: string; prompt: string; schedule: RoutineSchedule; enabled: boolean }): { ok: true; routine: Routine } | { ok: false; reason: string } {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 2000);
  if (!name || !prompt) return { ok: false, reason: "A routine needs a name and something to do." };
  if (!validSchedule(input.schedule)) return { ok: false, reason: "That schedule isn't valid." };
  const next = input.enabled ? nextRun(input.schedule, new Date()) : null;
  if (input.enabled && next === null) return { ok: false, reason: "That time has already passed." };
  const existing = input.id ? routines.find((r) => r.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, reason: "No such routine." };
  if (!existing && routines.length >= MAX_ROUTINES) return { ok: false, reason: `That's the limit of ${MAX_ROUTINES} routines.` };
  const routine: Routine = { ...(existing ?? { id: `r_${randomBytes(5).toString("base64url")}` }), name, prompt, schedule: input.schedule, enabled: Boolean(input.enabled), nextRunAt: next };
  if (existing) routines[routines.indexOf(existing)] = routine;
  else routines.push(routine);
  save();
  return { ok: true, routine };
}

export function deleteRoutine(id: string): boolean {
  const n = routines.length;
  routines = routines.filter((r) => r.id !== id);
  if (routines.length !== n) save();
  return routines.length !== n;
}

/** Runs one routine now. Resolves with its answer. */
export function runRoutine(claudePath: string, r: Routine): Promise<{ ok: boolean; text: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    execFile(
      claudePath,
      ["-p", r.prompt, "--allowedTools", READ_ONLY_TOOLS.join(","), "--max-turns", "30", "--output-format", "text", "--no-chrome", "--append-system-prompt", RULES],
      { env, windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 2 << 20 },
      (err, stdout) => {
        const text = String(stdout ?? "").trim();
        if (err && !text) return resolve({ ok: false, text: `It didn't finish (${String(err.message).split("\n")[0].slice(0, 120)}).` });
        resolve({ ok: !err, text: text || "No answer." });
      },
    );
  });
}

const running = new Set<string>();

/**
 * Called every half minute: runs what's due. `done` gets each routine's outcome so the server can put it in the inbox.
 */
export function tickRoutines(claudePath: string, onChange: () => void, done: (r: Routine, ok: boolean, text: string) => void, now = Date.now()) {
  for (const r of routines) {
    if (!r.enabled || r.nextRunAt == null || r.nextRunAt > now || running.has(r.id)) continue;
    const stale = now - r.nextRunAt > STALE_MS;
    // Schedule the following run first, so a slow or failed run can't make it fire again.
    r.nextRunAt = nextRun(r.schedule, new Date(now));
    if (r.nextRunAt === null) r.enabled = false;
    if (stale) {
      audit({ event: "routine.skipped", reason: `${r.name}: the PC was off or asleep at the time` });
      save();
      onChange();
      continue;
    }
    start(claudePath, r, onChange, done);
  }
}

export function runNow(claudePath: string, id: string, onChange: () => void, done: (r: Routine, ok: boolean, text: string) => void): boolean {
  const r = routines.find((x) => x.id === id);
  if (!r || running.has(r.id)) return false;
  start(claudePath, r, onChange, done);
  return true;
}

function start(claudePath: string, r: Routine, onChange: () => void, done: (r: Routine, ok: boolean, text: string) => void) {
  running.add(r.id);
  r.lastStatus = "running";
  r.lastRunAt = Date.now();
  save();
  onChange();
  audit({ event: "routine.run", approver: "auto", decision: "started", reason: r.name });
  void runRoutine(claudePath, r).then((res) => {
    running.delete(r.id);
    r.lastStatus = res.ok ? "ok" : "failed";
    save();
    audit({ event: "routine.run", approver: "auto", decision: r.lastStatus, reason: `${r.name}: ${res.text.slice(0, 200)}` });
    done(r, res.ok, res.text);
    onChange();
  });
}
