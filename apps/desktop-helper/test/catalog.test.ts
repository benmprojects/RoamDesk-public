import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake home, desktop-app folder and temp folder, so the real ones are never touched.
const base = mkdtempSync(join(tmpdir(), "ca-catalog-"));
process.env.USERPROFILE = join(base, "home");
process.env.HOME = join(base, "home");
process.env.APPDATA = join(base, "appdata");
process.env.TEMP = process.env.TMP = join(base, "systemp");
mkdirSync(process.env.TEMP, { recursive: true });

const projects = join(base, "home", ".claude", "projects", "C--Work");
const desktopDir = join(base, "appdata", "Claude", "claude-code-sessions", "acct", "org");
mkdirSync(projects, { recursive: true });
mkdirSync(desktopDir, { recursive: true });
const work = join(base, "work");
mkdirSync(work);

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-2222-3333-444444444444`;
const t0 = Date.parse("2026-10-01T00:00:00Z");
function session(n: number, title: string, minutesAgo: number, entrypoint = "cli", cwd = work) {
  const file = join(projects, `${id(n)}.jsonl`);
  writeFileSync(file, [JSON.stringify({ type: "user", cwd, entrypoint, message: { role: "user", content: title } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })].join("\n") + "\n");
  const at = new Date(t0 + (1000 - minutesAgo) * 60_000);
  utimesSync(file, at, at);
}
function desktopRecord(n: number, title: string, lastActivityAt: number, archived = false) {
  writeFileSync(join(desktopDir, `local_${id(n)}.json`), JSON.stringify({ cliSessionId: id(n), title, lastActivityAt, isArchived: archived }));
}

for (let n = 1; n <= 40; n++) session(n, `Chat ${n}`, n * 10); // chat 1 newest by file time
session(41, "Throwaway", 1, "cli", join(base, "systemp", "x")); // temp folder: skipped
desktopRecord(40, "Renamed in the desktop app", t0 + 2000 * 60_000); // oldest file, but most recent desktop activity
desktopRecord(2, "Archived chat", t0, true);
desktopRecord(3, "", t0); // a desktop chat without a title of its own

const { listCatalog, findSession } = await import("../src/catalog.js");

test("lists every chat, not just 30, newest by the desktop app's own activity", () => {
  const list = listCatalog(new Set());
  assert.equal(list.length, 39); // 40 chats, less the archived one; the temp-folder one is skipped
  assert.equal(list[0].title, "Renamed in the desktop app");
  assert.equal(list[0].origin, "desktop");
  assert.equal(list[1].title, "Chat 1");
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].lastActiveAt >= list[i].lastActiveAt, "sorted newest first");
});

test("desktop chats are labelled desktop, keep their own title when the app has none, and phone-attached stay phone", () => {
  const list = listCatalog(new Set([id(1)]));
  const by = Object.fromEntries(list.map((c) => [c.claudeSessionId, c]));
  assert.equal(by[id(3)].origin, "desktop");
  assert.equal(by[id(3)].title, "Chat 3");
  assert.equal(by[id(1)].origin, "phone");
  assert.equal(by[id(5)].origin, "terminal");
});

test("archived chats are left out of the list but can still be continued by id", () => {
  assert.ok(!listCatalog(new Set()).some((c) => c.claudeSessionId === id(2)));
  assert.equal(findSession(id(2), new Set())?.origin, "desktop");
});

test("a limit still applies when asked for", () => {
  assert.equal(listCatalog(new Set(), 5).length, 5);
});
