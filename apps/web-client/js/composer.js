// Composer helpers with no DOM: what's being typed at the caret (an @-mention or a /command), inserting the chosen
// suggestion, and ranking commands. Claude Code itself expands "@path" mentions and runs "/name" commands.

/**
 * The mention or command being typed just before the caret.
 * @returns {{ kind: "file" | "command", query: string, start: number } | null}
 */
export function tokenAt(text, caret) {
  const before = String(text ?? "").slice(0, caret);
  // A command only at the very start of the message, before any space.
  const cmd = /^\/([\w:.-]*)$/.exec(before);
  if (cmd) return { kind: "command", query: cmd[1], start: 0 };
  // @word or @"words with spaces, after a space or at the start.
  const file = /(^|\s)@("[^"]*|[^\s@"]*)$/.exec(before);
  if (file) return { kind: "file", query: file[2].replace(/^"/, ""), start: before.length - file[2].length - 1 };
  return null;
}

/** Put the chosen file or command in place of what was typed. Returns the new text and caret position. */
export function applySuggestion(text, caret, token, value) {
  const s = String(text ?? "");
  const insert = token.kind === "command" ? `/${value} ` : /\s/.test(value) ? `@"${value}" ` : `@${value} `;
  const after = s.slice(caret).replace(/^\S*/, ""); // the rest of a word being replaced
  const next = s.slice(0, token.start) + insert + after.replace(/^\s/, "");
  return { text: next, caret: token.start + insert.length };
}

/** Commands whose name starts with the query first, then ones that contain it; skills are labelled. */
export function rankCommands(commands, query, limit = 40) {
  const q = String(query ?? "").toLowerCase();
  const list = Array.isArray(commands) ? commands : [];
  const starts = [];
  const contains = [];
  for (const c of list) {
    const name = String(c.name).toLowerCase();
    // Plugin skills are "plugin:skill": match the part after the colon too.
    const short = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    if (!q || name.startsWith(q) || short.startsWith(q)) starts.push(c);
    else if (name.includes(q)) contains.push(c);
  }
  const byName = (a, b) => Number(a.skill) - Number(b.skill) || a.name.length - b.name.length || a.name.localeCompare(b.name);
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, limit);
}

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatSize(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} bytes`;
}
