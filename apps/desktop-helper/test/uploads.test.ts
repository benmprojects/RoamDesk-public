import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const tmp = mkdtempSync(join(tmpdir(), "ca-uploads-"));
process.env.CA_UPLOAD_DIR = join(tmp, "uploads");
const { beginUpload, receiveUpload, takeAttachments, safeName, sniffImage } = await import("../src/uploads.js");
const { rankFiles } = await import("../src/filesearch.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
function body(buf: Buffer) {
  const s = new PassThrough();
  setImmediate(() => s.end(buf));
  return s as any;
}

test("file names are made safe for Windows", () => {
  assert.equal(safeName("..\\..\\evil.txt"), "evil.txt");
  assert.equal(safeName("a<b>:c?.pdf"), "a_b__c_.pdf");
  assert.equal(safeName("CON.txt"), "file_CON.txt");
  assert.equal(safeName(""), "file");
});

test("images are recognised by their bytes, not their claimed type", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("not an image")), null);
});

test("upload, then attach: images inline, other files by path, each used once by its own device", async () => {
  const img = beginUpload("dev_a", { name: "shot.png", size: PNG.length, mime: "image/png" });
  const doc = beginUpload("dev_a", { name: "notes.txt", size: 5, mime: "image/png" }); // lies about its type
  assert.ok(img.ok && doc.ok);
  if (!img.ok || !doc.ok) return;
  assert.deepEqual(await receiveUpload(img.id, img.token, body(PNG)), { ok: true });
  assert.deepEqual(await receiveUpload(doc.id, doc.token, body(Buffer.from("hello"))), { ok: true });

  assert.equal(takeAttachments("dev_b", [img.id]).missing, 1); // someone else's upload
  const a = takeAttachments("dev_a", [img.id, doc.id, "up_unknown"]);
  assert.equal(a.missing, 1);
  assert.equal(a.images.length, 1);
  assert.deepEqual(a.infos.map((i) => i.kind), ["image", "file"]);
  assert.ok(a.filesNote.includes("notes.txt") && existsSync(a.infos[1].path!));
  assert.equal(takeAttachments("dev_a", [img.id]).missing, 1); // already used
});

test("bad tokens, wrong sizes and oversized files are refused", async () => {
  const s = beginUpload("dev_c", { name: "x.bin", size: 4, mime: "" });
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.equal((await receiveUpload(s.id, "wrong", body(Buffer.from("abcd")))).ok, false);
  const big = await receiveUpload(s.id, s.token, body(Buffer.from("abcdefgh")));
  assert.equal(big.ok, false);
  assert.equal(beginUpload("dev_c", { name: "huge", size: 100 * 1024 * 1024, mime: "" }).ok, false);
  assert.equal(beginUpload("dev_c", { name: "empty", size: 0, mime: "" }).ok, false);
});

test("file search ranks names before paths", () => {
  const files = ["src/app.ts", "src/components/AppHeader.tsx", "docs/apple.md", "test/app.test.ts", "README.md"];
  assert.equal(rankFiles(files, "app.ts")[0], "src/app.ts"); // exact name first; looser matches may follow
  assert.equal(rankFiles(files, "app")[0], "src/app.ts");
  assert.ok(rankFiles(files, "comp").includes("src/components/AppHeader.tsx"));
  assert.deepEqual(rankFiles(files, "zzz"), []);
  assert.equal(rankFiles(files, "").length, 5);
});
