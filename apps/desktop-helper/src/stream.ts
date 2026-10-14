// Turns Claude Code's stream-json messages into the pieces a browser shows: text, thinking, tool calls, tool
// results, plans and context use. Pure apart from reading a plan file back, which the caller supplies.
import type { TurnItem } from "@claude-anywhere/protocol";

export const MAX_OUTPUT_CHARS = 20_000;
const MAX_INPUT_CHARS = 100_000;
const PLAN_FILE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/i;

export interface StreamState {
  /** Counter for item ids within the turn. */
  n: number;
  /** Tokens in context as of the latest request. */
  contextTokens: number;
  /** Plan files being written, by tool_use id, so the plan is shown once the write has happened. */
  planWrites: Map<string, string>;
}

export const newStreamState = (): StreamState => ({ n: 0, contextTokens: 0, planWrites: new Map() });

export type StreamOut =
  | { kind: "item"; item: TurnItem }
  | { kind: "usage"; contextTokens: number; contextWindow: number; costUsd?: number }
  /** /compact (or auto-compact) shrank the conversation to this many tokens. */
  | { kind: "compacted"; contextTokens: number };

export function isPlanFile(path: unknown) {
  return typeof path === "string" && PLAN_FILE.test(path);
}

/** Large tool inputs (a whole file being written) are cut down for the wire; the CLI still has the full input. */
export function trimInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? {});
  if (json.length <= MAX_INPUT_CHARS) return input;
  if (typeof input !== "object" || input === null) return String(json).slice(0, MAX_INPUT_CHARS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > 20_000 ? `${v.slice(0, 20_000)}\n… (${v.length - 20_000} more characters not shown)` : v;
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : JSON.stringify(c)))
    .join("\n");
}

export function parseTurnMessage(m: any, turnId: string, st: StreamState, readPlan: (path: string) => string | null): StreamOut[] {
  const out: StreamOut[] = [];
  const id = () => `${turnId}:${++st.n}`;

  if (m?.type === "assistant" && Array.isArray(m.message?.content)) {
    const u = m.message.usage;
    if (u && !m.parent_tool_use_id) {
      st.contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
    for (const b of m.message.content) {
      if (b?.type === "text" && String(b.text ?? "").trim()) out.push({ kind: "item", item: { kind: "text", id: id(), text: String(b.text) } });
      else if (b?.type === "thinking" && String(b.thinking ?? "").trim()) out.push({ kind: "item", item: { kind: "thinking", id: id(), text: String(b.thinking) } });
      else if (b?.type === "tool_use") {
        out.push({ kind: "item", item: { kind: "tool_use", id: String(b.id), name: String(b.name), input: trimInput(b.input) } });
        if ((b.name === "Write" || b.name === "Edit" || b.name === "MultiEdit") && isPlanFile(b.input?.file_path)) st.planWrites.set(String(b.id), b.input.file_path);
      }
    }
  }

  if (m?.type === "user" && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b?.type !== "tool_result") continue;
      const full = resultText(b.content);
      const truncated = full.length > MAX_OUTPUT_CHARS;
      const toolUseId = String(b.tool_use_id);
      out.push({
        kind: "item",
        item: { kind: "tool_result", id: id(), toolUseId, output: truncated ? full.slice(0, MAX_OUTPUT_CHARS) : full, isError: b.is_error === true, truncated },
      });
      const planPath = st.planWrites.get(toolUseId);
      if (planPath) {
        st.planWrites.delete(toolUseId);
        const text = b.is_error === true ? null : readPlan(planPath);
        if (text) out.push({ kind: "item", item: { kind: "plan", id: id(), path: planPath, text } });
      }
    }
  }

  if (m?.type === "system" && m.subtype === "compact_boundary") {
    const post = Number(m.compact_metadata?.post_tokens);
    if (post > 0) {
      st.contextTokens = post;
      out.push({ kind: "compacted", contextTokens: post });
    }
  }

  if (m?.type === "result") {
    const usage = Object.values(m.modelUsage ?? {}) as any[];
    const contextWindow = Math.max(0, ...usage.map((u) => Number(u?.contextWindow) || 0));
    if (contextWindow > 0 && st.contextTokens > 0) {
      out.push({ kind: "usage", contextTokens: st.contextTokens, contextWindow, costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined });
    }
  }
  return out;
}
