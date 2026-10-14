import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-mcpcache-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");
mkdirSync(process.env.CA_DATA_DIR, { recursive: true });

const { dropFlags, flaggedNames, clearFlags } = await import("../src/mcpcache.js");
const { ANNOUNCED } = await import("../src/connectors.js");
const { evaluate } = await import("../src/doctor.js");

// The shape Claude Code writes: connector name -> { timestamp, id? }
const sample = {
  "claude.ai Microsoft 365": { timestamp: 1791937475165, id: "mcpsrv_x" },
  "claude.ai Notion": { timestamp: 1791937474735 },
  "plugin:design:figma": { timestamp: 1791335698433 },
};

test("only the Microsoft 365 entry is dropped; the others stay", () => {
  const { text, removed } = dropFlags(JSON.stringify(sample), ANNOUNCED);
  assert.deepEqual(removed, ["claude.ai Microsoft 365"]);
  assert.deepEqual(Object.keys(JSON.parse(text)), ["claude.ai Notion", "plugin:design:figma"]);
});

test("a file that isn't a plain map is left exactly as it is", () => {
  for (const raw of ["not json", "[1,2]", "null", ""]) assert.deepEqual(dropFlags(raw, ANNOUNCED), { text: raw, removed: [] });
});

test("clearing backs the file up first, then removes the entry", () => {
  const file = join(tmp, "cache.json");
  const backups = join(tmp, "backups");
  writeFileSync(file, JSON.stringify(sample));
  assert.deepEqual(flaggedNames(ANNOUNCED, file), ["claude.ai Microsoft 365"]);
  assert.deepEqual(clearFlags(ANNOUNCED, file, backups), ["claude.ai Microsoft 365"]);
  assert.deepEqual(flaggedNames(ANNOUNCED, file), []);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["claude.ai Notion", "plugin:design:figma"]);
  const [b] = readdirSync(backups);
  assert.deepEqual(JSON.parse(readFileSync(join(backups, b), "utf8")), sample); // the original, untouched
});

test("nothing flagged means nothing is touched or backed up", () => {
  const file = join(tmp, "clean.json");
  const backups = join(tmp, "backups2");
  writeFileSync(file, JSON.stringify({ "claude.ai Notion": { timestamp: 1 } }));
  assert.deepEqual(clearFlags(ANNOUNCED, file, backups), []);
  assert.deepEqual(clearFlags(ANNOUNCED, join(tmp, "missing.json"), backups), []); // no file at all
  assert.equal(readdirSync(tmp).includes("backups2"), false);
});

test("only the last 10 backups are kept", () => {
  const file = join(tmp, "many.json");
  const backups = join(tmp, "backups3");
  for (let i = 0; i < 14; i++) {
    writeFileSync(file, JSON.stringify(sample));
    clearFlags(ANNOUNCED, file, backups);
  }
  assert.equal(readdirSync(backups).length, 10);
});

test("health check reports a stale flag on a connector that shows as connected", () => {
  const base = {
    version: { commit: "abc1234", date: null, behind: 0, checkedAt: 1 },
    cli: { loggedIn: true, email: "a@b.com" },
    connectors: [{ name: "claude.ai Microsoft 365", status: "connected" as const, detail: "Connected" }],
    secure: { host: "pc.ts.net", error: null },
    disabled: false,
    chromeTools: true,
    devices: 1,
    auditBadLine: -1,
  };
  assert.equal(evaluate({ ...base, flagged: [] }).some((c) => c.name === "Microsoft 365 skipped by Claude"), false);
  const c = evaluate({ ...base, flagged: ["claude.ai Microsoft 365"] }).find((x) => x.name === "Microsoft 365 skipped by Claude");
  assert.equal(c?.status, "warn");
  assert.ok(c?.fix);
});
