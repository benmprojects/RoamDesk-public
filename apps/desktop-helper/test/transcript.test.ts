import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistoryPage, recordEntries } from "../src/transcript.js";

const tmp = mkdtempSync(join(tmpdir(), "ca-transcript-"));
let n = 0;
const at = (i: number) => new Date(Date.UTC(2026, 9, 9, 0, 0, i)).toISOString();
const user = (text: any, i: number, extra = {}) => ({ type: "user", uuid: `u${++n}`, timestamp: at(i), message: { role: "user", content: text }, ...extra });
const asst = (content: any[], i: number, extra = {}) => ({ type: "assistant", uuid: `a${++n}`, timestamp: at(i), message: { role: "assistant", content }, ...extra });

test("pasted pictures come back inline, and oversize or odd ones stay a label", () => {
  const img = (data: string, media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data } });
  const att = (r: any) => (recordEntries(r)[0] as any).attachments[0];
  assert.equal(att(user([img("AAAA")], 1)).url, "data:image/png;base64,AAAA");
  assert.equal(att(user([img("AAAA", "image/svg+xml")], 2)).url, undefined);
  assert.equal(att(user([img("A".repeat(2 * 1024 * 1024 + 1))], 3)).url, undefined);
});

test("records become entries: messages, attachments, commands, tools, thinking, compaction", () => {
  const kinds = (r: any) => recordEntries(r).map((e) => e.kind);
  assert.deepEqual(kinds(user("hello", 1)), ["user"]);
  const withNote = recordEntries(user("look\n\nAttached files (saved on this PC; read them as needed):\n- plan.pdf: C:\\up\\plan.pdf", 2));
  assert.equal(withNote[0].kind === "user" && withNote[0].text, "look");
  assert.deepEqual(withNote[0].kind === "user" && withNote[0].attachments, [{ name: "plan.pdf", kind: "file" }]);
  const pic = recordEntries(user([{ type: "text", text: "what's this" }, { type: "image", source: {} }], 3));
  assert.deepEqual(pic[0].kind === "user" && pic[0].attachments, [{ name: "picture", kind: "image" }]);
  const cmd = recordEntries(user("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>", 4));
  assert.equal(cmd[0].kind === "user" && cmd[0].text, "/compact");
  assert.deepEqual(kinds(user("x<system-reminder>secret notice</system-reminder>", 5)), ["user"]);
  assert.equal((recordEntries(user("x<system-reminder>secret notice</system-reminder>", 5))[0] as any).text, "x");
  assert.deepEqual(kinds(user("skill body", 6, { isMeta: true })), []);
  assert.deepEqual(kinds(user("summary", 6, { isCompactSummary: true })), []);
  assert.deepEqual(kinds(user([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }], 7, { toolUseResult: {} })), ["tool_result"]);
  assert.deepEqual(kinds(asst([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hi" }, { type: "tool_use", id: "toolu_1", name: "Read", input: {} }], 8)), ["thinking", "text", "tool_use"]);
  assert.deepEqual(kinds(asst([{ type: "text", text: "sub-agent" }], 9, { isSidechain: true })), []);
  assert.deepEqual(kinds({ type: "system", subtype: "compact_boundary", uuid: "s1", timestamp: at(10), compactMetadata: { trigger: "auto", preTokens: 410677, postTokens: 17496 } }), ["note"]);
  assert.deepEqual(kinds({ type: "attachment", uuid: "x" }), []);
});

function transcript(exchanges: number, filler = 0) {
  const lines: string[] = [];
  for (let i = 0; i < exchanges; i++) {
    lines.push(JSON.stringify(user(`question ${i}`, i * 10)));
    lines.push(JSON.stringify(asst([{ type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: "x".repeat(filler) } }], i * 10 + 1)));
    lines.push(JSON.stringify(user([{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "result" }], i * 10 + 2, { toolUseResult: {} })));
    lines.push(JSON.stringify(asst([{ type: "text", text: `answer ${i}` }], i * 10 + 3)));
    lines.push(JSON.stringify({ type: "file-history-snapshot", messageId: "m" }));
  }
  return lines.join("\n") + "\n";
}

test("pages go backwards, each starts with one of your messages, and together they cover everything once", () => {
  const file = join(tmp, "a.jsonl");
  writeFileSync(file, transcript(50));
  const seen: string[] = [];
  let cursor: number | null | undefined;
  let pages = 0;
  do {
    const p = readHistoryPage(file, { cursor: cursor ?? undefined, pageEntries: 30 });
    assert.equal(p.entries[0].kind, "user", "a page starts with your message");
    seen.unshift(...p.entries.filter((e) => e.kind === "user").map((e: any) => e.text));
    cursor = p.cursor;
    pages++;
  } while (cursor !== null && pages < 100);
  assert.equal(seen.length, 50);
  assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => `question ${i}`));
  assert.ok(pages > 3);
});

test("big records spanning chunk boundaries are read whole", () => {
  const file = join(tmp, "b.jsonl");
  writeFileSync(file, transcript(12, 300_000)); // ~3.6 MB, several 1 MB chunks, lines bigger than a third of a chunk
  const p = readHistoryPage(file, { pageEntries: 1000 });
  assert.equal(p.cursor, null);
  assert.equal(p.entries.filter((e) => e.kind === "user").length, 12);
  assert.equal(p.entries.filter((e) => e.kind === "tool_use").length, 12);
});

test("beforeTs leaves out what the page already shows live", () => {
  const file = join(tmp, "c.jsonl");
  writeFileSync(file, transcript(5));
  const p = readHistoryPage(file, { beforeTs: Date.parse(at(30)) });
  assert.deepEqual(p.entries.filter((e) => e.kind === "user").map((e: any) => e.text), ["question 0", "question 1", "question 2"]);
});
