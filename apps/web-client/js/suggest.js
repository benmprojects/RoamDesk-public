// The popup above the composer: files for @-mentions (searched on the PC) and slash commands and skills.
import { clear, h } from "./dom.js";
import { applySuggestion, rankCommands, tokenAt } from "./composer.js";

export class Suggest {
  /**
   * @param {{ input: HTMLTextAreaElement, list: HTMLElement, send: (type: string, payload: object) => boolean, state: any, sessionId: () => string | null, onApply: () => void }} o
   */
  constructor(o) {
    this.o = o;
    this.token = null;
    this.items = [];
    this.sel = 0;
    this.timer = null;
    this.asked = new Set(); // sessions whose command list was requested
  }

  get open() {
    return !this.o.list.hidden;
  }

  /** Re-read what's being typed at the caret. */
  update() {
    const { input } = this.o;
    const sid = this.o.sessionId();
    const token = input.selectionStart === input.selectionEnd ? tokenAt(input.value, input.selectionStart) : null;
    this.token = token;
    if (!token || !sid) return this.close();
    if (token.kind === "command") {
      if (!this.o.state.commands.has(sid) && !this.asked.has(sid)) {
        this.asked.add(sid);
        this.o.send("commands.get", { sessionId: sid });
      }
      this.show(rankCommands(this.o.state.commands.get(sid) ?? [], token.query).map((c) => ({ value: c.name, kind: c.skill ? "skill" : "command" })));
    } else {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.o.send("files.search", { sessionId: sid, query: token.query }), 120);
      this.refreshFiles();
    }
  }

  /** New search results arrived (or the command list did). */
  onState() {
    if (!this.token) return;
    if (this.token.kind === "file") this.refreshFiles();
    else this.update();
  }

  refreshFiles() {
    const f = this.o.state.files;
    const sid = this.o.sessionId();
    if (!f || f.sessionId !== sid) return this.show(null);
    this.show(f.items.map((p) => ({ value: p, kind: "file" })), f.query !== this.token?.query);
  }

  show(items, stale = false) {
    const list = clear(this.o.list);
    this.items = items ?? [];
    if (this.sel >= this.items.length) this.sel = 0;
    if (items === null || (!this.items.length && stale)) {
      list.append(h("li", { class: "s-empty" }, "Searching…"));
    } else if (!this.items.length) {
      list.append(h("li", { class: "s-empty" }, this.token?.kind === "command" ? "No matching commands." : "No matching files in this session's folder."));
    }
    this.items.forEach((it, i) => {
      const li = h("li", { role: "option", class: i === this.sel ? "sel" : "", "aria-selected": i === this.sel ? "true" : "false" }, h("span", { class: "s-main" }, it.kind === "file" ? `@${it.value}` : `/${it.value}`), h("span", { class: "s-kind" }, it.kind));
      // mousedown, not click: keep focus in the text box.
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.choose(i);
      });
      list.append(li);
    });
    list.hidden = false;
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  close() {
    this.o.list.hidden = true;
    this.items = [];
    this.sel = 0;
  }

  choose(i) {
    const it = this.items[i];
    if (!it || !this.token) return;
    const { input } = this.o;
    const r = applySuggestion(input.value, input.selectionStart, this.token, it.value);
    input.value = r.text;
    input.setSelectionRange(r.caret, r.caret);
    this.close();
    this.token = null;
    this.o.onApply();
  }

  /** Arrow keys, Enter/Tab and Escape while the popup is open. Returns true if the key was used. */
  keydown(ev) {
    if (!this.open) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!this.items.length) return true;
      this.sel = (this.sel + (ev.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
      this.show(this.items);
      return true;
    }
    if ((ev.key === "Enter" || ev.key === "Tab") && this.items.length) {
      this.choose(this.sel);
      return true;
    }
    if (ev.key === "Escape") {
      this.close();
      return true;
    }
    return false;
  }
}
