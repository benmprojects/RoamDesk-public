import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, parseUnified, withContext } from "../js/diff.js";
import { editDiff, summarise, modelName } from "../js/tools.js";

test("a one-line change in the middle", () => {
  const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(d.lines, [
    { op: " ", text: "a" },
    { op: "-", text: "b" },
    { op: "+", text: "B" },
    { op: " ", text: "c" },
  ]);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
});

test("insertions and deletions keep the shared lines", () => {
  const d = lineDiff("one\ntwo\nthree\nfour", "zero\none\nthree\nfour\nfive");
  assert.equal(d.lines.filter((l) => l.op === " ").map((l) => l.text).join(","), "one,three,four");
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
});

test("windows line endings and an empty side", () => {
  assert.equal(lineDiff("x\r\ny\r\n", "x\ny\n").added, 0);
  const created = lineDiff("", "new\nfile");
  assert.equal(created.added, 2);
  assert.equal(created.removed, 0);
});

test("huge inputs fall back without building a giant table", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
  const t0 = Date.now();
  const d = lineDiff(a, b);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(d.added, 3000);
  assert.equal(d.removed, 3000);
});

test("context trimming collapses long unchanged runs", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 10", "LINE 10");
  const lines = withContext(lineDiff(before, after).lines, 2);
  assert.equal(lines[0].op, "…");
  assert.ok(lines.some((l) => l.op === "+" && l.text === "LINE 10"));
  assert.equal(lines.at(-1).op, "…");
  assert.equal(lines.filter((l) => l.op === " ").length, 4);
});

test("git unified diffs become diff-view lines", () => {
  const d = "diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@ function main()\n one\n-two\n+TWO\n three\n+four\n\\ No newline at end of file\n";
  assert.deepEqual(parseUnified(d), [
    { op: "…", text: "line 1 · function main()" },
    { op: " ", text: "one" },
    { op: "-", text: "two" },
    { op: "+", text: "TWO" },
    { op: " ", text: "three" },
    { op: "+", text: "four" },
  ]);
  assert.deepEqual(parseUnified("@@ new file @@\n+a\n+b").map((l) => l.op), ["…", "+", "+"]);
  assert.deepEqual(parseUnified(""), []);
});

test("tool summaries", () => {
  assert.deepEqual(summarise("Read", { file_path: "C:\\proj\\src\\app.ts" }), { title: "Read", detail: "app.ts" });
  assert.deepEqual(summarise("PowerShell", { command: "Get-ChildItem", description: "List the project files" }), { title: "PowerShell", detail: "List the project files" });
  assert.deepEqual(summarise("mcp__claude_ai_Microsoft_365__outlook_email_search", {}), { title: "Microsoft 365", detail: "outlook email search" });
  assert.deepEqual(summarise("mcp__plugin_desktop-control_desktop__act", {}), { title: "Desktop", detail: "act" });
  assert.equal(summarise("Unknown", { query: "x" }).detail, "x");
});

test("edit diffs for Edit, MultiEdit and Write", () => {
  assert.equal(editDiff("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }).added, 1);
  const m = editDiff("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d\ne" }] });
  assert.equal(m.added, 3);
  assert.equal(m.removed, 2);
  assert.equal(editDiff("Write", { file_path: "n.txt", content: "1\n2\n" }).created, true);
  assert.equal(editDiff("Read", {}), null);
});

test("model names", () => {
  assert.equal(modelName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelName("claude-something-new"), "something-new");
});
