import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../js/state.js";

let ts = Date.now(); // real time: approvals and questions from long ago count as expired
const env = (type, payload) => ({ v: 1, type, id: String(ts), ts: ts++, payload });
const sessions = [
  { id: "a", name: "Alpha", cwd: "C:\\a", model: "claude-sonnet-5-5", busy: false, permissionMode: "default" },
  { id: "b", name: "Beta", cwd: "C:\\b", model: "claude-opus-5-5", busy: false },
];

function started() {
  const s = createStore();
  s.apply(env("auth.ok", { helperName: "PC", sessions, activeSessionId: "a", replayFrom: 0, disabled: false, models: ["m"], efforts: ["low"] }));
  return s;
}
const kinds = (s, id = "a") => s.convo(id).entries.map((e) => e.kind + (e.live ? "*" : ""));

test("a typed message shows as queued, then becomes the real turn", () => {
  const s = started();
  s.addPending("a", "hello");
  assert.equal(s.convo("a").entries[0].pending, true);
  s.apply(env("turn.started", { turnId: "t1", sessionId: "a", text: "hello", origin: "browser" }));
  assert.equal(s.convo("a").entries.length, 1);
  assert.equal(s.convo("a").entries[0].pending, false);
  assert.equal(s.convo("a").entries[0].turnId, "t1");
});

test("streamed text is replaced in place by the finished block; tools and results line up", () => {
  const s = started();
  s.apply(env("turn.started", { turnId: "t1", sessionId: "a", text: "go" }));
  s.apply(env("reply.delta", { turnId: "t1", text: "Look" }));
  s.apply(env("reply.delta", { turnId: "t1", text: "ing" }));
  assert.deepEqual(kinds(s), ["user", "text*"]);
  assert.equal(s.convo("a").entries[1].text, "Looking");
  s.apply(env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "text", id: "t1:1", text: "Looking." } }));
  s.apply(env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x" } } }));
  s.apply(env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "tool_result", id: "t1:2", toolUseId: "toolu_1", output: "contents", isError: false, truncated: false } }));
  s.apply(env("reply.delta", { turnId: "t1", text: "Done" }));
  s.apply(env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "text", id: "t1:3", text: "Done." } }));
  s.apply(env("turn.done", { turnId: "t1", text: "Done.", durationMs: 10 }));
  assert.deepEqual(kinds(s), ["user", "text", "tool", "text"]);
  assert.equal(s.convo("a").entries[2].result.output, "contents");
});

test("replayed frames don't duplicate anything", () => {
  const s = started();
  const frames = [
    env("turn.started", { turnId: "t1", sessionId: "a", text: "go" }),
    env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "tool_use", id: "toolu_1", name: "Read", input: {} } }),
    env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "text", id: "t1:1", text: "ok" } }),
    env("turn.done", { turnId: "t1", text: "ok", durationMs: 1 }),
  ];
  frames.forEach(s.apply);
  frames.forEach(s.apply);
  assert.deepEqual(kinds(s), ["user", "tool", "text"]);
});

test("a reply with no items (e.g. from an older helper) still shows the final text", () => {
  const s = started();
  s.apply(env("turn.started", { turnId: "t1", sessionId: "a", text: "go" }));
  s.apply(env("turn.done", { turnId: "t1", text: "All done.", durationMs: 1 }));
  assert.deepEqual(kinds(s), ["user", "text"]);
});

test("approvals attach to their tool call and close when resolved or the turn ends", () => {
  const s = started();
  s.apply(env("turn.started", { turnId: "t1", sessionId: "a", text: "go" }));
  s.apply(env("turn.item", { turnId: "t1", sessionId: "a", item: { kind: "tool_use", id: "toolu_9", name: "PowerShell", input: { command: "rm x" } } }));
  s.apply(env("confirm.request", { confirmId: "c1", turnId: "t1", sessionId: "a", toolUseId: "toolu_9", tier: 2, summary: "Delete x", command: "rm x", phrase: "", expiresInS: 570 }));
  const tool = s.convo("a").entries[1];
  assert.equal(tool.approval.state, "pending");
  s.apply(env("confirm.resolved", { confirmId: "c1", decision: "confirm", by: "phone" }));
  assert.equal(s.convo("a").entries[1].approval.state, "allowed");
  // One without a matching tool call is its own entry, and a failed turn expires it.
  s.apply(env("confirm.request", { confirmId: "c2", turnId: "t1", sessionId: "a", tier: 2, summary: "Other", command: "", phrase: "", expiresInS: 570 }));
  s.apply(env("turn.failed", { turnId: "t1", error: "Cancelled" }));
  const appr = s.convo("a").entries.find((e) => e.kind === "approval");
  assert.equal(appr.state, "expired");
  assert.equal(s.convo("a").entries.at(-1).text, "Stopped.");
});

test("questions, plans, usage and files land in the right session", () => {
  const s = started();
  s.apply(env("turn.started", { turnId: "t2", sessionId: "b", text: "plan it" }));
  s.apply(env("turn.item", { turnId: "t2", sessionId: "b", item: { kind: "plan", id: "t2:1", path: "p.md", text: "# Plan" } }));
  s.apply(env("ask.request", { askId: "q1", turnId: "t2", sessionId: "b", questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }], expiresInS: 840 }));
  s.apply(env("turn.usage", { turnId: "t2", sessionId: "b", contextTokens: 50_000, contextWindow: 200_000 }));
  s.apply(env("file", { fileId: "f1", turnId: "t2", name: "r.pdf", size: 10, mime: "application/pdf", caption: "", access: "k", expiresAt: 0 }));
  assert.deepEqual(kinds(s, "b"), ["user", "plan", "ask", "file"]);
  assert.deepEqual(s.convo("b").context, { tokens: 50_000, window: 200_000 });
  assert.equal(kinds(s, "a").length, 0);
  assert.ok(s.state.unread.has("b"));
  s.patch("b", "ask:q1", { state: "sending" }); // answered here, waiting for the helper
  s.apply(env("ask.resolved", { askId: "q1", answered: true }));
  assert.equal(s.convo("b").entries[2].state, "answered");
});

test("earlier history goes above, without repeating what's on screen", () => {
  const s = started();
  s.apply(env("turn.started", { turnId: "t1", sessionId: "a", text: "latest question" }));
  s.apply(env("history", { sessionId: "a", items: [
    { role: "user", text: "old question", ts: 1 },
    { role: "assistant", text: "old answer", ts: 2 },
    { role: "user", text: "latest question", ts: 3 },
  ] }));
  assert.deepEqual(s.convo("a").entries.map((e) => e.text), ["old question", "old answer", "latest question"]);
});

test("attachments: the sender keeps its previews, the file note is hidden, others see names", () => {
  const s = started();
  s.addPending("a", "what's this?", [{ name: "shot.png", kind: "image", url: "blob:x" }, { name: "plan.pdf", kind: "file" }]);
  s.apply(env("turn.started", {
    turnId: "t9", sessionId: "a", origin: "browser",
    text: "what's this?\n\nAttached files (saved on this PC; read them as needed):\n- plan.pdf: C:\\up\\plan.pdf",
    attachments: [{ name: "shot.png", kind: "image", mime: "image/png", size: 10 }, { name: "plan.pdf", kind: "file", mime: "application/pdf", size: 20, path: "C:\\up\\plan.pdf" }],
  }));
  const e = s.convo("a").entries;
  assert.equal(e.length, 1);
  assert.equal(e[0].text, "what's this?");
  assert.equal(e[0].attachments[0].url, "blob:x");
  assert.equal(e[0].attachments[1].path, "C:\\up\\plan.pdf");
  // Seen from another device: names only.
  s.apply(env("turn.started", { turnId: "t10", sessionId: "b", text: "look", attachments: [{ name: "x.png", kind: "image", mime: "image/png", size: 1 }] }));
  assert.equal(s.convo("b").entries[0].attachments[0].name, "x.png");
});

test("command lists and file search results are kept", () => {
  const s = started();
  s.apply(env("commands", { sessionId: "a", commands: [{ name: "compact", skill: false }] }));
  s.apply(env("files", { sessionId: "a", query: "app", items: ["src/app.ts"] }));
  assert.equal(s.state.commands.get("a")[0].name, "compact");
  assert.deepEqual(s.state.files, { sessionId: "a", query: "app", items: ["src/app.ts"] });
});

test("a suggested next message is kept per session and dropped when a new request starts", () => {
  const s = started();
  s.apply(env("prompt.suggestion", { sessionId: "a", text: "  make it a checklist " }));
  assert.equal(s.state.suggestions.get("a"), "make it a checklist");
  assert.equal(s.state.suggestions.has("b"), false);
  s.apply(env("turn.started", { turnId: "t20", sessionId: "a", text: "go", origin: "browser" }));
  assert.equal(s.state.suggestions.has("a"), false);
});

test("full history pages go above in order, skip what's live, and pair tool results across pages", () => {
  const s = started();
  const now = Date.now();
  // Live: the latest request, from the replay.
  s.apply({ v: 1, type: "turn.started", id: "x", ts: now, payload: { turnId: "t1", sessionId: "a", text: "latest" } });
  // First page (newest): its last exchange is the live one and must not repeat.
  s.apply(env("history.page", { sessionId: "a", requested: null, cursor: 500, entries: [
    { kind: "tool_result", id: "h:r1", toolUseId: "toolu_old", output: "old output", isError: false, truncated: false, ts: now - 50_000 },
    { kind: "text", id: "h:t1", text: "earlier answer", ts: now - 40_000 },
    { kind: "user", id: "h:u2", text: "latest", ts: now + 5 },
  ] }));
  // Older page: the tool call whose result was on the newer page.
  s.apply(env("history.page", { sessionId: "a", requested: 500, cursor: null, entries: [
    { kind: "user", id: "h:u1", text: "first question", ts: now - 70_000 },
    { kind: "tool_use", id: "toolu_old", name: "Read", input: { file_path: "x" }, ts: now - 60_000 },
    { kind: "note", id: "h:n1", text: "Conversation compacted.", ts: now - 55_000 },
  ] }));
  const c = s.convo("a");
  assert.deepEqual(c.entries.map((e) => e.text ?? e.kind), ["first question", "tool", "Conversation compacted.", "earlier answer", "latest"]);
  assert.equal(c.entries[1].result.output, "old output");
  assert.equal(c.historyCursor, null);
  assert.ok(!s.state.unread.has("a"));
  // A repeated first page is ignored.
  s.apply(env("history.page", { sessionId: "a", requested: null, cursor: 9, entries: [{ kind: "user", id: "h:zz", text: "dup", ts: 1 }] }));
  assert.equal(c.entries.length, 5);
});

test("changes are batched and report which sessions changed", async () => {
  const s = started();
  await Promise.resolve();
  const seen = [];
  s.subscribe((c) => seen.push([...c.sessions].sort().join(",")));
  s.apply(env("turn.started", { turnId: "x", sessionId: "a", text: "1" }));
  s.apply(env("turn.started", { turnId: "y", sessionId: "b", text: "2" }));
  await Promise.resolve();
  assert.deepEqual(seen, ["a,b"]);
});
