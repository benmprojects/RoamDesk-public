// Session manager: named sessions, the active session, and wiring session events to the phones.
import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { CatalogItem, PermissionMode, Session, Surface } from "@claude-anywhere/protocol";
import { findSession, listCatalog } from "./catalog.js";
import { saveConfig, type Config, type SessionConfig } from "./config.js";
import { broadcast } from "./hub.js";
import { ClaudeSession, type SessionDeps, type SessionEvent } from "./session.js";
import { audit } from "./audit.js";
import { adminState } from "./admin.js";
import { versionInfo } from "./version.js";
import { needsSignIn, SIGN_IN_URL } from "./connectors.js";
import { denyAll, requestConfirmation } from "./approvals.js";
import { registerWithDesktop } from "./desktop.js";

const MAX_SESSIONS = 30;

export class Sessions {
  private map = new Map<string, ClaudeSession>();

  constructor(private config: Config, private deps: SessionDeps) {
    for (const s of config.sessions) this.add(s);
    if (!this.map.has(config.activeSessionId)) config.activeSessionId = config.sessions[0].id;
  }

  private add(cfg: SessionConfig) {
    const s = new ClaudeSession(cfg, this.deps);
    s.on("event", (e: SessionEvent) => this.onEvent(cfg.id, e));
    this.map.set(cfg.id, s);
    return s;
  }

  private onEvent(sessionId: string, e: SessionEvent) {
    switch (e.kind) {
      case "turn.started":
        audit({ event: "turn.started", sessionId, turnId: e.turnId, text: e.text, source: e.origin, ...(e.attachments?.length ? { reason: `attached: ${e.attachments.map((a) => a.name).join(", ")}` } : {}) });
        broadcast("turn.started", { turnId: e.turnId, sessionId, text: e.text, origin: e.origin, ...(e.attachments?.length ? { attachments: e.attachments } : {}) });
        break;
      case "commands":
        broadcast("commands", { sessionId, commands: e.commands });
        break;
      case "suggestion":
        broadcast("prompt.suggestion", { sessionId, text: e.text });
        break;
      case "item":
        broadcast("turn.item", { turnId: e.turnId, sessionId, item: e.item });
        break;
      case "usage":
        broadcast("turn.usage", { turnId: e.turnId, sessionId, contextTokens: e.contextTokens, contextWindow: e.contextWindow, costUsd: e.costUsd });
        break;
      case "reply.delta":
        broadcast("reply.delta", { turnId: e.turnId, text: e.text });
        break;
      case "turn.progress":
        broadcast("turn.progress", { turnId: e.turnId, label: e.label });
        break;
      case "speak":
        broadcast("speak", { turnId: e.turnId, text: e.text, priority: e.priority });
        break;
      case "turn.done":
        audit({ event: "turn.done", sessionId, turnId: e.turnId, durationMs: e.durationMs, reply: e.text });
        broadcast("turn.done", { turnId: e.turnId, text: e.text, durationMs: e.durationMs });
        break;
      case "turn.failed":
        denyAll(e.turnId);
        audit({ event: "turn.failed", sessionId, turnId: e.turnId, error: e.error });
        broadcast("turn.failed", { turnId: e.turnId, error: e.error });
        break;
      case "too-long":
        void this.offerCompact(sessionId, e);
        break;
      case "busy":
        this.broadcastStatus();
        this.broadcastList(); // per-session busy and queue counts for the browser's session list
        break;
      case "claude-session":
        saveConfig(this.config);
        break;
    }
  }

  /**
   * A request was too long for Claude (the conversation plus what was attached). Ask the person who sent it whether
   * to compact the conversation (summarise the earlier part) and send the request again. Nothing happens without a yes.
   */
  private async offerCompact(sessionId: string, e: Extract<SessionEvent, { kind: "too-long" }>) {
    const s = this.map.get(sessionId);
    if (!s) return;
    const browser = e.origin === "browser";
    broadcast("speak", {
      text: "That conversation has got too long for Claude. I can compact it, which summarises the earlier part, then send your request again. Large pasted text or many pictures can also cause this: attaching documents as files helps.",
      priority: "normal",
    });
    const r = await requestConfirmation({
      turnId: e.turnId,
      tier: 2,
      summary: "compact this conversation and send your request again",
      command: `/compact, then: ${e.text.slice(0, 300)}`,
      verb: "compact",
      timeoutS: browser ? 600 : this.config.confirmTimeoutS,
      to: browser ? "browser" : "phone",
      sessionId,
      tool: "Compact",
    });
    const yes = r.decision === "confirm";
    audit({ event: "too-long", sessionId, turnId: e.turnId, decision: yes ? "compact and retry" : r.decision, approver: r.by === "phone" ? (browser ? "browser" : "voice") : "server" });
    if (!yes || !this.map.has(sessionId)) return;
    s.send("/compact", e.origin);
    s.send(e.text, e.origin, { ...e.extras, afterCompact: true });
  }

  get(id: string) {
    return this.map.get(id);
  }
  get active() {
    return this.map.get(this.config.activeSessionId)!;
  }
  get activeId() {
    return this.config.activeSessionId;
  }

  list(): Session[] {
    return this.config.sessions.map((c) => {
      const s = this.map.get(c.id);
      return {
        id: c.id,
        name: c.name,
        cwd: c.cwd,
        model: c.model,
        busy: s?.busy ?? false,
        claudeSessionId: c.claudeSessionId,
        effort: c.effort,
        permissionMode: c.permissionMode ?? "default",
        surface: c.surface ?? "voice",
        queued: s?.queued ?? 0,
        ...(s?.context ? { contextTokens: s.context.tokens, contextWindow: s.context.window } : {}),
      };
    });
  }

  /**
   * Per-session settings from a browser. Model, effort and plan mode are part of the CLI's start-up, so the CLI is
   * restarted (same conversation) before the next request; the other modes take effect at once.
   */
  updateSettings(id: string, s: { permissionMode?: PermissionMode; model?: string; effort?: SessionConfig["effort"]; name?: string }): string[] {
    const cfg = this.config.sessions.find((c) => c.id === id);
    const sess = this.map.get(id);
    if (!cfg || !sess) return [];
    const changed: string[] = [];
    let restart = false;
    if (s.permissionMode && s.permissionMode !== (cfg.permissionMode ?? "default")) {
      restart ||= s.permissionMode === "plan" || cfg.permissionMode === "plan";
      cfg.permissionMode = s.permissionMode;
      changed.push(`mode ${s.permissionMode}`);
    }
    if (s.model && s.model !== cfg.model) {
      cfg.model = s.model;
      restart = true;
      changed.push(`model ${s.model}`);
    }
    if (s.effort && s.effort !== cfg.effort) {
      cfg.effort = s.effort;
      restart = true;
      changed.push(`effort ${s.effort}`);
    }
    if (s.name && s.name.trim() && s.name.trim() !== cfg.name) {
      cfg.name = s.name.trim().slice(0, 60);
      changed.push("renamed");
    }
    if (!changed.length) return changed;
    saveConfig(this.config);
    if (restart) sess.refresh();
    this.broadcastList();
    return changed;
  }

  status() {
    let busy = false;
    let queued = 0;
    for (const s of this.map.values()) {
      busy ||= s.busy;
      queued += s.queued;
    }
    return { busy, queued, skipConfirmations: this.config.skipConfirmations, plainUpdates: this.config.plainUpdates !== false, adminAllowUntil: adminState(this.config).until, version: versionInfo(), signIn: { names: needsSignIn(), url: SIGN_IN_URL } };
  }

  /** The Chrome tools are part of each session's start-up, so restart them when free. */
  setChromeTools(on: boolean) {
    this.config.chromeTools = on;
    saveConfig(this.config);
    this.refreshAll();
  }

  setPlainUpdates(on: boolean) {
    this.config.plainUpdates = on;
    saveConfig(this.config);
    this.refreshAll(); // the instructions are part of each session's start-up, so restart them when free
  }

  /** Model/effort for every phone session (and new ones, which copy the active session). */
  setModel(model: string, effort: SessionConfig["effort"]) {
    for (const c of this.config.sessions) {
      c.model = model;
      c.effort = effort;
    }
    saveConfig(this.config);
    this.refreshAll();
  }

  /** Settings that are baked into the CLI's command line changed: restart each session's CLI when it's free. */
  refreshAll() {
    for (const s of this.map.values()) s.refresh();
  }

  setSkipConfirmations(on: boolean) {
    this.config.skipConfirmations = on;
    saveConfig(this.config);
  }

  /** Hand a session back to the PC: end the phone's process and forget it, so the desktop app owns it again. */
  release(id: string): { ok: true; name: string; desktop: string } | { ok: false; reason: string } {
    const s = this.map.get(id);
    if (!s) return { ok: false, reason: "No such session." };
    if (this.config.sessions.length <= 1) return { ok: false, reason: "That's your only session, so it stays on the phone." };
    s.dispose();
    let desktop = "unavailable";
    const claudeId = s.cfg.claudeSessionId;
    if (claudeId) {
      try {
        const item = findSession(claudeId, new Set());
        desktop = registerWithDesktop({ claudeSessionId: claudeId, cwd: item?.cwd ?? s.cfg.cwd, title: item?.title ?? s.cfg.name, lastActiveAt: item?.lastActiveAt ?? Date.now() });
      } catch (e: any) {
        audit({ event: "desktop.register", claudeSessionId: claudeId, decision: "failed", reason: String(e?.message ?? e) });
      }
    }
    this.map.delete(id);
    this.config.sessions = this.config.sessions.filter((c) => c.id !== id);
    if (this.config.activeSessionId === id) this.config.activeSessionId = this.config.sessions[0].id;
    saveConfig(this.config);
    this.broadcastList();
    return { ok: true, name: s.cfg.name, desktop };
  }

  broadcastStatus(disabled = false) {
    broadcast("status", { ...this.status(), disabled });
  }

  broadcastList() {
    broadcast("session.list", { sessions: this.list(), activeSessionId: this.activeId });
  }

  select(id: string) {
    if (!this.map.has(id)) return false;
    this.config.activeSessionId = id;
    saveConfig(this.config);
    this.broadcastList();
    this.map.get(id)?.warm();
    return true;
  }

  /** Returns null when the session limit is reached. A folder from the phone must be a local drive folder (no network shares). */
  create(name: string, cwd?: string, surface: Surface = "voice"): SessionConfig | null {
    if (this.config.sessions.length >= MAX_SESSIONS) return null;
    const base = this.config.sessions.find((s) => s.id === this.activeId) ?? this.config.sessions[0];
    const local = typeof cwd === "string" && /^[a-z]:[\\/]/i.test(cwd) && !/[\\/]{2}/.test(cwd.slice(2)) && existsSync(cwd) && statSync(cwd).isDirectory();
    const dir = local ? cwd : base.cwd;
    const cfg: SessionConfig = {
      id: `s_${randomBytes(4).toString("hex")}`,
      name: name.trim().slice(0, 40) || "New session",
      cwd: dir,
      model: base.model,
      effort: base.effort,
      surface,
      permissionMode: "default",
    };
    this.config.sessions.push(cfg);
    this.config.activeSessionId = cfg.id;
    this.add(cfg);
    saveConfig(this.config);
    this.broadcastList();
    return cfg;
  }

  /** Claude Code session ids the phone has created or attached (used to label catalogue entries). */
  phoneClaudeIds(): Set<string> {
    return new Set(this.config.sessions.map((s) => s.claudeSessionId).filter((x): x is string => Boolean(x)));
  }

  catalog(): CatalogItem[] {
    const byClaudeId = new Map(this.config.sessions.filter((s) => s.claudeSessionId).map((s) => [s.claudeSessionId!, s.id]));
    return listCatalog(this.phoneClaudeIds()).map((i) => ({ ...i, attachedSessionId: byClaudeId.get(i.claudeSessionId) }));
  }

  /** Continue an existing Claude Code session from the phone (hand-off: same session id). */
  attach(claudeSessionId: string, surface: Surface = "voice"): { ok: true; cfg: SessionConfig; item: CatalogItem; reused: boolean } | { ok: false; reason: string } {
    const existing = this.config.sessions.find((s) => s.claudeSessionId === claudeSessionId);
    const item = findSession(claudeSessionId, this.phoneClaudeIds());
    if (!item) return { ok: false, reason: "That session couldn't be found on the PC." };
    if (!existsSync(item.cwd)) return { ok: false, reason: "That session's project folder no longer exists." };
    if (existing) {
      this.select(existing.id);
      return { ok: true, cfg: existing, item, reused: true };
    }
    if (this.config.sessions.length >= MAX_SESSIONS) return { ok: false, reason: "There are too many sessions. Hand some back to the PC first." };
    const base = this.config.sessions.find((s) => s.id === this.activeId) ?? this.config.sessions[0];
    const cfg: SessionConfig = {
      id: `s_${randomBytes(4).toString("hex")}`,
      name: item.title.slice(0, 40),
      cwd: item.cwd,
      model: base.model,
      effort: base.effort,
      claudeSessionId,
      surface,
      permissionMode: "default",
    };
    this.config.sessions.push(cfg);
    this.config.activeSessionId = cfg.id;
    this.add(cfg).warm();
    saveConfig(this.config);
    this.broadcastList();
    return { ok: true, cfg, item, reused: false };
  }

  reset(id?: string) {
    const s = this.map.get(id ?? this.activeId);
    if (!s) return false;
    s.reset();
    saveConfig(this.config);
    this.broadcastList();
    return true;
  }

  killAll() {
    for (const s of this.map.values()) s.stopAll();
    denyAll();
  }

  /** Which session a hook call belongs to (the CLI passes CA_SESSION_ID). */
  bySessionId(id: string) {
    return this.map.get(id);
  }

  dispose() {
    for (const s of this.map.values()) s.dispose();
  }
}
