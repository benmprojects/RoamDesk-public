import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-core-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");

const { computeMac } = await import("../src/devices.js");
const { audit, verifyChain, maskSecrets } = await import("../src/audit.js");
const { AUDIT_DIR } = await import("../src/paths.js");

test("HMAC matches the protocol definition (shared test vector with Android)", () => {
  // secret = 32 bytes 0x00..0x1f, nonce = "nonce-123", deviceId = "dev_test"
  const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
  const mac = computeMac(secret, "nonce-123", "dev_test");
  // Independent computation of HMAC-SHA256(key, "nonce-123|dev_test").
  const expected = createHmac("sha256", Buffer.from(Array.from({ length: 32 }, (_, i) => i))).update("nonce-123|dev_test").digest("base64url");
  assert.equal(mac, expected);
  console.log(`  test vector: secret=${secret} mac=${mac}`);
});

test("audit log is hash-chained and detects tampering", () => {
  audit({ event: "a", text: "one" });
  audit({ event: "b", text: "two" });
  audit({ event: "c", text: "three" });
  const file = join(AUDIT_DIR, readdirSync(AUDIT_DIR)[0]);
  assert.equal(verifyChain(file), -1);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.text = "edited";
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file + ".bad", lines.join("\n") + "\n");
  assert.equal(verifyChain(file + ".bad"), 1);
});

test("secrets are masked before they reach the log", () => {
  assert.equal(maskSecrets("key sk-ant-api03-abcdefghijklmnop end"), "key *** end");
  assert.match(maskSecrets('password="hunter2secret"'), /password="\*\*\*/);
  assert.equal(maskSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123"), "***");
});