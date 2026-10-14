import { test } from "node:test";
import assert from "node:assert/strict";
import { newStreamState, parseTurnMessage, trimInput } from "../src/stream.js";

const noPlan = () => null;

test("assistant blocks become text, thinking and tool call items, and usage is tracked", () => {
  const st = newStreamState();
  const out = parseTurnMessage(
    {
      type: "assistant",
      message: {
        usage: { input_tokens: 8, cache_creation_input_tokens: 364, cache_read_input_tokens: 39819 },
        content: [
          { type: "thinking", thinking: "Let me check." },
          { type: "text", text: "Looking now." },
          { type: "text", text: "   " },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "C:\\x.txt" } },
        ],
      },
    },
    "t_1", st, noPlan,
  );
  assert.deepEqual(out.map((o) => (o.kind === "item" ? o.item.kind : o.kind)), ["thinking", "text", "tool_use"]);
  assert.equal(st.contextTokens, 40191);
  const tool = out[2];
  assert.ok(tool.kind === "item" && tool.item.kind === "tool_use" && tool.item.id === "toolu_1" && tool.item.name === "Read");
});

test("sub-agent requests don't change the main context count", () => {
  const st = newStreamState();
  st.contextTokens = 1000;
  parseTurnMessage({ type: "assistant", parent_tool_use_id: "toolu_task", message: { usage: { input_tokens: 99999 }, content: [] } }, "t", st, noPlan);
  assert.equal(st.contextTokens, 1000);
});

test("tool results are linked to their call, truncated when huge, and errors are flagged", () => {
  const st = newStreamState();
  const big = "x".repeat(25_000);
  const out = parseTurnMessage(
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: big }] },
          { type: "tool_result", tool_use_id: "toolu_2", content: "File not found", is_error: true },
        ],
      },
    },
    "t", st, noPlan,
  );
  const [a, b] = out.map((o) => (o.kind === "item" && o.item.kind === "tool_result" ? o.item : null));
  assert.equal(a?.toolUseId, "toolu_1");
  assert.equal(a?.truncated, true);
  assert.equal(a?.output.length, 20_000);
  assert.equal(b?.isError, true);
  assert.equal(b?.output, "File not found");
});

test("a plan written in plan mode is shown once the write succeeds", () => {
  const st = newStreamState();
  const path = "C:\\Users\\ben\\.claude\\plans\\tidy-lighthouse.md";
  parseTurnMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_p", name: "Write", input: { file_path: path, content: "# Plan" } }] } }, "t", st, noPlan);
  const out = parseTurnMessage(
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_p", content: "ok" }] } },
    "t", st, (p) => (p === path ? "# Plan\n1. Do it" : null),
  );
  const plan = out.find((o) => o.kind === "item" && o.item.kind === "plan");
  assert.ok(plan && plan.kind === "item" && plan.item.kind === "plan" && plan.item.text.includes("Do it"));
  // An ordinary file isn't a plan.
  parseTurnMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "C:\\proj\\plan.md", content: "x" } }] } }, "t", st, noPlan);
  assert.equal(st.planWrites.has("toolu_w"), false);
});

test("the result reports context use against the model's window", () => {
  const st = newStreamState();
  st.contextTokens = 50_000;
  const out = parseTurnMessage({ type: "result", total_cost_usd: 0.03, modelUsage: { "claude-sonnet-5-5": { contextWindow: 200000 } } }, "t", st, noPlan);
  assert.deepEqual(out, [{ kind: "usage", contextTokens: 50_000, contextWindow: 200_000, costUsd: 0.03 }]);
});

test("a compact reports the smaller context", () => {
  const st = newStreamState();
  st.contextTokens = 38_537;
  const out = parseTurnMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 38_537, post_tokens: 3_394 } }, "t", st, noPlan);
  assert.deepEqual(out, [{ kind: "compacted", contextTokens: 3_394 }]);
  assert.equal(st.contextTokens, 3_394);
});

test("huge tool inputs are cut down for the wire", () => {
  const input = { file_path: "C:\\a.txt", content: "y".repeat(150_000) };
  const t = trimInput(input) as { file_path: string; content: string };
  assert.equal(t.file_path, "C:\\a.txt");
  assert.ok(t.content.length < 21_000 && t.content.includes("more characters not shown"));
  const small = { a: 1 };
  assert.equal(trimInput(small), small); // small inputs pass through untouched
});
