import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-workspace-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");
const { workspaceChanges, readWorkspaceFile, parseStatus, splitDiff, countLines } = await import("../src/workspace.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const repo = join(tmp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
g("init", "-q");
g("config", "user.email", "test@example.com");
g("config", "user.name", "Test");
writeFileSync(join(repo, "src", "app.ts"), "one\ntwo\nthree\n");
writeFileSync(join(repo, "gone.txt"), "bye\n");
writeFileSync(join(repo, "old-name.md"), "# Title\nsame content here\nand more\n");
g("add", ".");
g("commit", "-qm", "first");
writeFileSync(join(repo, "src", "app.ts"), "one\nTWO\nthree\nfour\n");
execFileSync("cmd", ["/c", "del", join(repo, "gone.txt")]);
g("mv", "old-name.md", "new-name.md");
writeFileSync(join(repo, "notes.txt"), "brand new\nfile\n");
writeFileSync(join(repo, "picture.png"), PNG);
writeFileSync(join(repo, ".env"), "SECRET=1\n");

test("porcelain status and diff splitting", () => {
  assert.deepEqual(parseStatus(" M a.ts\0?? b.txt\0R  new.md\0old.md\0 D c.txt\0"), [
    { status: "M", path: "a.ts" },
    { status: "?", path: "b.txt" },
    { status: "R", path: "new.md", from: "old.md" },
    { status: "D", path: "c.txt" },
  ]);
  const d = splitDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n");
  assert.deepEqual([...d.keys()], ["x.ts", "y"]);
  assert.deepEqual(countLines(d.get("x.ts")!), { added: 1, removed: 1 });
});

test("changes in a repository: modified, deleted, renamed, new; credential files never shown", async () => {
  const c = await workspaceChanges(join(repo, "src"));
  assert.equal(c.git, true);
  const by = Object.fromEntries(c.files.map((f) => [f.path, f]));
  assert.equal(by["src\\app.ts"].status, "M");
  assert.deepEqual([by["src\\app.ts"].added, by["src\\app.ts"].removed], [2, 1]);
  assert.equal(by["gone.txt"].status, "D");
  assert.equal(by["new-name.md"].status, "R");
  assert.equal(by["new-name.md"].from, "old-name.md");
  assert.equal(by["notes.txt"].status, "?");
  assert.equal(by["notes.txt"].added, 2);
  assert.ok(by[".env"], "listed as changed");
  assert.equal(by[".env"].diff, "", "but its contents are never sent");
  assert.equal(by["picture.png"].diff, "", "binary files have no diff");
});

test("a folder that isn't a repository says so", async () => {
  const plain = join(tmp, "plain");
  mkdirSync(plain);
  assert.equal((await workspaceChanges(plain)).git, false);
});

test("file preview: text, pictures by their bytes, binary, and refusals", async () => {
  const t = await readWorkspaceFile(join(repo, "src"), "app.ts");
  assert.equal(t.kind, "text");
  assert.equal(t.text, "one\nTWO\nthree\nfour\n");
  const fromRoot = await readWorkspaceFile(join(repo, "src"), join(repo, "notes.txt"));
  assert.equal(fromRoot.kind, "text", "files elsewhere in the same repository are fine");
  const img = await readWorkspaceFile(repo, "picture.png");
  assert.equal(img.kind, "image");
  assert.equal(img.mime, "image/png");
  writeFileSync(join(repo, "fake.png"), "not really a picture");
  assert.equal((await readWorkspaceFile(repo, "fake.png")).kind, "text");
  writeFileSync(join(repo, "data.bin"), Buffer.from([1, 0, 2, 0, 3]));
  assert.equal((await readWorkspaceFile(repo, "data.bin")).kind, "binary");
  assert.match((await readWorkspaceFile(repo, ".env")).error ?? "", /credentials/);
  assert.match((await readWorkspaceFile(repo, "..\\..\\outside.txt")).error ?? "", /session's folder/);
  assert.match((await readWorkspaceFile(repo, "missing.txt")).error ?? "", /doesn't exist/);
});
