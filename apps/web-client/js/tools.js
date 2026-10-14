// One-line summaries of Claude's tool calls for the conversation, and which calls show a file diff.
import { lineDiff } from "./diff.js";

const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
const first = (s, n = 90) => {
  const line = String(s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** Friendly label for mcp__server__action names: "Microsoft 365: outlook email search". */
function mcpLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const server = m[1].replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "").replace(/_/g, " ");
  return { title: server.charAt(0).toUpperCase() + server.slice(1), detail: m[2].replace(/_/g, " ") };
}

/**
 * @returns {{ title: string, detail: string }}
 */
export function summarise(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Read": return { title: "Read", detail: base(i.file_path) + (i.offset ? ` (from line ${i.offset})` : "") };
    case "Write": return { title: "Write", detail: base(i.file_path) };
    case "Edit": return { title: "Edit", detail: base(i.file_path) };
    case "MultiEdit": return { title: "Edit", detail: `${base(i.file_path)} (${(i.edits ?? []).length} changes)` };
    case "NotebookEdit": return { title: "Edit notebook", detail: base(i.notebook_path) };
    case "PowerShell":
    case "Bash": return { title: name, detail: i.description ? first(i.description) : first(i.command) };
    case "Grep": return { title: "Search", detail: `${first(i.pattern, 60)}${i.path ? ` in ${base(i.path)}` : ""}` };
    case "Glob": return { title: "Find files", detail: first(i.pattern, 80) };
    case "WebFetch": return { title: "Fetch", detail: first(i.url, 100) };
    case "WebSearch": return { title: "Web search", detail: first(i.query, 100) };
    case "Task":
    case "Agent": return { title: "Agent", detail: first(i.description ?? i.prompt, 90) };
    case "ToolSearch": return { title: "Find tools", detail: first(i.query, 80) };
    case "Skill": return { title: "Skill", detail: first(i.skill ?? i.name, 80) };
    case "TaskCreate": return { title: "Task", detail: first(i.subject ?? i.title ?? i.description ?? i.content, 90) };
    case "TaskUpdate": return { title: "Task update", detail: first(i.status ? `${i.status}${i.subject ? `: ${i.subject}` : ""}` : i.subject ?? i.taskId ?? "", 90) };
    case "TaskList":
    case "TaskGet": return { title: "Tasks", detail: "" };
    case "mcp__phone__send_file": return { title: "Send file", detail: base(i.file_path ?? i.path) };
    case "mcp__phone__ask_user": return { title: "Question", detail: first(i.questions?.[0]?.question, 90) };
    default: {
      const m = mcpLabel(name);
      if (m) return m;
      const d = i.description ?? i.query ?? i.file_path ?? i.path ?? i.url ?? i.command ?? "";
      return { title: name, detail: first(typeof d === "string" ? d : JSON.stringify(d), 90) };
    }
  }
}

/**
 * The change a file-editing call makes, for a diff view. Null for other tools.
 * @returns {{ file: string, lines: Array<{op: string, text: string}>, added: number, removed: number, created: boolean } | null}
 */
export function editDiff(name, input) {
  const i = input && typeof input === "object" ? input : {};
  if (name === "Edit") return { file: i.file_path, created: false, ...lineDiff(i.old_string ?? "", i.new_string ?? "") };
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    const parts = i.edits.map((e) => lineDiff(e.old_string ?? "", e.new_string ?? ""));
    const lines = parts.flatMap((p, k) => (k ? [{ op: "…", text: "next change" }, ...p.lines] : p.lines));
    return { file: i.file_path, created: false, lines, added: parts.reduce((a, p) => a + p.added, 0), removed: parts.reduce((a, p) => a + p.removed, 0) };
  }
  if (name === "Write") return { file: i.file_path, created: true, ...lineDiff("", i.content ?? "") };
  return null;
}

/** The command or main argument shown inside an expanded tool card. */
export function mainArgument(name, input) {
  const i = input && typeof input === "object" ? input : {};
  if (name === "PowerShell" || name === "Bash") return { label: "Command", text: String(i.command ?? ""), code: true };
  if (name === "WebFetch") return { label: "Address", text: String(i.url ?? ""), code: false };
  if (name === "WebSearch") return { label: "Search", text: String(i.query ?? ""), code: false };
  if (name === "Grep") return { label: "Pattern", text: String(i.pattern ?? ""), code: true };
  if (name === "Read") return { label: "File", text: String(i.file_path ?? ""), code: false };
  return null;
}

export const MODEL_NAMES = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-haiku-4-5": "Haiku 4.5",
};
export const modelName = (id) => MODEL_NAMES[id] ?? String(id ?? "").replace(/^claude-/, "");

export const MODES = [
  { id: "default", label: "Ask", hint: "Routine steps run; risky ones ask you first." },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits run without asking; other risky steps still ask." },
  { id: "plan", label: "Plan", hint: "Claude plans without changing anything, then asks you to approve the plan." },
  { id: "bypassPermissions", label: "Bypass permissions", hint: "Everything runs without asking, including normally blocked steps." },
];
