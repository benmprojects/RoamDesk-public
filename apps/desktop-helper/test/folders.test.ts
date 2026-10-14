import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalPath, listFolders } from "../src/folders.js";

test("only local drive paths are allowed", () => {
  assert.equal(isLocalPath("C:\\Users\\ben"), true);
  assert.equal(isLocalPath("D:/Projects"), true);
  assert.equal(isLocalPath("\\\\server\\share\\x"), false);
  assert.equal(isLocalPath("C:\\a\\\\b"), false);
  assert.equal(isLocalPath("relative\\path"), false);
  const r = listFolders("\\\\server\\share");
  assert.ok(r.error && r.folders.length === 0);
});

test("lists folders only, sorted, with the parent", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-folders-"));
  for (const d of ["Zeta", "alpha", "Project 10", "Project 9", ".git"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "secret.txt"), "not listed");
  const r = listFolders(root);
  assert.deepEqual(r.folders, ["alpha", "Project 9", "Project 10", "Zeta", ".git"]);
  assert.equal(r.parent?.toLowerCase(), join(root, "..").toLowerCase());
  assert.ok(!r.folders.includes("secret.txt"));
});

test("the top level shows drives and shortcuts", () => {
  const r = listFolders(undefined, [tmpdir()]);
  assert.equal(r.path, null);
  assert.ok(r.folders.some((d) => /^C:\\$/i.test(d)));
  assert.ok(r.shortcuts.some((s) => s.name === "Home"));
  assert.ok(r.shortcuts.some((s) => s.name.startsWith("Recent:")));
  assert.ok(!r.shortcuts.some((s) => /RenameBackup/i.test(s.name)));
  assert.ok(r.labels && typeof r.labels === "object");
});

test("a missing folder says so and offers the way back up", () => {
  const r = listFolders(join(tmpdir(), "definitely-not-here-12345"));
  assert.equal(r.error, "That folder doesn't exist.");
  assert.ok(r.parent);
});
