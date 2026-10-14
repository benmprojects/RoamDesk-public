import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-routines-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");
mkdirSync(process.env.CA_DATA_DIR, { recursive: true });

const { nextRun, validSchedule, saveRoutine, deleteRoutine, routineList, READ_ONLY_TOOLS, MAX_ROUTINES } = await import("../src/routines.js");
const { notifyInbox, inboxView, markInboxRead, clearInbox } = await import("../src/inbox.js");
const { evaluate } = await import("../src/doctor.js");

// Wednesday 14/10/2026, 10:00 local
const wed10 = new Date(2026, 9, 14, 10, 0, 0);
const at = (n: number | null) => (n === null ? null : new Date(n));

test("daily and weekday schedules pick the next time on the PC's clock", () => {
  assert.deepEqual(at(nextRun({ kind: "daily", time: "07:00" }, wed10)), new Date(2026, 9, 15, 7, 0));
  assert.deepEqual(at(nextRun({ kind: "daily", time: "16:30" }, wed10)), new Date(2026, 9, 14, 16, 30));
  const fri17 = new Date(2026, 9, 16, 17, 0);
  assert.deepEqual(at(nextRun({ kind: "weekdays", time: "07:00" }, fri17)), new Date(2026, 9, 19, 7, 0)); // skips the weekend
});

test("weekly and one-off schedules", () => {
  assert.deepEqual(at(nextRun({ kind: "weekly", day: 1, time: "07:00" }, wed10)), new Date(2026, 9, 19, 7, 0)); // next Monday
  assert.deepEqual(at(nextRun({ kind: "once", date: "2026-10-20", time: "09:15" }, wed10)), new Date(2026, 9, 20, 9, 15));
  assert.equal(nextRun({ kind: "once", date: "2026-10-01", time: "09:15" }, wed10), null); // already gone
  assert.equal(nextRun({ kind: "daily", time: "25:00" }, wed10), null);
});

test("schedules are validated", () => {
  assert.equal(validSchedule({ kind: "daily", time: "07:00" }), true);
  assert.equal(validSchedule({ kind: "weekly", time: "07:00" }), false); // needs a day
  assert.equal(validSchedule({ kind: "weekly", time: "07:00", day: 9 }), false);
  assert.equal(validSchedule({ kind: "once", time: "07:00" }), false); // needs a date
  assert.equal(validSchedule({ kind: "hourly", time: "07:00" }), false);
  assert.equal(validSchedule("nope"), false);
});

test("routines are saved, limited, changed and deleted", () => {
  const a = saveRoutine({ name: "Overdue tenders", prompt: "List tenders closing this week", schedule: { kind: "weekdays", time: "07:00" }, enabled: true });
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.ok(a.routine.nextRunAt);
  assert.equal(saveRoutine({ name: "", prompt: "x", schedule: { kind: "daily", time: "07:00" }, enabled: true }).ok, false);
  assert.equal(saveRoutine({ name: "Bad", prompt: "x", schedule: { kind: "once", date: "2020-01-01", time: "07:00" }, enabled: true }).ok, false);
  const b = saveRoutine({ id: a.routine.id, name: "Renamed", prompt: "p", schedule: { kind: "daily", time: "08:00" }, enabled: false });
  assert.ok(b.ok && b.routine.nextRunAt === null && routineList().length === 1);
  for (let i = routineList().length; i < MAX_ROUTINES; i++) assert.ok(saveRoutine({ name: `r${i}`, prompt: "p", schedule: { kind: "daily", time: "08:00" }, enabled: false }).ok);
  assert.equal(saveRoutine({ name: "one too many", prompt: "p", schedule: { kind: "daily", time: "08:00" }, enabled: false }).ok, false);
  assert.equal(deleteRoutine(a.routine.id), true);
  assert.equal(deleteRoutine("nope"), false);
});

test("a routine run can only look things up: no editing, sending, commands, browser or screen", () => {
  for (const t of READ_ONLY_TOOLS) {
    assert.doesNotMatch(t, /^(Write|Edit|Bash|PowerShell|NotebookEdit)$/, t);
    assert.doesNotMatch(t, /send|create|delete|update|reply|draft|chrome|desktop/i, t);
  }
  assert.ok(READ_ONLY_TOOLS.includes("Read") && READ_ONLY_TOOLS.some((t) => t.endsWith("outlook_email_search")));
});

test("inbox keeps the newest 50, counts unread, and clears", () => {
  clearInbox();
  for (let i = 0; i < 55; i++) notifyInbox("info", `n${i}`, "text");
  const v = inboxView();
  assert.equal(v.items.length, 50);
  assert.equal(v.items[0].title, "n54");
  assert.equal(v.unread, 50);
  markInboxRead();
  assert.equal(inboxView().unread, 0);
  clearInbox();
  assert.equal(inboxView().items.length, 0);
});

const good = {
  version: { commit: "abc1234", date: null, behind: 0, checkedAt: 1 },
  cli: { version: "2.1.0", loggedIn: true, email: "a@b.com", org: "Example Org" },
  connectors: [
    { name: "claude.ai Microsoft 365", status: "connected" as const, detail: "Connected" },
    { name: "plugin:desktop-control:desktop", status: "connected" as const, detail: "Connected" },
    { name: "claude.ai Notion", status: "needs-auth" as const, detail: "Needs auth" },
  ],
  secure: { host: "pc.tail.ts.net", error: null },
  disabled: false,
  chromeTools: true,
  devices: 2,
  auditBadLine: -1,
};
const byName = (f: typeof good) => Object.fromEntries(evaluate(f).map((c) => [c.name, c]));

test("health check: everything fine", () => {
  assert.ok(evaluate(good).every((c) => c.status === "ok"), JSON.stringify(evaluate(good).filter((c) => c.status !== "ok")));
});

test("health check: each problem says what's wrong and how to fix it", () => {
  const c = byName({
    ...good,
    version: { ...good.version, behind: 3 },
    cli: { loggedIn: false },
    connectors: [{ name: "claude.ai Microsoft 365", status: "needs-auth", detail: "Needs auth" }],
    secure: { host: null, error: "Tailscale is stopped" },
    disabled: true,
    auditBadLine: 4,
  });
  assert.equal(c["Helper version"].status, "warn");
  assert.equal(c["Claude on the PC"].status, "bad");
  assert.equal(c["Microsoft 365"].status, "bad");
  assert.equal(c["Desktop control"].status, "warn");
  assert.equal(c["Phone link (Tailscale)"].status, "bad");
  assert.equal(c["Remote access"].status, "warn");
  assert.equal(c["Audit log"].status, "bad");
  for (const k of ["Helper version", "Claude on the PC", "Microsoft 365", "Desktop control", "Phone link (Tailscale)", "Remote access", "Audit log"]) assert.ok(c[k].fix, k);
});
