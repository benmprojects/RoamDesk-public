// The full conversation of a Claude Code session, read backwards a page at a time from its transcript
// (~/.claude/projects/<project>/<id>.jsonl) so even very long sessions open quickly. Each page is what the web client
// shows: your messages (with attachments), Claude's replies, thinking, tool calls and results, and compactions.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { HistoryEntry } from "@claude-anywhere/protocol";
import { MAX_OUTPUT_CHARS, trimInput } from "./stream.js";

const CHUNK = 1024 * 1024;
/** A page stops after this many entries, at the start of one of your messages. */
const PAGE_ENTRIES = 150;
/** And never reads more than this much of the file for one page. */
const MAX_SCAN_BYTES = 24 * 1024 * 1024;
const MAX_TEXT = 100_000;

// Text Claude Code adds around what you typed, which isn't part of the conversation as you see it.
const INJECTED = /<(system-reminder|local-command-stdout|local-command-stderr|command-message|command-args|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const FILES_NOTE = /\n\nAttached files \(saved on this PC[^\n]*\n((?:- [^\n]*\n?)*)$/;

function userText(raw: string): string {
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(raw);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
    return `${cmd[1].startsWith("/") ? cmd[1] : `/${cmd[1]}`}${args ? ` ${args}` : ""}`;
  }
  return raw.replace(INJECTED, "").trim();
}

function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
}

/** Pictures pasted into a message come back inline (as a data URL) up to this size each, and this much per page. */
const MAX_INLINE_IMAGE = 2 * 1024 * 1024;
const MAX_PAGE_IMAGES = 12 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

function inlineImage(b: any, budget: { left: number }): string | undefined {
  const s = b?.source;
  if (s?.type !== "base64" || typeof s.data !== "string" || !IMAGE_TYPES.test(String(s.media_type))) return undefined;
  if (s.data.length > MAX_INLINE_IMAGE || s.data.length > budget.left) return undefined;
  budget.left -= s.data.length;
  return `data:${s.media_type};base64,${s.data}`;
}

/** The entries one transcript record contributes, in order. */
export function recordEntries(rec: any, budget: { left: number } = { left: MAX_PAGE_IMAGES }): HistoryEntry[] {
  const ts = Math.floor(Date.parse(rec?.timestamp ?? "")) || 0;
  const uuid = String(rec?.uuid ?? "");
  if (!rec || rec.isSidechain) return [];

  if (rec.type === "system" && rec.subtype === "compact_boundary") {
    const m = rec.compactMetadata ?? {};
    const detail = m.preTokens && m.postTokens ? ` (${Number(m.preTokens).toLocaleString("en-AU")} → ${Number(m.postTokens).toLocaleString("en-AU")} tokens)` : "";
    return [{ kind: "note", id: `h:${uuid}`, text: `Conversation compacted${m.trigger === "auto" ? " automatically" : ""}${detail}.`, ts }];
  }

  if (rec.type === "user") {
    if (rec.isMeta || rec.isCompactSummary) return [];
    const content = rec.message?.content;
    const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const out: HistoryEntry[] = [];
    const texts: string[] = [];
    const attachments: { name: string; kind: "image" | "file"; url?: string }[] = [];
    blocks.forEach((b, i) => {
      if (b?.type === "tool_result") {
        const full = outputText(b.content);
        out.push({ kind: "tool_result", id: `h:${uuid}:${i}`, toolUseId: String(b.tool_use_id), output: full.slice(0, MAX_OUTPUT_CHARS), isError: b.is_error === true, truncated: full.length > MAX_OUTPUT_CHARS, ts });
      } else if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b?.type === "image") {
        const url = inlineImage(b, budget);
        attachments.push({ name: "picture", kind: "image", ...(url ? { url } : {}) });
      }
    });
    let text = userText(texts.join("\n"));
    const files = FILES_NOTE.exec(text);
    if (files) {
      text = text.slice(0, files.index).trim();
      for (const line of files[1].split("\n")) {
        const m = /^- (.+?): (.+)$/.exec(line.trim());
        if (m) attachments.push({ name: m[1], kind: "file" });
      }
    }
    if ((text && !text.startsWith("[Request interrupted")) || attachments.length) {
      out.unshift({ kind: "user", id: `h:${uuid}`, text: text.slice(0, MAX_TEXT), ts, ...(attachments.length ? { attachments } : {}) });
    } else if (text.startsWith("[Request interrupted")) {
      out.push({ kind: "note", id: `h:${uuid}`, text: "Stopped.", ts });
    }
    return out;
  }

  if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
    const out: HistoryEntry[] = [];
    rec.message.content.forEach((b: any, i: number) => {
      const id = `h:${uuid}:${i}`;
      if (b?.type === "text" && String(b.text ?? "").trim()) out.push({ kind: "text", id, text: String(b.text).slice(0, MAX_TEXT), ts });
      else if (b?.type === "thinking" && String(b.thinking ?? "").trim()) out.push({ kind: "thinking", id, text: String(b.thinking).slice(0, MAX_TEXT), ts });
      else if (b?.type === "tool_use") out.push({ kind: "tool_use", id: String(b.id), name: String(b.name), input: trimInput(b.input), ts });
    });
    return out;
  }
  return [];
}

/**
 * One page of history, newest last, ending just before `cursor` (a byte offset; omit for the end of the file).
 * `beforeTs` skips records from that time on (what the page already shows live). The returned cursor is where the
 * next, older page ends; null when the start of the conversation has been reached.
 */
export function readHistoryPage(file: string, opts: { cursor?: number; beforeTs?: number; pageEntries?: number } = {}): { entries: HistoryEntry[]; cursor: number | null } {
  const size = statSync(file).size;
  const want = opts.pageEntries ?? PAGE_ENTRIES;
  let end = Math.min(opts.cursor ?? size, size);
  const fd = openSync(file, "r");
  const pages: HistoryEntry[][] = []; // per record, newest first
  let count = 0;
  let scanned = 0;
  const budget = { left: MAX_PAGE_IMAGES };
  let carry = Buffer.alloc(0); // the start of a line whose beginning is in an earlier chunk
  let lineStart = end; // byte offset of the earliest complete line handled
  try {
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      scanned += buf.length;
      let data = Buffer.concat([buf, carry]);
      // Lines are complete except the first one, unless this chunk starts the file.
      let firstNl = start === 0 ? -1 : data.indexOf(0x0a);
      if (start > 0 && firstNl < 0) {
        carry = data;
        end = start;
        continue;
      }
      carry = start === 0 ? Buffer.alloc(0) : data.subarray(0, firstNl + 1);
      const body = start === 0 ? data : data.subarray(firstNl + 1);
      const bodyOffset = start === 0 ? 0 : start + firstNl + 1;
      const lines = body.toString("utf8").split("\n");
      // Walk lines newest first, tracking each line's byte offset for the cursor.
      const offsets: number[] = [];
      let off = bodyOffset;
      for (const l of lines) {
        offsets.push(off);
        off += Buffer.byteLength(l, "utf8") + 1;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("{")) {
          lineStart = offsets[i];
          continue;
        }
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          lineStart = offsets[i];
          continue;
        }
        if (opts.beforeTs && (Math.floor(Date.parse(rec.timestamp ?? "")) || 0) >= opts.beforeTs) {
          lineStart = offsets[i];
          continue;
        }
        const entries = recordEntries(rec, budget);
        lineStart = offsets[i];
        if (entries.length) {
          pages.push(entries);
          count += entries.length;
        }
        // Once the page is full, stop at the next of your messages going back, so the page starts with it.
        if (count >= want && entries[0]?.kind === "user") return { entries: pages.reverse().flat(), cursor: lineStart > 0 ? lineStart : null };
      }
      end = start;
      if (scanned >= MAX_SCAN_BYTES && count > 0) return { entries: pages.reverse().flat(), cursor: lineStart > 0 ? lineStart : null };
    }
  } finally {
    closeSync(fd);
  }
  return { entries: pages.reverse().flat(), cursor: null };
}
