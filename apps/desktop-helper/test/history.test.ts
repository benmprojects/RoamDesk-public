import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake home with one Claude Code transcript, so the real ~/.claude is never touched.
const home = mkdtempSync(join(tmpdir(), "ca-hist-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
const id = "11111111-2222-3333-4444-555555555555";
const dir = join(home, ".claude", "projects", "C--Work");
mkdirSync(dir, { recursive: true });

const rec = (o: object) => JSON.stringify(o);
const lines = [
  rec({ type: "user", timestamp: "2026-10-07T01:00:00.000Z", message: { role: "user", content: "How much space is on C?" } }),
  rec({ type: "assistant", timestamp: "2026-10-07T01:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", name: "PowerShell", input: {} }] } }),
  rec({ type: "user", timestamp: "2026-10-07T01:00:03.000Z", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", content: "13 GB" }] } }),
  rec({ type: "assistant", timestamp: "2026-10-07T01:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "About 13 gigabytes are free." }] } }),
  rec({ type: "user", isSidechain: true, timestamp: "2026-10-07T01:00:06.000Z", message: { role: "user", content: "sub-agent chatter" } }),
  rec({ type: "user", timestamp: "2026-10-07T01:05:00.000Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>ignore me</system-reminder>Send me the report" }] } }),
  rec({ type: "assistant", timestamp: "2026-10-07T01:05:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Sent." }] } }),
  rec({ type: "user", timestamp: "2026-10-07T01:06:00.000Z", message: { role: "user", content: "[Request interrupted by user]" } }),
  rec({ type: "user", timestamp: "2026-10-07T01:07:00.000Z", message: { role: "user", content: "Unanswered question" } }),
];
writeFileSync(join(dir, `${id}.jsonl`), "garbage line that is not json\n" + lines.join("\n") + "\n");

const { loadHistory } = await import("../src/history.js");

test("a transcript becomes your messages and everything Claude wrote, in order", () => {
  const h = loadHistory(id);
  assert.deepEqual(
    h.map((x) => `${x.role}: ${x.text}`),
    [
      "user: How much space is on C?",
      "assistant: Let me look.", // what Claude wrote before using a tool is kept too
      "assistant: About 13 gigabytes are free.",
      "user: Send me the report", // injected reminder stripped
      "assistant: Sent.",
      "user: Unanswered question", // an interruption isn't a message; a turn with no reply yet still shows
    ],
  );
  assert.ok(h[0].ts > 0 && h[2].ts > h[0].ts);
});

test("long replies are kept far beyond the old 2,000 characters", () => {
  const long = "x".repeat(15_000);
  const id2 = "22222222-2222-3333-4444-555555555555";
  writeFileSync(join(dir, `${id2}.jsonl`), [
    rec({ type: "user", timestamp: "2026-10-07T02:00:00.000Z", message: { role: "user", content: "Write a lot" } }),
    rec({ type: "assistant", timestamp: "2026-10-07T02:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: long }] } }),
  ].join("\n") + "\n");
  assert.equal(loadHistory(id2)[1].text.length, 15_000);
});

test("the turn limit keeps the newest turns", () => {
  const h = loadHistory(id, 1);
  assert.deepEqual(h.map((x) => x.text), ["Unanswered question"]);
});

test("an unknown session gives nothing rather than an error", () => {
  assert.deepEqual(loadHistory("99999999-9999-9999-9999-999999999999"), []);
});
