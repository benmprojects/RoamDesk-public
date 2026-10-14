// Line diff for showing file edits: longest common subsequence, with a plain fallback for very large inputs.

const MAX_CELLS = 4_000_000;

/**
 * @param {string} before
 * @param {string} after
 * @returns {{ lines: Array<{ op: " " | "+" | "-", text: string }>, added: number, removed: number }}
 */
export function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  // Common start and end are cheap to strip and keep the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const lines = a.slice(0, start).map((text) => ({ op: " ", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    lines.push(...midA.map((text) => ({ op: "-", text })), ...midB.map((text) => ({ op: "+", text })));
  } else {
    lines.push(...lcs(midA, midB));
  }
  lines.push(...a.slice(endA).map((text) => ({ op: " ", text })));
  return { lines, added: lines.filter((l) => l.op === "+").length, removed: lines.filter((l) => l.op === "-").length };
}

/** Keep only changed lines and `context` lines around them; gaps become a single "…" line. */
export function withContext(lines, context = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: "…", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

/**
 * A git unified diff as lines for the diff view: headers dropped, each hunk's "@@ … @@" shown as a gap marker
 * (with the function name git puts after it, if any).
 */
export function parseUnified(text) {
  const out = [];
  let inHunk = false;
  for (const raw of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
      out.push({ op: "…", text: m ? `line ${m[2]}${m[3] ? ` · ${m[3]}` : ""}` : raw.replace(/^@@\s*|\s*@@$/g, "") });
      continue;
    }
    if (!inHunk) continue; // diff --git, index, ---, +++, mode lines
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) out.push({ op: "+", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ op: "-", text: raw.slice(1) });
    else if (raw.startsWith(" ")) out.push({ op: " ", text: raw.slice(1) });
    else if (raw.startsWith("diff --git ")) inHunk = false;
  }
  return out;
}

function splitLines(s) {
  const t = String(s ?? "").replace(/\r\n?/g, "\n");
  if (t === "") return [];
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
}

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:], stored flat.
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}
