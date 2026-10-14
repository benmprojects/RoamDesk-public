// The workspace pane beside the conversation: Terminal (the commands Claude ran and their output, read-only),
// Changes (what changed in the session's folder, from git, with diffs) and Files (open a file read-only).
import { clear, h } from "./dom.js";
import { parseUnified } from "./diff.js";
import { formatSize } from "./composer.js";
import { editDiff } from "./tools.js";
import { diffView, markdown } from "./view.js";

const SHELLS = new Set(["PowerShell", "Bash"]);
const EDITS = new Set(["Edit", "Write", "MultiEdit"]);
const STATUS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "?": "New" };

export class Panes {
  /**
   * @param {{ app: HTMLElement, pane: HTMLElement, body: HTMLElement, store: any, send: (type: string, payload: object) => boolean, toast: (t: string) => void }} o
   */
  constructor(o) {
    this.o = o;
    this.which = null; // "terminal" | "changes" | "files" | null
    this.key = ""; // what the pane last drew, so it only redraws when that changes
    this.query = "";
    this.searchTimer = null;
    this.showSource = false;
    this.openDiffs = new Set();
  }

  get state() {
    return this.o.store.state;
  }

  open(which) {
    this.which = which;
    this.o.pane.hidden = false;
    this.o.app.classList.add("with-pane");
    this.key = "";
    if (which === "changes") this.refreshChanges();
    if (which === "files" && !this.state.fileView) this.search(this.query);
    this.render();
  }

  toggle(which) {
    if (this.which === which && !this.o.pane.hidden) this.close();
    else this.open(which);
  }

  close() {
    this.which = null;
    this.o.pane.hidden = true;
    this.o.app.classList.remove("with-pane");
    this.syncButtons();
  }

  /** Show a file from the session (from a tool card, a change, or the search). */
  openFile(path) {
    const sid = this.state.activeId;
    if (!sid || !this.o.send("file.read", { sessionId: sid, path })) return this.o.toast("Not connected to the PC.");
    this.state.fileView = { sessionId: sid, requested: path, path, kind: "loading", size: 0 };
    this.showSource = false;
    this.open("files");
  }

  refreshChanges() {
    const sid = this.state.activeId;
    if (sid) this.o.send("changes.get", { sessionId: sid });
  }

  search(q) {
    this.query = q;
    clearTimeout(this.searchTimer);
    const sid = this.state.activeId;
    this.searchTimer = setTimeout(() => sid && this.o.send("files.search", { sessionId: sid, query: q }), 150);
  }

  syncButtons() {
    document.querySelectorAll("[data-pane]").forEach((b) => b.classList.toggle("on", b.dataset.pane === this.which));
  }

  /** Called on every state change; redraws only when what the pane shows has changed. */
  render() {
    this.syncButtons();
    if (!this.which || this.o.pane.hidden) return;
    const sid = this.state.activeId;
    // When Claude finishes (or you switch session), the changes may be different: look again.
    const busy = Boolean(this.o.store.meta(sid)?.busy);
    if (this.which === "changes" && (sid !== this.lastSid || (this.wasBusy && !busy))) this.refreshChanges();
    this.lastSid = sid;
    this.wasBusy = busy;
    const c = sid ? this.o.store.convo(sid) : null;
    let key = `${this.which}|${sid}`;
    if (this.which === "terminal") key += `|${(c?.entries ?? []).filter((e) => e.kind === "tool" && SHELLS.has(e.name)).map((e) => `${e.id}:${e.v}`).join(",")}`;
    if (this.which === "changes") key += `|${this.state.changes.get(sid)?.at ?? 0}|${(c?.entries ?? []).filter((e) => e.kind === "tool" && EDITS.has(e.name)).length}|${[...this.openDiffs].join(",")}`;
    if (this.which === "files") key += `|${JSON.stringify([this.state.fileView?.requested, this.state.fileView?.kind, this.showSource, this.state.files?.query, this.state.files?.items?.length])}`;
    if (key === this.key) return;
    this.key = key;
    const body = this.o.body;
    const keepBottom = this.which === "terminal" && body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    clear(body);
    if (!sid) return body.append(h("div", { class: "pane-note" }, "No session selected."));
    if (this.which === "terminal") this.terminal(c);
    if (this.which === "changes") this.changes(sid, c);
    if (this.which === "files") this.files(sid);
    if (keepBottom) body.scrollTop = body.scrollHeight;
  }

  terminal(c) {
    const meta = this.o.store.meta(this.state.activeId);
    const cmds = c.entries.filter((e) => e.kind === "tool" && SHELLS.has(e.name));
    this.o.body.append(h("div", { class: "pane-note" }, "Commands Claude ran in this session and their output. Read-only: everything still goes through approvals and the audit log."));
    const term = h("div", { class: "term", role: "log", "aria-label": "Terminal" });
    if (!cmds.length) term.append(h("div", { class: "t-desc" }, "# No commands yet."));
    for (const e of cmds) {
      const prompt = e.name === "Bash" ? "$" : `PS ${meta?.cwd ?? ""}>`;
      if (e.input?.description) term.append(h("div", { class: "t-desc" }, `# ${e.input.description}`));
      term.append(h("div", { class: "t-cmd" }, h("span", { class: "p" }, `${prompt} `), String(e.input?.command ?? "")));
      if (e.result) term.append(h("div", { class: `t-out${e.result.isError ? " err" : ""}` }, e.result.output || (e.result.isError ? "(failed)" : "(no output)"), e.result.truncated ? "\n… (output cut short)" : ""));
      else if (e.approval?.state === "pending") term.append(h("div", { class: "t-wait" }, "Waiting for your approval…"));
      else if (e.approval && e.approval.state !== "allowed") term.append(h("div", { class: "t-out err" }, `Not run (${e.approval.state}).`));
      else term.append(h("div", { class: "t-wait" }, "Running…"));
    }
    this.o.body.append(term);
  }

  changes(sid, c) {
    const data = this.state.changes.get(sid);
    const refresh = h("button", { type: "button" }, "Refresh");
    refresh.addEventListener("click", () => this.refreshChanges());
    if (!data) {
      this.o.body.append(h("div", { class: "pane-bar" }, h("span", null, "Loading the changes…"), refresh));
      return;
    }
    if (data.error) this.o.body.append(h("div", { class: "err-box" }, data.error));
    if (data.git) {
      const when = new Date(data.at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      this.o.body.append(
        h("div", { class: "pane-bar" }, h("span", null, `${data.files.length} changed file${data.files.length === 1 ? "" : "s"}${data.branch ? ` on ${data.branch}` : ""} · since the last commit · checked ${when}`), refresh),
      );
      if (!data.files.length) this.o.body.append(h("div", { class: "pane-note" }, "No changes: everything matches the last commit."));
      for (const f of data.files) this.o.body.append(this.changeCard(f, data.root));
      if (data.more) this.o.body.append(h("div", { class: "pane-note" }, "Only the first 300 changed files are shown."));
      return;
    }
    // Not a git repository: what Claude edited in this conversation instead.
    this.o.body.append(h("div", { class: "pane-bar" }, h("span", null, "This folder isn't a git repository, so here are the files Claude edited in this conversation."), refresh));
    const edits = c.entries.filter((e) => e.kind === "tool" && EDITS.has(e.name) && e.result && !e.result.isError);
    if (!edits.length) this.o.body.append(h("div", { class: "pane-note" }, "No edits yet."));
    for (const e of edits) {
      const d = editDiff(e.name, e.input);
      if (!d) continue;
      this.o.body.append(this.changeCard({ path: d.file, status: d.created ? "A" : "M", added: d.added, removed: d.removed, lines: d.lines, key: e.id }, null));
    }
  }

  changeCard(f, root) {
    const key = f.key ?? f.path;
    const open = h("button", { type: "button", class: "open", title: "Open the file" }, "Open");
    open.addEventListener("click", (ev) => {
      ev.preventDefault();
      this.openFile(root ? `${root}\\${f.path}` : f.path);
    });
    const det = h(
      "details",
      { class: "chg" },
      h(
        "summary",
        null,
        h("span", { class: `st ${f.status}`, title: STATUS[f.status] ?? f.status }, f.status === "?" ? "+" : f.status),
        h("span", { class: "p", title: f.from ? `${f.from} → ${f.path}` : f.path }, f.from ? `${f.from} → ${f.path}` : f.path),
        h("span", { class: "n" }, h("span", { class: "a" }, `+${f.added ?? 0}`), " ", h("span", { class: "r" }, `−${f.removed ?? 0}`)),
        f.status !== "D" ? open : null,
      ),
    );
    if (this.openDiffs.has(key)) det.open = true;
    det.addEventListener("toggle", () => {
      if (det.open) this.openDiffs.add(key);
      else this.openDiffs.delete(key);
      if (det.open && !det.querySelector(".diff")) det.append(this.changeBody(f));
    });
    if (det.open) det.append(this.changeBody(f));
    return det;
  }

  changeBody(f) {
    const lines = f.lines ?? parseUnified(f.diff);
    if (!lines.length) return h("div", { class: "pane-note", style: "padding:8px 10px" }, f.status === "D" ? "Deleted." : "No text changes to show (a binary file, or contents not shown).");
    const view = diffView({ lines }, 2000);
    if (f.truncated) view.append(h("div", { class: "gap" }, "⋯ the rest of this diff isn't shown (too big)"));
    return view;
  }

  files(sid) {
    const fv = this.state.fileView?.sessionId === sid ? this.state.fileView : null;
    const input = h("input", { type: "search", placeholder: "Find a file in this session's folder", value: this.query, "aria-label": "Find a file" });
    input.addEventListener("input", () => this.search(input.value));
    this.o.body.append(h("div", { class: "pane-bar" }, input));
    // Typing redraws the pane; keep the cursor in the box.
    queueMicrotask(() => {
      if (document.activeElement === document.body || !fv) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    if (!fv) {
      const res = this.state.files?.query === this.query ? this.state.files.items : null;
      if (!res) this.o.body.append(h("div", { class: "pane-note" }, "Searching…"));
      else if (!res.length) this.o.body.append(h("div", { class: "pane-note" }, "No matching files."));
      else {
        const ul = h("ul", { class: "file-results" });
        for (const p of res) {
          const b = h("button", { type: "button", title: p }, p);
          b.addEventListener("click", () => this.openFile(p));
          ul.append(h("li", null, b));
        }
        this.o.body.append(ul);
      }
      return;
    }
    const back = h("button", { type: "button", class: "ghost" }, "← Files");
    back.addEventListener("click", () => {
      this.state.fileView = null;
      this.key = "";
      this.search(this.query);
      this.render();
    });
    const head = h("div", { class: "fv-head" }, back, h("span", { class: "p", title: fv.path }, fv.path));
    const isMd = /\.(md|markdown)$/i.test(fv.path);
    if (fv.kind === "text" && isMd) {
      const t = h("button", { type: "button", class: "ghost" }, this.showSource ? "Rendered" : "Source");
      t.addEventListener("click", () => {
        this.showSource = !this.showSource;
        this.render();
      });
      head.append(t);
    }
    this.o.body.append(head);
    if (fv.kind === "loading") return this.o.body.append(h("div", { class: "pane-note" }, "Opening…"));
    if (fv.error) return this.o.body.append(h("div", { class: "err-box" }, fv.error));
    this.o.body.append(h("div", { class: "pane-note" }, `${formatSize(fv.size)}${fv.truncated ? " · only the first 1 MB is shown" : ""} · read-only`));
    if (fv.kind === "image") return this.o.body.append(h("img", { class: "fv-img", src: `data:${fv.mime};base64,${fv.data}`, alt: fv.path }));
    if (fv.kind === "binary") return this.o.body.append(h("div", { class: "pane-note" }, "This file isn't text, so it can't be shown here."));
    if (isMd && !this.showSource) return this.o.body.append(markdown(fv.text ?? ""));
    const code = h("div", { class: "code", role: "region", "aria-label": "File contents" });
    const lines = String(fv.text ?? "").replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    lines.forEach((l, i) => code.append(h("div", { class: "ln" }, h("span", { class: "no" }, String(i + 1)), h("span", { class: "tx" }, l || " "))));
    this.o.body.append(code);
  }
}
