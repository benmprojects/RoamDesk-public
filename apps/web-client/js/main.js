// Wires the store, the link to the helper and the page together.
import { $, clear, h } from "./dom.js";
import { forgetPairing, loadPairing, savePairing } from "./keystore.js";
import { Link } from "./link.js";
import { createStore } from "./state.js";
import { MODES, modelName } from "./tools.js";
import { ConversationView, renderSessions } from "./view.js";
import { Attachments } from "./attach.js";
import { Suggest } from "./suggest.js";
import { Panes } from "./panes.js";
import { initExtras } from "./extras.js";
import { Dictation } from "./dictation.js";

const store = createStore();
const { state } = store;
const link = new Link({
  onFrame: (env) => {
    attachments.onFrame(env);
    store.apply(env);
  },
  onState: (kind, message) => onLinkState(kind, message),
});

const el = {
  pair: $("#pairScreen"),
  app: $("#app"),
  helperName: $("#helperName"),
  sessions: $("#sessions"),
  linkDot: $("#linkDot"),
  linkText: $("#linkText"),
  sessionName: $("#sessionName"),
  sessionCwd: $("#sessionCwd"),
  contextBtn: $("#contextBtn"),
  contextRing: $("#contextRing"),
  contextText: $("#contextText"),
  scroller: $("#scroller"),
  convo: $("#convo"),
  empty: $("#emptyState"),
  historyBtn: $("#historyBtn"),
  input: $("#input"),
  modeSel: $("#modeSel"),
  modelSel: $("#modelSel"),
  effortSel: $("#effortSel"),
  queueNote: $("#queueNote"),
  sendBtn: $("#sendBtn"),
  stopBtn: $("#stopBtn"),
  toast: $("#toast"),
};
const view = new ConversationView(el.convo, el.scroller);
const attachments = new Attachments({ link, tray: $("#tray"), toast: (t) => toast(t), onChange: () => renderComposer() });
const dictation = new Dictation({ button: $("#micBtn"), input: $("#input"), toast: (t) => toast(t) });
const extras = initExtras({ state, link, toast: (t) => toast(t) });
const panes = new Panes({ app: el.app, pane: $("#pane"), body: $("#paneBody"), store, send: (type, payload) => link.send(type, payload), toast: (t) => toast(t) });
document.querySelectorAll("[data-pane]").forEach((b) => b.addEventListener("click", () => (b.closest(".pane-tabs") ? panes.open(b.dataset.pane) : panes.toggle(b.dataset.pane))));
$("#paneClose").addEventListener("click", () => panes.close());
const suggest = new Suggest({
  input: el.input,
  list: $("#suggest"),
  send: (type, payload) => link.send(type, payload),
  state,
  sessionId: () => state.activeId,
  onApply: () => autosize(),
});
let forceScroll = false;
let expectNewSession = null; // ids before a "new session", to switch to the new one when it appears
let expectAttach = null; // claudeSessionId being continued

// ---------------------------------------------------------------- link state

function onLinkState(kind, message = "") {
  if (kind === "unpaired" || kind === "revoked") {
    showPairing(message);
    return;
  }
  store.setLink(kind, message);
}

// ---------------------------------------------------------------- pairing

function showPairing(message = "") {
  el.app.hidden = true;
  el.pair.hidden = false;
  $("#pairName").value ||= `Browser on ${navigator.platform || "this computer"}`.slice(0, 60);
  const msg = $("#pairMsg");
  msg.textContent = message;
  msg.className = message ? "msg err" : "msg";
}

$("#pairBtn").addEventListener("click", async () => {
  const msg = $("#pairMsg");
  const raw = $("#pairText").value.trim();
  let code = raw;
  try {
    const qr = JSON.parse(raw);
    if (qr && typeof qr.code === "string") code = qr.code;
  } catch {
    /* a bare code is fine too */
  }
  if (!code) {
    msg.textContent = "Paste the pairing text first.";
    msg.className = "msg err";
    return;
  }
  msg.textContent = "Pairing…";
  msg.className = "msg";
  try {
    const res = await fetch("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: $("#pairName").value.trim() || "Browser", platform: "browser" }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? "That pairing text has expired or was already used. Make a new one in the dashboard." : body.error || `The PC answered ${res.status}.`);
    await savePairing(body);
    $("#pairText").value = "";
    el.pair.hidden = true;
    start();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  }
});

// ---------------------------------------------------------------- actions

const active = () => store.meta(state.activeId);

function send() {
  const s = active();
  if (!s) return;
  if (attachments.busy) return toast("Wait for the attachments to finish uploading.");
  const typed = el.input.value.trim();
  if (!typed && !attachments.count) return;
  const text = typed || "Have a look at the attached files.";
  const ids = attachments.count ? attachments.items.filter((i) => i.status === "ready").map((i) => i.uploadId) : [];
  if (!link.send("utterance", { text, sessionId: s.id, source: "typed", ...(ids.length ? { attachments: ids } : {}) })) {
    toast("Not connected to the PC. Your message is still in the box.");
    return;
  }
  dictation.stop(); // the words are on their way; don't keep typing them into the emptied box
  const { previews } = ids.length ? attachments.take() : { previews: [] };
  store.addPending(s.id, text, previews);
  state.suggestions.delete(s.id);
  el.input.value = "";
  suggest.close();
  autosize();
  forceScroll = true;
}

function stop() {
  const s = active();
  const turnId = s ? store.convo(s.id).currentTurn : null;
  if (s?.busy || turnId) link.send("turn.cancel", { turnId: turnId ?? undefined });
}

function setSetting(patch) {
  const s = active();
  if (!s) return;
  link.send("session.settings", { sessionId: s.id, ...patch });
}

function onModeChange() {
  const mode = el.modeSel.value;
  if (mode === "bypassPermissions") {
    renderComposer(); // the picker shows the real mode until the warning is accepted
    $("#bypassAck").checked = false;
    $("#bypassOk").disabled = true;
    $("#bypassDlg").showModal();
    return;
  }
  setSetting({ permissionMode: mode });
}
// Dialogs act on their buttons (not the close event, which some embedded browsers deliver late or not at all).
$("#bypassOk").addEventListener("click", () => {
  if ($("#bypassAck").checked) setSetting({ permissionMode: "bypassPermissions", bypassAcknowledged: true });
});

const ctx = {
  get mode() {
    return active()?.permissionMode ?? "default";
  },
  forceScroll: false,
  isLatestPlan(e) {
    const entries = store.convo(state.activeId).entries;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "plan") return entries[i].id === e.id;
    return false;
  },
  onApprove(confirmId, yes) {
    if (!link.send("confirm.response", { confirmId, decision: yes ? "confirm" : "cancel", heard: "[browser]" })) return toast("Not connected to the PC.");
    for (const e of store.convo(state.activeId).entries) {
      if (e.approval?.confirmId === confirmId) store.patch(state.activeId, e.id, { approval: { ...e.approval, state: "sending" } });
      if (e.kind === "approval" && e.confirmId === confirmId) store.patch(state.activeId, e.id, { state: "sending" });
    }
  },
  onAnswer(e, answers) {
    if (!link.send("ask.response", { askId: e.askId, answers })) return toast("Not connected to the PC.");
    store.patch(state.activeId, e.id, { state: "sending", answers });
  },
  onPlan(e, mode) {
    if (!mode) {
      store.patch(state.activeId, e.id, { decided: "You asked Claude to keep planning." });
      el.input.placeholder = "What should change in the plan?";
      el.input.focus();
      return;
    }
    setSetting({ permissionMode: mode });
    const s = active();
    const text = "The plan is approved. Go ahead and implement it.";
    if (s && link.send("utterance", { text, sessionId: s.id, source: "typed" })) {
      store.addPending(s.id, text);
      store.patch(state.activeId, e.id, { decided: `Approved (${MODES.find((m) => m.id === mode)?.label}).` });
    }
  },
  onOpenFile(path) {
    panes.openFile(path);
  },
  async onDownload(e, btn) {
    btn.disabled = true;
    btn.textContent = "Downloading…";
    try {
      const res = await fetch(`/file/${encodeURIComponent(e.fileId)}?a=${encodeURIComponent(e.access)}`);
      if (!res.ok) throw new Error(res.status === 404 ? "That file has expired." : `The PC answered ${res.status}.`);
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: e.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      btn.textContent = "Download again";
    } catch (err) {
      toast(err.message);
      btn.textContent = "Download";
    } finally {
      btn.disabled = false;
    }
  },
};

// ---------------------------------------------------------------- rendering

/** The helper's version in Settings, and an "Update available" button in the sidebar when GitHub has a newer one. */
function renderVersion() {
  const v = state.status.version;
  const behind = state.link.kind === "connected" && v?.behind ? v.behind : 0;
  $("#updateAvailBtn").hidden = !behind;
  $("#updateAvailBtn").textContent = `Update available (${behind} new)`;
  const si = state.link.kind === "connected" ? state.status.signIn : null;
  $("#signInBox").hidden = !si;
  if (si) {
    $("#signInText").textContent = `${si.names.join(" and ")} ${si.names.length > 1 ? "need" : "needs"} signing in before Claude can use ${si.names.length > 1 ? "them" : "it"}.`;
    $("#signInLink").href = si.url;
  }
  const when = v?.date ? new Date(v.date).toLocaleDateString("en-AU") : "";
  $("#helperVersion").textContent = !v?.commit
    ? "Version unknown."
    : `Version ${v.commit}${when ? ` · ${when}` : ""} · ${behind ? `${behind} newer on GitHub` : v.behind === 0 ? "up to date" : v.error ?? "checking for updates…"}`;
}

function renderAll(changed) {
  if (state.link.kind === "connected" || state.sessions.length) {
    el.app.hidden = false;
    el.pair.hidden = true;
  }
  el.helperName.textContent = state.helperName ? `on ${state.helperName}` : "";
  const dot = { connected: "ok", connecting: "wait", offline: "bad", error: "bad" }[state.link.kind] ?? "";
  el.linkDot.className = `dot ${dot}`;
  el.linkText.textContent =
    state.link.kind === "connected" ? (state.disabled ? "Connected · remote access is off on the PC" : "Connected") : state.link.message || (state.link.kind === "connecting" ? "Connecting…" : "Offline");
  const until = state.status.adminAllowUntil;
  $("#adminBanner").hidden = until === null || until === undefined || state.link.kind !== "connected";
  $("#adminBannerText").textContent =
    until === -1 ? "Every step runs with no questions or blocks until it's turned off." : until ? `Every step runs with no questions or blocks until ${new Date(until).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}.` : "";
  renderVersion();
  extras.render();
  renderSessions(el.sessions, state.sessions, state.activeId, state.unread, select);
  renderHeader();
  renderComposer();
  if (!changed || changed.global || changed.sessions.has(state.activeId)) renderConversation();
  if (state.toast) {
    toast(state.toast.text);
    store.clearToast();
  }
  const waiting = [...state.unread].length;
  document.title = waiting && document.hidden ? `(${waiting}) Roam Desk` : "Roam Desk";
}

function renderHeader() {
  const s = active();
  el.sessionName.textContent = s?.name ?? "";
  el.sessionCwd.textContent = s?.cwd ?? "";
  const ctxUse = s ? store.convo(s.id).context : null;
  if (ctxUse?.window) {
    const pct = Math.min(100, Math.round((ctxUse.tokens / ctxUse.window) * 100));
    el.contextRing.style.setProperty("--pct", `${pct}%`);
    el.contextText.textContent = `${pct}%`;
    el.contextBtn.title = `${ctxUse.tokens.toLocaleString("en-AU")} of ${ctxUse.window.toLocaleString("en-AU")} tokens of context used. Click to compact.`;
    el.contextBtn.hidden = false;
  } else el.contextBtn.hidden = true;
}

function fillSelect(sel, items, value) {
  const want = items.map((i) => `${i.value}|${i.label}`).join(",");
  if (sel.dataset.items !== want) {
    clear(sel);
    for (const i of items) sel.append(h("option", { value: i.value, title: i.title ?? "" }, i.label));
    sel.dataset.items = want;
  }
  sel.value = value;
}

const DEFAULT_PLACEHOLDER = el.input.placeholder;

function renderComposer() {
  const s = active();
  const mode = s?.permissionMode ?? "default";
  fillSelect(el.modeSel, MODES.map((m) => ({ value: m.id, label: m.label, title: m.hint })), mode);
  el.modeSel.className = `pill-select ${mode === "bypassPermissions" ? "bypass" : mode === "plan" ? "plan" : ""}`;
  el.modeSel.title = MODES.find((m) => m.id === mode)?.hint ?? "";
  const models = state.models.length ? state.models : s ? [s.model] : [];
  fillSelect(el.modelSel, models.map((m) => ({ value: m, label: modelName(m) })), s?.model ?? "");
  const efforts = state.efforts.length ? state.efforts : s?.effort ? [s.effort] : [];
  fillSelect(el.effortSel, efforts.map((e) => ({ value: e, label: `Effort: ${e}` })), s?.effort ?? "");
  const busy = Boolean(s?.busy);
  el.stopBtn.hidden = !busy;
  el.queueNote.textContent = s?.queued ? `${s.queued} queued` : busy ? "Working…" : "";
  // Claude's guess at your next message shows as faint text in the empty box; Tab fills it in.
  const guess = s ? state.suggestions.get(s.id) : undefined;
  el.input.placeholder = guess && !s?.busy ? `${guess}   (Tab to use)` : DEFAULT_PLACEHOLDER;
  const disabled = state.link.kind !== "connected" || !s;
  el.sendBtn.disabled = disabled;
  el.modeSel.disabled = el.modelSel.disabled = el.effortSel.disabled = disabled;
}

function renderConversation() {
  const s = active();
  if (!s) return;
  const c = store.convo(s.id);
  ctx.forceScroll = forceScroll;
  forceScroll = false;
  view.render(s.id, c.entries, ctx);
  el.empty.hidden = c.entries.length > 0;
  // Earlier conversation: the button shows progress, or lets you ask for more if scrolling didn't.
  el.historyBtn.hidden = !s.claudeSessionId || c.historyCursor === null;
  el.historyBtn.disabled = c.historyLoading;
  el.historyBtn.textContent = c.historyLoading ? "Loading earlier messages…" : "Load earlier messages";
  if (state.link.kind === "connected" && s.claudeSessionId && c.historyCursor === undefined) loadHistory();
  // Keep loading until the page has something to scroll, so scrolling up can fetch the rest.
  else if (typeof c.historyCursor === "number" && el.scroller.scrollHeight <= el.scroller.clientHeight + 200) loadHistory();
}

/** The next older page of the active session's full conversation (from its transcript on the PC). */
function loadHistory() {
  const s = active();
  if (!s?.claudeSessionId) return;
  const c = store.convo(s.id);
  if (c.historyLoading || c.historyCursor === null) return;
  let payload = { sessionId: s.id };
  if (c.historyCursor === undefined) {
    // First page: leave out what the live view already shows.
    const live = c.entries.filter((e) => e.kind === "user" && !e.history && !e.pending && e.ts).map((e) => e.ts);
    if (live.length) payload.beforeTs = Math.min(...live) - 2000;
  } else payload.cursor = c.historyCursor;
  if (!link.send("history.page", payload)) return;
  c.historyLoading = true;
  setTimeout(() => {
    // No answer (e.g. the connection dropped): let it be asked again.
    if (c.historyLoading) {
      c.historyLoading = false;
      renderConversation();
    }
  }, 15_000);
}

store.subscribe((changed) => {
  // Switch to a session this browser just created or continued, once the helper lists it.
  if (expectNewSession) {
    const fresh = state.sessions.find((x) => !expectNewSession.has(x.id));
    if (fresh) {
      expectNewSession = null;
      select(fresh.id);
      return;
    }
  }
  if (expectAttach) {
    const found = state.sessions.find((x) => x.claudeSessionId === expectAttach);
    if (found) {
      expectAttach = null;
      select(found.id);
      return;
    }
  }
  renderAll(changed);
  suggest.onState();
  panes.render();
});

function select(id) {
  store.select(id);
  forceScroll = true;
  el.input.placeholder = "Reply to Claude…";
  document.querySelector(".app")?.classList.remove("menu-open");
}

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 5000);
}

// ---------------------------------------------------------------- composer and controls

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, window.innerHeight * 0.4)}px`;
}
el.input.addEventListener("input", () => {
  autosize();
  suggest.update();
});
el.input.addEventListener("keydown", (ev) => {
  if (!ev.isComposing && suggest.keydown(ev)) {
    ev.preventDefault();
    ev.stopPropagation(); // Esc closes the popup instead of stopping Claude
    return;
  }
  // Tab (or Right arrow) in an empty box takes Claude's suggested next message; you can still edit it before sending.
  if ((ev.key === "Tab" || ev.key === "ArrowRight") && !ev.shiftKey && !ev.isComposing && !el.input.value) {
    const s = active();
    const guess = s ? state.suggestions.get(s.id) : undefined;
    if (guess && !s.busy) {
      ev.preventDefault();
      state.suggestions.delete(s.id);
      el.input.value = guess;
      el.input.setSelectionRange(guess.length, guess.length);
      autosize();
      renderComposer();
      return;
    }
  }
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send();
  }
});
// Moving the caret can enter or leave a mention.
el.input.addEventListener("click", () => suggest.update());
el.input.addEventListener("keyup", (ev) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key) && suggest.update());
el.input.addEventListener("blur", () => setTimeout(() => suggest.close(), 150));

// Attach: button, paste (screenshots) and drag and drop.
$("#attachBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (ev) => {
  attachments.add(ev.target.files);
  ev.target.value = "";
});
el.input.addEventListener("paste", (ev) => {
  const files = [...(ev.clipboardData?.files ?? [])];
  // Pasted text stays text; a pasted screenshot or copied file is attached.
  if (files.length && !ev.clipboardData.getData("text/plain")) {
    ev.preventDefault();
    attachments.add(files);
  }
});
let dragDepth = 0;
const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (ev) => {
  if (!hasFiles(ev) || el.app.hidden) return;
  dragDepth++;
  $("#dropZone").hidden = false;
});
document.addEventListener("dragleave", (ev) => {
  if (!hasFiles(ev)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("#dropZone").hidden = true;
});
document.addEventListener("dragover", (ev) => {
  if (hasFiles(ev)) ev.preventDefault();
});
document.addEventListener("drop", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  $("#dropZone").hidden = true;
  if (!el.app.hidden && active()) attachments.add(ev.dataTransfer.files);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !document.querySelector("dialog[open]") && active()?.busy) {
    ev.preventDefault();
    stop();
  }
});
el.sendBtn.addEventListener("click", send);
el.stopBtn.addEventListener("click", stop);
el.modeSel.addEventListener("change", onModeChange);
el.modelSel.addEventListener("change", () => setSetting({ model: el.modelSel.value }));
el.effortSel.addEventListener("change", () => setSetting({ effort: el.effortSel.value }));
$("#bypassAck").addEventListener("change", () => ($("#bypassOk").disabled = !$("#bypassAck").checked));
el.historyBtn.addEventListener("click", () => loadHistory());
// Scrolling near the top loads the next older page.
el.scroller.addEventListener("scroll", () => {
  if (el.scroller.scrollTop < 300) loadHistory();
}, { passive: true });
el.contextBtn.addEventListener("click", compact);
$("#menuBtn").addEventListener("click", () => document.querySelector(".app").classList.toggle("menu-open"));

function compact() {
  const s = active();
  if (!s) return;
  if (s.busy) return toast("Wait until Claude has finished, then compact.");
  if (!confirm("Compact this conversation? Claude summarises it so far to free up context.")) return;
  if (link.send("utterance", { text: "/compact", sessionId: s.id, source: "typed" })) store.addPending(s.id, "/compact");
}

$("#newBtn").addEventListener("click", () => {
  $("#newName").value = "";
  $("#newCwd").value = active()?.cwd ?? "";
  $("#browser").hidden = true;
  $("#newDlg").showModal();
});

// ---------------------------------------------------------------- folder browser (New session)

let foldersShown = null;
const joinPath = (dir, name) => (dir.endsWith("\\") ? dir + name : `${dir}\\${name}`);

function browse(path) {
  const sent = link.send("folders.list", path ? { path } : {});
  $("#fbMsg").textContent = sent ? "Loading…" : "Not connected to the PC.";
}

function folderButton(label, path, icon = "📁") {
  const b = h("button", { type: "button", title: path }, h("span", { "aria-hidden": "true" }, icon), h("span", { class: "n" }, label));
  b.addEventListener("click", () => browse(path));
  // Double-click picks it straight away.
  b.addEventListener("dblclick", () => useFolder(path));
  return h("li", null, b);
}

function renderFolders() {
  const f = state.folders;
  if (!f || $("#browser").hidden || f === foldersShown) return;
  foldersShown = f;
  const list = clear($("#fbList"));
  $("#fbPath").textContent = f.path ?? "This PC";
  $("#fbPath").title = f.path ?? "";
  $("#fbUp").disabled = f.path === null;
  $("#fbUse").disabled = f.path === null || Boolean(f.error);
  $("#fbMsg").textContent = f.error || (f.path === null ? "Pick a drive or shortcut." : f.folders.length ? "" : "No folders inside. You can still use this one.");
  if (f.path === null) {
    if (f.shortcuts.length) {
      list.append(h("li", { class: "group" }, "Shortcuts"));
      for (const s of f.shortcuts) list.append(folderButton(s.name, s.path, s.name.startsWith("Recent") ? "🕘" : "⭐"));
    }
    list.append(h("li", { class: "group" }, "Drives"));
    for (const d of f.folders) {
      const label = f.labels?.[d.toUpperCase()] ?? "";
      list.append(folderButton(label ? `${d}  ${label}` : d, d, /network/.test(label) ? "🌐" : "💽"));
    }
  } else {
    for (const name of f.folders) list.append(folderButton(name, joinPath(f.path, name)));
    if (!f.folders.length && !f.error) list.append(h("li", { class: "empty" }, "(empty)"));
  }
  list.scrollTop = 0;
}

function useFolder(path) {
  $("#newCwd").value = path;
  $("#browser").hidden = true;
  // A name from the folder, if none was typed.
  if (!$("#newName").value.trim()) $("#newName").value = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

$("#browseBtn").addEventListener("click", () => {
  const panel = $("#browser");
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  foldersShown = null;
  clear($("#fbList"));
  browse($("#newCwd").value.trim() || undefined);
});
$("#fbUp").addEventListener("click", () => browse(state.folders?.parent ?? undefined));
$("#fbTop").addEventListener("click", () => browse());
$("#fbUse").addEventListener("click", () => state.folders?.path && useFolder(state.folders.path));
store.subscribe(() => renderFolders());
$("#newCreate").addEventListener("click", () => {
  expectNewSession = new Set(state.sessions.map((x) => x.id));
  const cwd = $("#newCwd").value.trim();
  link.send("session.new", { name: $("#newName").value.trim() || "New session", ...(cwd ? { cwd } : {}), surface: "desktop" });
});

function loadCatalog() {
  const list = $("#catalogList");
  state.catalog = null;
  catalogShown = null;
  $("#catalogCount").textContent = "";
  const sent = link.send("catalog.list", {});
  clear(list).append(h("div", { class: "muted" }, sent ? "Loading the PC's sessions…" : "Not connected to the PC."));
  if (sent) {
    setTimeout(() => {
      if ($("#catalogDlg").open && state.catalog === null) clear(list).append(h("div", { class: "muted" }, "The PC didn't send its session list. Try Refresh."));
    }, 15_000);
  }
}
$("#continueBtn").addEventListener("click", () => {
  $("#catalogSearch").value = "";
  loadCatalog();
  $("#catalogDlg").showModal();
});
$("#catalogRefresh").addEventListener("click", () => loadCatalog());
// The browser can switch "Admin: allow everything" off (never on).
$("#adminOffBtn").addEventListener("click", () => {
  if (!link.send("settings.set", { adminAllowAll: false })) toast("Not connected to the PC.");
});
$("#catalogSearch").addEventListener("input", () => renderCatalog());

// Built once per list from the PC (and when the search changes). Rebuilding on every update (each streamed word)
// replaced the buttons mid-click, so clicks were lost and the list kept jumping back to the top.
let catalogShown = null;
store.subscribe(() => {
  if (!$("#catalogDlg").open || state.catalog === null || state.catalog === catalogShown) return;
  catalogShown = state.catalog;
  renderCatalog();
});

function renderCatalog() {
  if (state.catalog === null) return;
  const list = clear($("#catalogList"));
  const words = $("#catalogSearch").value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = state.catalog.filter((it) => words.every((w) => `${it.title} ${it.project} ${it.cwd}`.toLowerCase().includes(w)));
  $("#catalogCount").textContent = words.length ? `${shown.length} of ${state.catalog.length} sessions` : `${state.catalog.length} sessions`;
  if (!shown.length) list.append(h("div", { class: "muted" }, state.catalog.length ? "No sessions match." : "No sessions found on the PC."));
  for (const it of shown) {
    const when = new Date(it.lastActiveAt).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const b = h(
      "button",
      { type: "button" },
      h("span", { class: "c-name", title: it.title }, it.title),
      h("span", { class: "muted small c-meta", title: it.cwd }, `${it.project} · ${it.origin} · ${when}${it.activeRecently ? " · in use recently" : ""}${it.attachedSessionId ? " · already here" : ""}`),
    );
    b.addEventListener("click", () => {
      if (!link.send("session.attach", { claudeSessionId: it.claudeSessionId, surface: "desktop" })) return toast("Not connected to the PC.");
      expectAttach = it.claudeSessionId;
      $("#catalogDlg").close();
      toast(`Opening "${it.title}"…`);
      // If the PC refuses (it says why), don't jump to it later.
      setTimeout(() => {
        if (expectAttach === it.claudeSessionId) expectAttach = null;
      }, 15_000);
    });
    list.append(b);
  }
}

$("#settingsBtn").addEventListener("click", async () => {
  const s = active();
  $("#settingsSession").textContent = s ? `${s.name} · ${s.cwd}` : "";
  const p = await loadPairing();
  $("#settingsDevice").textContent = p ? `Paired with ${p.helperName || state.helperName} on ${new Date(p.pairedAt).toLocaleDateString("en-AU")}` : "";
  $("#settingsDlg").showModal();
});
$("#renameBtn").addEventListener("click", () => {
  const s = active();
  const name = s && prompt("New name for this session", s.name);
  if (name && name.trim()) setSetting({ name: name.trim() });
});
el.sessionName.addEventListener("dblclick", () => $("#renameBtn").click());
$("#compactBtn").addEventListener("click", () => {
  $("#settingsDlg").close();
  compact();
});
$("#resetBtn").addEventListener("click", () => {
  const s = active();
  if (s && confirm(`Start "${s.name}" afresh? Claude forgets this conversation (it stays in the PC's history).`)) {
    link.send("session.reset", { sessionId: s.id });
    $("#settingsDlg").close();
  }
});
$("#releaseBtn").addEventListener("click", () => {
  const s = active();
  if (s && confirm(`Hand "${s.name}" back to the PC? It's removed from this list and the Claude desktop app owns it again.`)) {
    link.send("session.release", { sessionId: s.id });
    $("#settingsDlg").close();
  }
});
$("#updateAvailBtn").addEventListener("click", () => $("#settingsBtn").click());
$("#signInCheckBtn").addEventListener("click", () => {
  if (!link.send("connectors.check", {})) return toast("Not connected to the PC.");
  toast("Checking the connectors…");
});
$("#updateHelperBtn").addEventListener("click", () => {
  if (!confirm("Update the PC helper? Anything Claude is doing on the PC is stopped, and this page reconnects in about a minute.")) return;
  if (!link.send("helper.update", {})) return toast("Not connected to the PC.");
  $("#settingsDlg").close();
  toast("Updating the PC helper…");
});
$("#unpairBtn").addEventListener("click", async () => {
  if (!confirm("Unpair this browser? You'll need new pairing text from the PC to use it again. (Also remove it from the dashboard's device list.)")) return;
  link.close();
  await forgetPairing();
  location.reload();
});
$("#killBtn").addEventListener("click", () => {
  if (confirm("Stop everything that's running on the PC, in every session?")) link.send("kill", {});
});

window.addEventListener("online", () => link.nudge());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    link.nudge();
    renderAll();
  }
});

// ---------------------------------------------------------------- start

async function start() {
  if (!window.isSecureContext || !crypto?.subtle) {
    showPairing("This page has to be opened over HTTPS (the PC's .ts.net address).");
    return;
  }
  const p = await loadPairing();
  if (!p) return showPairing();
  el.app.hidden = false;
  el.pair.hidden = true;
  link.connect();
}

start();
