// Markdown to a plain tree, rendered by view.js with createElement/textContent only (never innerHTML), so a reply
// can't inject markup or script. Covers what Claude writes: headings, paragraphs, lists (nested), code blocks,
// inline code, bold, italic, strikethrough, links, tables, quotes and rules.

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_HREF = /^(https?:|mailto:)/i;

/** @returns {Array<object>} block nodes */
export function parse(src) {
  return blocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text)
      out.push({ t: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) { out.push({ t: "h", level: h[1].length, inl: inline(h[2]) }); i++; continue; }

    if (RULE.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(QUOTE, ""));
      out.push({ t: "quote", blocks: blocks(body) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]).map(inline));
      out.push({ t: "table", head: head.map(inline), align, rows });
      continue;
    }

    const li = LIST.exec(line);
    if (li) {
      const baseIndent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items = [];
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST.exec(l);
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          cur = [m[3]];
          items.push(cur);
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless the next line is indented (continuation) or another item.
          const next = lines[i + 1] ?? "";
          const nm = LIST.exec(next);
          if (next.trim() && ((/^\s{2,}/.test(next) && !(nm && nm[1].length <= baseIndent + 1)) || (nm && nm[1].length <= baseIndent + 1 && /\d/.test(nm[2]) === ordered))) {
            cur?.push("");
            i++;
            continue;
          }
          break;
        }
        if (/^\s+/.test(l) && l.search(/\S/) > baseIndent) {
          cur?.push(l.replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ""));
          i++;
          continue;
        }
        if (m || startsBlock(l)) break;
        cur?.push(l); // lazy continuation of the item's paragraph
        i++;
      }
      out.push({ t: "list", ordered, start, items: items.map((it) => blocks(it)) });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes("|") && TABLE_RULE.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-"))) {
      para.push(lines[i++]);
    }
    if (para.length === 0) para.push(lines[i++]); // safety: always advance
    out.push({ t: "p", inl: inline(para.join("\n")) });
  }
  return out;
}

/** @returns {Array<object>} inline nodes */
export function inline(src) {
  const s = String(src ?? "");
  const out = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);

    if (c === "\\" && i + 1 < s.length && /[\\`*_{}\[\]()#+\-.!|~>]/.test(s[i + 1])) { text += s[i + 1]; i += 2; continue; }

    if (c === "`") {
      const run = /^`+/.exec(rest)[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ t: "code", v: s.slice(i + run.length, end).replace(/^ (.*) $/, "$1") });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (c === "\n") { flush(); out.push({ t: "br" }); i++; continue; }

    if (rest.startsWith("~~")) {
      const end = s.indexOf("~~", i + 2);
      if (end > i + 2) { flush(); out.push({ t: "s", c: inline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }

    if (rest.startsWith("**") || rest.startsWith("__")) {
      const d = rest.slice(0, 2);
      const end = s.indexOf(d, i + 2);
      if (end > i + 2 && (d === "**" || !/\w/.test(s[i - 1] ?? ""))) { flush(); out.push({ t: "b", c: inline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }

    if ((c === "*" || c === "_") && s[i + 1] && s[i + 1] !== " " && s[i + 1] !== c) {
      // Underscores only as emphasis at word edges (not in snake_case names).
      if (c === "*" || !/\w/.test(s[i - 1] ?? "")) {
        let end = i + 1;
        while ((end = s.indexOf(c, end)) > 0 && (s[end - 1] === " " || s[end + 1] === c || (c === "_" && /\w/.test(s[end + 1] ?? "")))) end++;
        if (end > i + 1) { flush(); out.push({ t: "i", c: inline(s.slice(i + 1, end)) }); i = end + 1; continue; }
      }
    }

    if (c === "[") {
      const m = /^\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (m) {
        flush();
        if (SAFE_HREF.test(m[2])) out.push({ t: "a", href: m[2], c: inline(m[1] || m[2]) });
        else out.push(...inline(m[1] || m[2]));
        i += m[0].length;
        continue;
      }
    }

    const auto = /^https?:\/\/[^\s<>"'`]+/.exec(rest);
    if (auto && !/\w/.test(s[i - 1] ?? "")) {
      let url = auto[0];
      while (/[.,;:!?)\]]$/.test(url) && !(url.endsWith(")") && url.split("(").length > url.split(")").length - 1)) url = url.slice(0, -1);
      flush();
      out.push({ t: "a", href: url, c: [{ t: "text", v: url }] });
      i += url.length;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

/** Plain text of inline nodes (for titles and tests). */
export function plain(nodes) {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : n.c ? plain(n.c) : "")).join("");
}
