import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-admin-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");
const { adminState, adminUntilFor, adminExpired, deviceAdminRequest } = await import("../src/admin.js");
const { decide } = await import("../src/policy.js");
const { stopClassifier } = await import("../src/psast.js");
const { after } = await import("node:test");
after(() => stopClassifier());

const now = Date.parse("2026-10-09T10:00:00Z");

test("off by default; timed choices end; 'until off' doesn't", () => {
  assert.deepEqual(adminState({ adminAllowUntil: 0 }, now), { on: false, until: null });
  const hour = adminUntilFor("1h", now);
  assert.equal(hour, now + 3_600_000);
  assert.deepEqual(adminState({ adminAllowUntil: hour }, now), { on: true, until: hour });
  assert.equal(adminState({ adminAllowUntil: hour }, now + 3_600_001).on, false, "expired counts as off at once");
  assert.equal(adminExpired({ adminAllowUntil: hour }, now + 3_600_001), true, "and gets tidied up");
  assert.equal(adminUntilFor("8h", now), now + 8 * 3_600_000);
  assert.deepEqual(adminState({ adminAllowUntil: adminUntilFor("until-off", now) }, now + 365 * 86_400_000), { on: true, until: -1 });
  assert.equal(adminExpired({ adminAllowUntil: -1 }, now), false);
  assert.equal(adminUntilFor("off", now), 0);
});

test("a phone or browser can only switch it off", () => {
  assert.equal(deviceAdminRequest(false), "off");
  assert.equal(deviceAdminRequest("off"), "off");
  for (const v of [true, "1h", "8h", "until-off", 1, {}]) assert.equal(deviceAdminRequest(v), "refuse", String(v));
  assert.equal(deviceAdminRequest(undefined), null);
});

test("without the switch, credentials and the helper's own files stay locked", async () => {
  // The switch itself is applied in the hook (server.ts) before these decisions are used; with it off they stand.
  const creds = await decide("Read", { file_path: join(tmp, ".env") }, { sessionCwd: tmp });
  assert.equal(creds.tier, "deny");
  assert.equal(creds.locked, true);
});
