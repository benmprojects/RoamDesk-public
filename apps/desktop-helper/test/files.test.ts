import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-files-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");
mkdirSync(process.env.CA_DATA_DIR, { recursive: true });

const { offerFile, serveFile } = await import("../src/files.js");
const { audit, verifyChain } = await import("../src/audit.js");
const { AUDIT_DIR } = await import("../src/paths.js");

const source = join(tmp, "Quote 12.pdf");
writeFileSync(source, "hello phone");

function outbox() {
  return JSON.parse(readFileSync(join(process.env.CA_DATA_DIR!, "outbox", "index.json"), "utf8"));
}

test("a file is copied to the outbox and offered", () => {
  const r = offerFile(source, "As asked");
  assert.deepEqual(r, { ok: true, name: "Quote 12.pdf", size: 11 });
  const e = outbox()[0];
  assert.equal(e.mime, "application/pdf");
  assert.ok(e.access.length >= 30);
});

test("bad requests are refused with a reason", () => {
  assert.equal((offerFile(join(tmp, "nope.txt"), "") as any).ok, false);
  assert.match((offerFile(tmp, "") as any).error, /folder/i);
  const empty = join(tmp, "empty.txt");
  writeFileSync(empty, "");
  assert.match((offerFile(empty, "") as any).error, /empty/i);
});

test("download needs the right access key", async () => {
  const e = outbox()[0];
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    serveFile(u.pathname.slice(6), u.searchParams.get("a") ?? "", res);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/file/${e.id}`;
  try {
    const ok = await fetch(`${base}?a=${e.access}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "hello phone");
    assert.match(ok.headers.get("content-disposition") ?? "", /Quote%2012\.pdf/);
    assert.equal((await fetch(`${base}?a=wrong`)).status, 404);
    assert.equal((await fetch(base)).status, 404);
    assert.equal((await fetch(`${base.replace(e.id, "nope")}?a=${e.access}`)).status, 404);
  } finally {
    srv.close();
  }
});

test("audit log copes with tool input that looks like a credential assignment", () => {
  // Hiding credentials by rewriting the serialised line used to eat an escape, throw, and block the tool call.
  // Built from pieces so this file doesn't itself trip an older running helper.
  const code = "const to" + "ken = randomBytes(24).toString(" + '"base64url"' + "); const pass" + 'word = "hunter2hunter2";';
  assert.doesNotThrow(() => audit({ event: "tool", tool: "Write", input: { file_path: "a.ts", content: code } }));
  const file = join(AUDIT_DIR, readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).sort().pop()!);
  assert.equal(verifyChain(file), -1);
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!);
  assert.ok(!JSON.stringify(last).includes("hunter2hunter2"));
});
