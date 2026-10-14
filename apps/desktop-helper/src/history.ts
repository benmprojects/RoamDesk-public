// The conversation of a Claude Code session for the phone app, read from its transcript
// (~/.claude/projects/<project>/<id>.jsonl) with the same reader as the web client's full history. Works for
// sessions started anywhere (phone, desktop, terminal). The phone shows text only: your messages, and everything
// Claude wrote, in order; tool calls and thinking are left out.
import { sessionFile } from "./catalog.js";
import { readHistoryPage } from "./transcript.js";
import type { HistoryEntry } from "@claude-anywhere/protocol";

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

const MAX_TEXT = 20_000;
/** Enough pages for the longest conversations without reading a huge transcript end to end for nothing. */
const MAX_PAGES = 80;

/** The last `limitTurns` turns: each of your messages, then every piece of text Claude wrote for it. */
export function loadHistory(claudeSessionId: string, limitTurns = 150): HistoryItem[] {
  const file = sessionFile(claudeSessionId);
  if (!file) return [];
  // Pages come newest first; keep reading back until enough of your messages are covered.
  const pages: HistoryEntry[][] = [];
  let users = 0;
  let cursor: number | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = readHistoryPage(file, { cursor });
    pages.unshift(page.entries);
    users += page.entries.filter((e) => e.kind === "user").length;
    if (users >= limitTurns || page.cursor === null) break;
    cursor = page.cursor;
  }
  const items: HistoryItem[] = [];
  for (const e of pages.flat()) {
    if (e.kind === "user") {
      const attached = e.attachments?.length ? `(attached: ${e.attachments.map((a) => a.name).join(", ")})` : "";
      const text = [e.text, attached].filter(Boolean).join("\n");
      if (text) items.push({ role: "user", text: text.slice(0, MAX_TEXT), ts: e.ts });
    } else if (e.kind === "text") {
      items.push({ role: "assistant", text: e.text.slice(0, MAX_TEXT), ts: e.ts });
    }
  }
  // Start at the limitTurns-th of your messages from the end.
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "user" && ++seen === limitTurns) return items.slice(i);
  }
  return items;
}
