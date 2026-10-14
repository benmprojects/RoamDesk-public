// Client state: sessions and each session's conversation, built from the helper's messages (live or replayed).
// No DOM here, so it's tested in Node. Every entry carries a version number `v` so the view only redraws what changed.

let nextLocal = 1;

/** @typedef {{ id: string, kind: string, v: number, [k: string]: any }} Entry */

function newConvo() {
  return {
    /** @type {Entry[]} */ entries: [],
    byId: new Map(),
    live: new Map(), // turnId -> live text entry id (streaming reply)
    toolEntry: new Map(), // toolUseId -> entry id
    turns: new Set(),
    historyLoaded: false,
    context: null, // { tokens, window }
    currentTurn: null, // the request being worked on, for Stop
    historyCursor: undefined, // undefined: not loaded yet; a number: more to load; null: reached the start
    historyLoading: false,
    orphanResults: new Map(), // toolUseId -> result whose tool call is on an older page
  };
}

export function createStore() {
  const state = {
    helperName: "",
    link: { kind: "idle", message: "" },
    disabled: false,
    status: { busy: false, queued: 0, skipConfirmations: false, plainUpdates: true },
    sessions: [],
    activeId: null,
    models: [],
    efforts: [],
    convo: new Map(),
    turnSession: new Map(),
    catalog: null,
    unread: new Set(),
    toast: null,
    commands: new Map(), // sessionId -> [{ name, skill }]
    suggestions: new Map(), // sessionId -> Claude's guess at the next message (Tab fills it in)
    files: null, // latest { sessionId, query, items } for @-mentions
    folders: null, // latest folder listing for the folder browser
    changes: new Map(), // sessionId -> { git, root, branch, files, error, at }
    fileView: null, // the file open in the preview pane
    inbox: { items: [], unread: 0 },
    routines: [],
    doctor: null, // { at, checks } from the last health check
  };
  const listeners = new Set();
  let changed = { sessions: new Set(), global: false };
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const c = changed;
    changed = { sessions: new Set(), global: false };
    listeners.forEach((fn) => fn(c));
  };
  const touch = (sessionId) => {
    if (sessionId) changed.sessions.add(sessionId);
    else changed.global = true;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  const convo = (sessionId) => {
    let c = state.convo.get(sessionId);
    if (!c) {
      c = newConvo();
      state.convo.set(sessionId, c);
    }
    return c;
  };

  function push(sessionId, entry, before) {
    const c = convo(sessionId);
    if (c.byId.has(entry.id)) return c.byId.get(entry.id);
    const e = { v: 1, ...entry };
    if (before !== undefined) {
      const at = c.entries.findIndex((x) => x.id === before);
      if (at >= 0) c.entries.splice(at, 0, e);
      else c.entries.push(e);
    } else c.entries.push(e);
    c.byId.set(e.id, e);
    if (!e.history && sessionId !== state.activeId && ["text", "tool", "approval", "ask", "file", "plan", "error"].includes(e.kind)) state.unread.add(sessionId);
    touch(sessionId);
    return e;
  }

  function update(sessionId, id, patch) {
    const c = convo(sessionId);
    const e = c.byId.get(id);
    if (!e) return null;
    Object.assign(e, patch, { v: e.v + 1 });
    touch(sessionId);
    return e;
  }

  function remove(sessionId, id) {
    const c = convo(sessionId);
    if (!c.byId.has(id)) return;
    c.byId.delete(id);
    c.entries = c.entries.filter((e) => e.id !== id);
    touch(sessionId);
  }

  const sessionOf = (turnId) => state.turnSession.get(turnId) ?? state.activeId;
  const meta = (id) => state.sessions.find((s) => s.id === id);

  function setSessions(list, helperActive) {
    state.sessions = Array.isArray(list) ? list : [];
    if (!state.activeId || !state.sessions.some((s) => s.id === state.activeId)) state.activeId = helperActive ?? state.sessions[0]?.id ?? null;
    for (const s of state.sessions) {
      if (s.contextTokens && s.contextWindow) convo(s.id).context = { tokens: s.contextTokens, window: s.contextWindow };
    }
    touch();
  }

  /**
   * A page of earlier conversation goes above everything shown. The first page leaves out what the live view
   * already has (anything from the oldest live request on).
   */
  function applyHistoryPage(p) {
    const sid = String(p.sessionId);
    const c = convo(sid);
    c.historyLoading = false;
    const first = p.requested === null || p.requested === undefined;
    if (first && c.historyCursor !== undefined) return; // a repeated first page
    let entries = Array.isArray(p.entries) ? p.entries : [];
    if (first) {
      const live = c.entries.filter((e) => e.kind === "user" && !e.history && !e.pending && e.ts).map((e) => e.ts);
      if (live.length) {
        const cutoff = Math.min(...live) - 2000;
        entries = entries.filter((e) => !(Number(e.ts) >= cutoff));
      }
    }
    const anchor = c.entries[0]?.id;
    for (const it of entries) {
      const base = { ts: Number(it.ts) || 0, history: true };
      if (it.kind === "user") push(sid, { id: it.id, kind: "user", text: String(it.text ?? ""), attachments: Array.isArray(it.attachments) ? it.attachments : [], ...base }, anchor);
      else if (it.kind === "text" || it.kind === "thinking") push(sid, { id: it.id, kind: it.kind, text: String(it.text ?? ""), ...base }, anchor);
      else if (it.kind === "note") push(sid, { id: it.id, kind: "system", text: String(it.text ?? ""), ...base }, anchor);
      else if (it.kind === "tool_use") {
        const toolUseId = String(it.id);
        if (c.toolEntry.has(toolUseId)) continue;
        const result = c.orphanResults.get(toolUseId) ?? null;
        c.orphanResults.delete(toolUseId);
        const e = push(sid, { id: `tool:${toolUseId}`, kind: "tool", toolUseId, name: String(it.name ?? ""), input: it.input ?? {}, result, approval: null, ...base }, anchor);
        c.toolEntry.set(toolUseId, e.id);
      } else if (it.kind === "tool_result") {
        const result = { output: String(it.output ?? ""), isError: Boolean(it.isError), truncated: Boolean(it.truncated) };
        const entryId = c.toolEntry.get(String(it.toolUseId));
        const e = entryId ? c.byId.get(entryId) : null;
        if (e && !e.result) update(sid, e.id, { result });
        else if (!e) c.orphanResults.set(String(it.toolUseId), result);
      }
    }
    c.historyCursor = typeof p.cursor === "number" ? p.cursor : null;
    touch(sid);
  }

  /** Apply one envelope from the helper. */
  function apply(env) {
    const p = env?.payload ?? {};
    const ts = Number(env?.ts) || Date.now();
    switch (env?.type) {
      case "auth.ok":
        state.helperName = String(p.helperName ?? "");
        state.disabled = Boolean(p.disabled);
        state.models = Array.isArray(p.models) ? p.models : state.models;
        state.efforts = Array.isArray(p.efforts) ? p.efforts : state.efforts;
        setSessions(p.sessions, p.activeSessionId);
        break;
      case "session.list":
        setSessions(p.sessions, p.activeSessionId);
        break;
      case "inbox":
        state.inbox = { items: Array.isArray(p.items) ? p.items : [], unread: Number(p.unread) || 0 };
        touch();
        break;
      case "routines":
        state.routines = Array.isArray(p.items) ? p.items : [];
        touch();
        break;
      case "doctor":
        state.doctor = { at: Number(p.at) || Date.now(), checks: Array.isArray(p.checks) ? p.checks : [] };
        touch();
        break;
      case "status":
        state.status = {
          busy: Boolean(p.busy),
          queued: Number(p.queued) || 0,
          skipConfirmations: Boolean(p.skipConfirmations),
          plainUpdates: p.plainUpdates !== false,
          adminAllowUntil: typeof p.adminAllowUntil === "number" ? p.adminAllowUntil : null,
          version: p.version && typeof p.version === "object" ? p.version : null,
          signIn: p.signIn && Array.isArray(p.signIn.names) && p.signIn.names.length ? { names: p.signIn.names.map(String), url: String(p.signIn.url ?? "") } : null,
        };
        state.disabled = Boolean(p.disabled);
        touch();
        break;
      case "turn.started": {
        const sid = String(p.sessionId ?? state.activeId);
        const turnId = String(p.turnId);
        state.turnSession.set(turnId, sid);
        state.suggestions.delete(sid); // a new request makes the old guess stale
        const c = convo(sid);
        if (c.turns.has(turnId)) break;
        c.turns.add(turnId);
        c.currentTurn = turnId;
        // A message typed here shows at once as "queued"; it becomes the real one when the helper starts it.
        const atts = Array.isArray(p.attachments) ? p.attachments : [];
        // The helper adds the saved files' paths to the text Claude gets; the message shows them as attachments instead.
        const text = String(p.text ?? "").replace(/\n\nAttached files \(saved on this PC[\s\S]*$/, "");
        const pending = c.entries.find((e) => e.kind === "user" && e.pending && e.text === text);
        if (pending) {
          // Keep this browser's own previews of the images it sent.
          const merged = atts.map((a) => ({ ...a, url: pending.attachments?.find((x) => x.name === a.name)?.url }));
          update(sid, pending.id, { pending: false, turnId, ts, attachments: merged.length ? merged : pending.attachments });
        } else push(sid, { id: `u:${turnId}`, kind: "user", text, turnId, ts, origin: p.origin ?? "phone", attachments: atts });
        break;
      }
      case "reply.delta": {
        const turnId = String(p.turnId);
        const sid = sessionOf(turnId);
        const c = convo(sid);
        const liveId = c.live.get(turnId);
        if (liveId && c.byId.has(liveId)) {
          const e = c.byId.get(liveId);
          update(sid, liveId, { text: e.text + String(p.text ?? "") });
        } else {
          const id = `live:${turnId}:${nextLocal++}`;
          c.live.set(turnId, id);
          push(sid, { id, kind: "text", text: String(p.text ?? ""), turnId, live: true, ts });
        }
        break;
      }
      case "turn.item": {
        const sid = String(p.sessionId ?? sessionOf(p.turnId));
        const turnId = String(p.turnId);
        state.turnSession.set(turnId, sid);
        const item = p.item ?? {};
        const c = convo(sid);
        if (item.kind === "text") {
          // The finished block replaces the streamed copy, in the same place.
          const liveId = c.live.get(turnId);
          c.live.delete(turnId);
          push(sid, { id: `i:${item.id}`, kind: "text", text: String(item.text ?? ""), turnId, ts }, liveId);
          if (liveId) remove(sid, liveId);
        } else if (item.kind === "thinking") {
          push(sid, { id: `i:${item.id}`, kind: "thinking", text: String(item.text ?? ""), turnId, ts });
        } else if (item.kind === "tool_use") {
          const e = push(sid, { id: `tool:${item.id}`, kind: "tool", toolUseId: String(item.id), name: String(item.name ?? ""), input: item.input ?? {}, result: null, approval: null, turnId, ts });
          c.toolEntry.set(String(item.id), e.id);
        } else if (item.kind === "tool_result") {
          const entryId = c.toolEntry.get(String(item.toolUseId));
          const result = { output: String(item.output ?? ""), isError: Boolean(item.isError), truncated: Boolean(item.truncated) };
          if (entryId) update(sid, entryId, { result });
        } else if (item.kind === "plan") {
          push(sid, { id: `i:${item.id}`, kind: "plan", text: String(item.text ?? ""), path: String(item.path ?? ""), turnId, ts, decided: false });
        }
        break;
      }
      case "turn.usage": {
        const sid = String(p.sessionId ?? sessionOf(p.turnId));
        convo(sid).context = { tokens: Number(p.contextTokens) || 0, window: Number(p.contextWindow) || 0 };
        touch(sid);
        break;
      }
      case "turn.done":
      case "turn.failed": {
        const turnId = String(p.turnId);
        const sid = sessionOf(turnId);
        const c = convo(sid);
        const liveId = c.live.get(turnId);
        c.live.delete(turnId);
        if (c.currentTurn === turnId) c.currentTurn = null;
        const hasText = c.entries.some((e) => e.turnId === turnId && e.kind === "text" && !e.live);
        if (env.type === "turn.done") {
          if (liveId) {
            if (hasText) remove(sid, liveId);
            else update(sid, liveId, { live: false, text: String(p.text ?? "") });
          } else if (!hasText && p.text) push(sid, { id: `done:${turnId}`, kind: "text", text: String(p.text), turnId, ts });
        } else {
          if (liveId) update(sid, liveId, { live: false });
          const err = String(p.error ?? "");
          push(sid, { id: `fail:${turnId}`, kind: /^Cancelled/.test(err) ? "system" : "error", text: /^Cancelled/.test(err) ? "Stopped." : err || "That didn't work.", turnId, ts });
        }
        // Anything still waiting for an answer in this turn is over.
        for (const e of c.entries) {
          if (e.turnId !== turnId) continue;
          if (e.approval?.state === "pending") update(sid, e.id, { approval: { ...e.approval, state: "expired" } });
          if (e.kind === "approval" && e.state === "pending") update(sid, e.id, { state: "expired" });
          if (e.kind === "ask" && e.state === "pending") update(sid, e.id, { state: "expired" });
        }
        break;
      }
      case "confirm.request": {
        const sid = String(p.sessionId ?? sessionOf(p.turnId));
        const c = convo(sid);
        const expiresAt = ts + (Number(p.expiresInS) || 60) * 1000;
        const approval = { confirmId: String(p.confirmId), summary: String(p.summary ?? ""), command: String(p.command ?? ""), tool: p.tool, input: p.input, expiresAt, state: expiresAt < Date.now() ? "expired" : "pending" };
        const entryId = p.toolUseId ? c.toolEntry.get(String(p.toolUseId)) : undefined;
        if (entryId) update(sid, entryId, { approval });
        else push(sid, { id: `appr:${p.confirmId}`, kind: "approval", turnId: String(p.turnId), ts, ...approval });
        if (approval.state === "pending" && sid !== state.activeId) state.unread.add(sid);
        break;
      }
      case "confirm.resolved": {
        const id = String(p.confirmId);
        const word = p.decision === "confirm" ? "allowed" : p.decision === "timeout" ? "expired" : "denied";
        for (const [sid, c] of state.convo) {
          for (const e of c.entries) {
            if (e.approval?.confirmId === id) update(sid, e.id, { approval: { ...e.approval, state: word } });
            else if (e.kind === "approval" && e.confirmId === id) update(sid, e.id, { state: word });
          }
        }
        break;
      }
      case "ask.request": {
        const sid = String(p.sessionId ?? sessionOf(p.turnId));
        const expiresAt = ts + (Number(p.expiresInS) || 600) * 1000;
        push(sid, { id: `ask:${p.askId}`, kind: "ask", askId: String(p.askId), questions: Array.isArray(p.questions) ? p.questions : [], turnId: String(p.turnId), ts, expiresAt, state: expiresAt < Date.now() ? "expired" : "pending", answers: null });
        break;
      }
      case "ask.resolved": {
        for (const [sid, c] of state.convo) {
          const e = c.byId.get(`ask:${p.askId}`);
          if (e && (e.state === "pending" || e.state === "sending")) update(sid, e.id, { state: p.answered ? "answered" : "skipped" });
        }
        break;
      }
      case "file": {
        const sid = p.turnId ? sessionOf(p.turnId) : state.activeId;
        push(sid, { id: `file:${p.fileId}`, kind: "file", fileId: String(p.fileId), name: String(p.name ?? "file"), size: Number(p.size) || 0, mime: String(p.mime ?? ""), caption: String(p.caption ?? ""), access: String(p.access ?? ""), expiresAt: Number(p.expiresAt) || 0, turnId: p.turnId, ts });
        break;
      }
      case "history": {
        const sid = String(p.sessionId);
        const c = convo(sid);
        c.historyLoaded = true;
        const first = c.entries[0]?.id;
        const items = Array.isArray(p.items) ? p.items : [];
        // Earlier messages go above what's already shown, skipping ones the live view already has.
        const shown = new Set(c.entries.filter((e) => e.kind === "user" || e.kind === "text").map((e) => `${e.kind === "user" ? "user" : "assistant"}:${String(e.text).trim()}`));
        for (const it of items) {
          const key = `${it.role}:${String(it.text ?? "").trim()}`;
          if (shown.has(key)) continue;
          push(sid, { id: `h:${it.ts}:${it.role}:${nextLocal++}`, kind: it.role === "user" ? "user" : "text", text: String(it.text ?? ""), ts: Number(it.ts) || 0, history: true }, first);
        }
        touch(sid);
        break;
      }
      case "history.page":
        applyHistoryPage(p);
        break;
      case "catalog":
        state.catalog = Array.isArray(p.items) ? p.items : [];
        touch();
        break;
      case "prompt.suggestion": {
        const text = String(p.text ?? "").trim();
        if (text) state.suggestions.set(String(p.sessionId), text);
        touch();
        break;
      }
      case "commands":
        state.commands.set(String(p.sessionId), Array.isArray(p.commands) ? p.commands : []);
        touch();
        break;
      case "changes":
        state.changes.set(String(p.sessionId), {
          git: Boolean(p.git),
          root: p.root ?? null,
          branch: p.branch ?? null,
          files: Array.isArray(p.files) ? p.files : [],
          more: Boolean(p.more),
          error: p.error ? String(p.error) : "",
          at: Date.now(),
        });
        touch();
        break;
      case "file.content":
        state.fileView = { sessionId: String(p.sessionId), requested: String(p.requested ?? ""), path: String(p.path ?? ""), kind: p.kind, size: Number(p.size) || 0, text: p.text, truncated: Boolean(p.truncated), data: p.data, mime: p.mime, error: p.error ? String(p.error) : "" };
        touch();
        break;
      case "folders":
        state.folders = { path: p.path ?? null, parent: p.parent ?? null, folders: Array.isArray(p.folders) ? p.folders : [], shortcuts: Array.isArray(p.shortcuts) ? p.shortcuts : [], labels: p.labels && typeof p.labels === "object" ? p.labels : {}, error: p.error ? String(p.error) : "" };
        touch();
        break;
      case "files":
        state.files = { sessionId: String(p.sessionId), query: String(p.query ?? ""), items: Array.isArray(p.items) ? p.items : [] };
        touch();
        break;
      case "speak":
        // Only the helper's own announcements (no turn) are worth showing; replies arrive as items.
        if (!p.turnId && !p.replay && p.text) push(state.activeId, { id: `s:${ts}:${nextLocal++}`, kind: "system", text: String(p.text), ts });
        break;
      case "error":
        state.toast = { text: String(p.message || p.code || "The PC reported an error."), ts };
        touch();
        break;
      default:
        break;
    }
  }

  return {
    state,
    apply,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    convo,
    meta,
    select(id) {
      state.activeId = id;
      state.unread.delete(id);
      touch();
    },
    setLink(kind, message = "") {
      state.link = { kind, message };
      touch();
    },
    /** A message typed here, shown at once until the helper starts it. */
    addPending(sessionId, text, attachments = []) {
      push(sessionId, { id: `pending:${nextLocal++}`, kind: "user", text, pending: true, ts: Date.now(), origin: "browser", attachments });
    },
    /** Mark an approval, question or plan as answered here (the helper confirms with *.resolved). */
    patch(sessionId, entryId, patchObj) {
      return update(sessionId, entryId, patchObj);
    },
    note(sessionId, text, kind = "system") {
      push(sessionId ?? state.activeId, { id: `n:${nextLocal++}`, kind, text, ts: Date.now() });
    },
    clearToast() {
      state.toast = null;
      touch();
    },
  };
}
