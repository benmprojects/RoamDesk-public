// Rendering: conversation entries, markdown, tool cards, approvals, questions, plans and the session list.
// Every piece of text from Claude, tools or the PC is set with textContent; nothing is parsed as HTML.
import { h, clear } from "./dom.js";
import { parse } from "./markdown.js";
import { withContext } from "./diff.js";
import { editDiff, mainArgument, modelName, summarise } from "./tools.js";
import { formatSize } from "./composer.js";

// ---------------------------------------------------------------- markdown

export function markdown(text, live = false) {
  const root = h("div", { class: `md${live ? " live" : ""}` });
  for (const b of parse(text)) root.append(block(b));
  return root;
}

function block(b) {
  switch (b.t) {
    case "h": return h(`h${Math.min(4, b.level)}`, null, inlines(b.inl));
    case "p": return h("p", null, inlines(b.inl));
    case "hr": return h("hr");
    case "quote": return h("blockquote", null, b.blocks.map(block));
    case "code": return codeBlock(b.text, b.lang);
    case "list": {
      const el = h(b.ordered ? "ol" : "ul", b.ordered && b.start !== 1 ? { start: b.start } : null);
      for (const item of b.items) {
        // A single short paragraph in an item renders without a <p> (tighter, like the desktop app).
        const li = h("li");
        if (item.length === 1 && item[0].t === "p") li.append(inlines(item[0].inl));
        else item.forEach((x) => li.append(block(x)));
        el.append(li);
      }
      return el;
    }
    case "table": {
      const t = h("table");
      t.append(h("thead", null, h("tr", null, b.head.map((c, i) => h("th", { style: b.align[i] ? `text-align:${b.align[i]}` : null }, inlines(c))))));
      t.append(h("tbody", null, b.rows.map((r) => h("tr", null, r.map((c, i) => h("td", { style: b.align[i] ? `text-align:${b.align[i]}` : null }, inlines(c)))))));
      return t;
    }
    default: return h("p", null, "");
  }
}

function inlines(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    switch (n.t) {
      case "text": frag.append(n.v); break;
      case "code": frag.append(h("code", null, n.v)); break;
      case "b": frag.append(h("strong", null, inlines(n.c))); break;
      case "i": frag.append(h("em", null, inlines(n.c))); break;
      case "s": frag.append(h("del", null, inlines(n.c))); break;
      case "br": frag.append(h("br")); break;
      case "a": frag.append(h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer" }, inlines(n.c))); break;
      default: break;
    }
  }
  return frag;
}

export function codeBlock(text, lang = "") {
  const copy = h("button", { type: "button", title: "Copy" }, "Copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    } catch {
      copy.textContent = "Couldn't copy";
    }
  });
  return h("div", { class: "codeblock" }, h("div", { class: "cb-head" }, h("span", null, lang || "text"), copy), h("pre", null, h("code", null, text)));
}

export function diffView(d, maxLines = 400) {
  const lines = withContext(d.lines, 3);
  const box = h("div", { class: "diff" });
  for (const l of lines.slice(0, maxLines)) {
    const cls = l.op === "+" ? "add" : l.op === "-" ? "del" : l.op === "…" ? "gap" : "";
    box.append(h("div", { class: cls }, l.op === "…" ? `⋯ ${l.text}` : `${l.op === " " ? " " : l.op} ${l.text}`));
  }
  if (lines.length > maxLines) box.append(h("div", { class: "gap" }, `⋯ ${lines.length - maxLines} more lines`));
  return box;
}

// ---------------------------------------------------------------- entries

const relTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

function approvalPanel(a, onAnswer) {
  const box = h("div", { class: "approval" });
  if (a.state === "pending") {
    box.append(h("div", { class: "a-title" }, `Allow: ${a.summary || "this step"}?`));
    const d = a.tool ? editDiff(a.tool, a.input) : null;
    if (d) box.append(diffView(d, 120));
    else if (a.command) box.append(h("pre", null, a.command));
    const allow = h("button", { class: "primary", type: "button" }, "Allow");
    const deny = h("button", { type: "button" }, "Deny");
    allow.addEventListener("click", () => onAnswer(a.confirmId, true));
    deny.addEventListener("click", () => onAnswer(a.confirmId, false));
    box.append(h("div", { class: "row" }, allow, deny, h("span", { class: "muted small" }, `Waits ${relTime(a.expiresAt - Date.now())}, then counts as no`)));
  } else {
    const word = { allowed: "Allowed", denied: "Denied", expired: "Not answered in time, so it wasn't run", sending: "Sending…" }[a.state] ?? a.state;
    box.append(h("div", { class: "done" }, `${word}: ${a.summary || "this step"}`));
  }
  return box;
}

function toolCard(e, ctx) {
  const s = summarise(e.name, e.input);
  const d = editDiff(e.name, e.input);
  const icon = !e.result ? (e.approval?.state === "pending" ? "!" : "◌") : e.result.isError ? "✕" : "✓";
  const iconCls = !e.result ? "" : e.result.isError ? "bad" : "ok";
  const summary = h(
    "summary",
    null,
    h("span", { class: `t-icon ${iconCls}` }, icon),
    h("span", { class: "t-name" }, s.title),
    h("span", { class: "t-detail", title: s.detail }, s.detail),
    d ? h("span", { class: "t-count" }, h("span", { class: "a" }, `+${d.added}`), " ", h("span", { class: "r" }, `−${d.removed}`)) : null,
  );
  const body = h("div", { class: "t-body" });
  const arg = mainArgument(e.name, e.input);
  if (arg && arg.text) body.append(h("div", { class: "t-label" }, arg.label), arg.code ? h("pre", { class: "out" }, arg.text) : h("div", null, arg.text));
  if (d) body.append(h("div", { class: "diff-file" }, d.file ?? ""), diffView(d));
  const filePath = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(e.name) ? e.input?.file_path ?? e.input?.notebook_path : null;
  if (filePath && ctx.onOpenFile) {
    const open = h("button", { type: "button", class: "open-file" }, "Open file");
    open.addEventListener("click", () => ctx.onOpenFile(String(filePath)));
    body.append(open);
  }
  if (!arg && !d) body.append(h("div", { class: "t-label" }, "Input"), h("pre", { class: "out" }, JSON.stringify(e.input ?? {}, null, 2)));
  if (e.result) {
    body.append(h("div", { class: "t-label" }, e.result.isError ? "Error" : "Result"));
    body.append(h("pre", { class: `out${e.result.isError ? " err" : ""}` }, e.result.output || "(no output)"));
    if (e.result.truncated) body.append(h("div", { class: "muted small" }, "Only the start of the output is shown."));
  }
  const det = h("details", { class: "tool" }, summary, body);
  // The approval sits under the card, always visible (not inside the collapsed details).
  if (!e.approval) return det;
  return h("div", { class: `tool-wrap${e.approval.state === "pending" ? " asking" : ""}` }, det, approvalPanel(e.approval, ctx.onApprove));
}

function askCard(e, ctx) {
  const card = h("div", { class: "card" });
  card.append(h("div", { class: "c-title" }, "Claude has a question"));
  if (e.state !== "pending") {
    const word = { answered: "Answered.", skipped: "Skipped.", expired: "No longer waiting for an answer.", sending: "Sending…" }[e.state] ?? e.state;
    for (const q of e.questions) card.append(h("div", null, q.question));
    if (e.answers) for (const [q, a] of Object.entries(e.answers)) card.append(h("div", { class: "muted small" }, `${q} → ${a}`));
    card.append(h("div", { class: "muted small" }, word));
    return card;
  }
  /** question index -> Set of chosen labels; and free text */
  const chosen = e.questions.map(() => new Set());
  const other = e.questions.map(() => "");
  const submit = h("button", { class: "primary", type: "button", disabled: true }, "Send answers");
  const ready = () => e.questions.every((_, i) => chosen[i].size > 0 || other[i].trim());
  e.questions.forEach((q, i) => {
    const opts = h("div", { class: "ask-opts" });
    for (const o of q.options) {
      const b = h("button", { type: "button" }, h("span", null, o.label), o.description ? h("span", { class: "o-desc" }, o.description) : null);
      b.addEventListener("click", () => {
        if (!q.multiSelect) {
          chosen[i].clear();
          opts.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
        }
        if (chosen[i].has(o.label)) {
          chosen[i].delete(o.label);
          b.classList.remove("sel");
        } else {
          chosen[i].add(o.label);
          b.classList.add("sel");
        }
        submit.disabled = !ready();
      });
      opts.append(b);
    }
    const otherIn = h("input", { placeholder: "Or type your own answer", maxlength: 1000 });
    otherIn.addEventListener("input", () => {
      other[i] = otherIn.value;
      submit.disabled = !ready();
    });
    card.append(h("div", { class: "ask-q" }, q.header ? h("div", { class: "q-head" }, q.header) : null, h("div", null, q.question), opts, otherIn));
  });
  const skip = h("button", { type: "button" }, "Skip");
  submit.addEventListener("click", () => {
    const answers = {};
    e.questions.forEach((q, i) => {
      const parts = [...chosen[i]];
      if (other[i].trim()) parts.push(other[i].trim());
      answers[q.question] = parts.join(", ");
    });
    ctx.onAnswer(e, answers);
  });
  skip.addEventListener("click", () => ctx.onAnswer(e, null));
  card.append(h("div", { class: "row" }, submit, skip, h("span", { class: "muted small" }, `Waits ${relTime(e.expiresAt - Date.now())}`)));
  return card;
}

function planCard(e, ctx) {
  const card = h("div", { class: "card" });
  card.append(h("div", { class: "c-title" }, "Plan"));
  card.append(h("div", { class: "plan-body" }, markdown(e.text)));
  if (ctx.mode === "plan" && !e.decided && ctx.isLatestPlan(e)) {
    const yesEdits = h("button", { class: "primary", type: "button" }, "Approve and accept edits");
    const yesAsk = h("button", { type: "button" }, "Approve, ask before risky steps");
    const keep = h("button", { type: "button" }, "Keep planning");
    yesEdits.addEventListener("click", () => ctx.onPlan(e, "acceptEdits"));
    yesAsk.addEventListener("click", () => ctx.onPlan(e, "default"));
    keep.addEventListener("click", () => ctx.onPlan(e, null));
    card.append(h("div", { class: "row wrap" }, yesEdits, yesAsk, keep));
  } else if (e.decided) {
    card.append(h("div", { class: "muted small" }, e.decided));
  }
  return card;
}

function fileCard(e, ctx) {
  const kb = Math.max(1, Math.round(e.size / 1024));
  const btn = h("button", { type: "button", class: "primary" }, "Download");
  btn.addEventListener("click", () => ctx.onDownload(e, btn));
  const expired = e.expiresAt && e.expiresAt < Date.now();
  return h(
    "div",
    { class: "card file-card" },
    h("div", { style: "flex:1;min-width:0" }, h("div", { class: "f-name" }, e.name), h("div", { class: "muted small" }, `${kb.toLocaleString("en-AU")} KB${e.caption ? ` · ${e.caption}` : ""}`)),
    expired ? h("span", { class: "muted small" }, "Expired") : btn,
  );
}

/** An attachment on a sent message: the picture if this browser has it, otherwise its name. */
function attachmentView(a) {
  if (a.url && a.kind === "image") return h("img", { src: a.url, alt: a.name, title: a.name });
  return h(
    "span",
    { class: "chip-att", title: a.path ?? a.name },
    h("span", { class: "a-icon", "aria-hidden": "true" }, a.kind === "image" ? "🖼" : "📄"),
    h("span", null, h("div", { class: "a-name" }, a.name), a.size ? h("div", { class: "a-meta" }, formatSize(a.size)) : null),
  );
}

export function renderEntry(e, ctx) {
  switch (e.kind) {
    case "user":
      return h(
        "div",
        { class: `msg-user${e.pending ? " pending" : ""}` },
        e.text,
        e.attachments?.length ? h("div", { class: "atts" }, e.attachments.map(attachmentView)) : null,
        e.pending ? h("span", { class: "chip" }, "Queued") : e.origin === "phone" ? h("span", { class: "chip" }, "From the phone") : null,
      );
    case "text":
      return markdown(e.text, e.live);
    case "thinking":
      return h("details", { class: "thinking" }, h("summary", null, "Thinking"), h("div", null, e.text));
    case "tool":
      return toolCard(e, ctx);
    case "approval":
      return approvalPanel(e, ctx.onApprove);
    case "ask":
      return askCard(e, ctx);
    case "plan":
      return planCard(e, ctx);
    case "file":
      return fileCard(e, ctx);
    case "error":
      return h("div", { class: "err-box" }, e.text);
    default:
      return h("div", { class: "note" }, e.text);
  }
}

/** Keeps the conversation's DOM in step with the entries, redrawing only entries whose version changed. */
export class ConversationView {
  constructor(container, scroller) {
    this.el = container;
    this.scroller = scroller;
    this.cache = new Map(); // entry id -> { key, node }
    this.sessionId = null;
    this.firstId = undefined;
  }

  render(sessionId, entries, ctx) {
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    // Older messages added above shouldn't move what you're reading.
    const fromBottom = this.scroller.scrollHeight - this.scroller.scrollTop;
    const prepended = sessionId === this.sessionId && entries.length > 0 && this.firstId !== undefined && entries[0].id !== this.firstId;
    if (sessionId !== this.sessionId) {
      this.cache.clear();
      clear(this.el);
      this.sessionId = sessionId;
    }
    this.firstId = entries[0]?.id;
    const seen = new Set();
    let prev = null;
    for (const e of entries) {
      seen.add(e.id);
      const key = `${e.v}|${e.kind === "plan" ? `${ctx.mode}|${ctx.isLatestPlan(e)}` : ""}`;
      let c = this.cache.get(e.id);
      if (!c || c.key !== key) {
        const node = renderEntry(e, ctx);
        if (c) {
          // Keep expanded tool cards expanded when they update.
          const oldDetails = [...c.node.querySelectorAll?.("details") ?? [], ...(c.node.tagName === "DETAILS" ? [c.node] : [])];
          const newDetails = [...node.querySelectorAll?.("details") ?? [], ...(node.tagName === "DETAILS" ? [node] : [])];
          oldDetails.forEach((d, i) => d.open && newDetails[i] && (newDetails[i].open = true));
          c.node.replaceWith(node);
        }
        c = { key, node };
        this.cache.set(e.id, c);
      }
      const want = prev ? prev.nextSibling : this.el.firstChild;
      if (want !== c.node) this.el.insertBefore(c.node, want);
      prev = c.node;
    }
    for (const [id, c] of this.cache) {
      if (!seen.has(id)) {
        c.node.remove();
        this.cache.delete(id);
      }
    }
    if (atBottom || ctx.forceScroll) this.scroller.scrollTop = this.scroller.scrollHeight;
    else if (prepended) this.scroller.scrollTop = this.scroller.scrollHeight - fromBottom;
  }
}

// ---------------------------------------------------------------- session list

export function renderSessions(list, sessions, activeId, unread, onSelect) {
  clear(list);
  for (const s of sessions) {
    const sub = [s.busy ? "Working…" : null, s.queued ? `${s.queued} queued` : null, s.surface === "voice" ? "voice" : null, modelName(s.model)].filter(Boolean).join(" · ");
    const btn = h(
      "button",
      { type: "button", "aria-current": s.id === activeId ? "true" : null },
      h("span", { class: "s-name" }, s.name),
      h("span", { class: "badge" }, s.busy ? h("span", { class: "spin", "aria-label": "working" }, "◌") : null, unread.has(s.id) ? h("span", { class: "unread", "aria-label": "new" }) : null),
      h("span", { class: "s-sub", title: s.cwd }, sub),
    );
    btn.addEventListener("click", () => onSelect(s.id));
    list.append(h("li", { class: s.id === activeId ? "active" : "" }, btn));
  }
}
