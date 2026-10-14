import { test } from "node:test";
import assert from "node:assert/strict";
import { applySuggestion, formatSize, rankCommands, tokenAt } from "../js/composer.js";

test("finds an @-mention being typed", () => {
  assert.deepEqual(tokenAt("look at @src/ap", 15), { kind: "file", query: "src/ap", start: 8 });
  assert.deepEqual(tokenAt("@", 1), { kind: "file", query: "", start: 0 });
  assert.deepEqual(tokenAt('see @"My Doc', 12), { kind: "file", query: "My Doc", start: 4 });
  assert.equal(tokenAt("email ben@examples.com", 22), null); // not after a space
  assert.equal(tokenAt("@done and more", 14), null); // caret not in the mention
});

test("finds a /command only at the start", () => {
  assert.deepEqual(tokenAt("/comp", 5), { kind: "command", query: "comp", start: 0 });
  assert.deepEqual(tokenAt("/", 1), { kind: "command", query: "", start: 0 });
  assert.equal(tokenAt("/compact now", 12), null);
  assert.equal(tokenAt("use /compact", 12), null);
});

test("inserting a suggestion replaces what was typed", () => {
  const t = tokenAt("look at @src/ap please", 15);
  assert.deepEqual(applySuggestion("look at @src/ap please", 15, t, "src/app.ts"), { text: "look at @src/app.ts please", caret: 20 });
  const q = tokenAt("@My", 3);
  assert.equal(applySuggestion("@My", 3, q, "My Documents/plan.docx").text, '@"My Documents/plan.docx" ');
  const c = tokenAt("/co", 3);
  assert.deepEqual(applySuggestion("/co", 3, c, "compact"), { text: "/compact ", caret: 9 });
});

test("commands rank by name, skills after commands, plugin skills match after the colon", () => {
  const cmds = [
    { name: "compact", skill: false },
    { name: "code-review", skill: true },
    { name: "deep-review:deep-review", skill: true },
    { name: "context", skill: false },
    { name: "mattpocock-skills:code-review", skill: true },
  ];
  assert.deepEqual(rankCommands(cmds, "co").map((c) => c.name), ["compact", "context", "code-review", "mattpocock-skills:code-review"]);
  assert.deepEqual(rankCommands(cmds, "review").map((c) => c.name), ["code-review", "deep-review:deep-review", "mattpocock-skills:code-review"]);
  assert.deepEqual(rankCommands(cmds, "code").map((c) => c.name), ["code-review", "mattpocock-skills:code-review"]); // after the colon
  assert.equal(rankCommands(cmds, "").length, 5);
  assert.deepEqual(rankCommands(null, "x"), []);
});

test("sizes", () => {
  assert.equal(formatSize(12), "12 bytes");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(3.5 * 1024 * 1024), "3.5 MB");
});
