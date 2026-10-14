// One Claude session = one long-lived `claude -p` process (stream-json in/out) on the signed-in subscription.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import type { AttachmentInfo, Surface, TurnItem } from "@claude-anywhere/protocol";
import { audit } from "./audit.js";
import { sessionFile } from "./catalog.js";
import { ANNOUNCED } from "./connectors.js";
import { clearFlags } from "./mcpcache.js";
import { releaseFromDesktop } from "./desktop.js";
import type { SessionConfig } from "./config.js";
import { HOOK_SCRIPT, PHONE_MCP } from "./paths.js";
import { newStreamState, parseTurnMessage, type StreamState } from "./stream.js";
import { progressLabel, stillWorkingText } from "./voice.js";

/** What sent a request: the phone app (voice rules) or the web client in a browser (permission modes). */
export type Origin = "phone" | "browser";

export interface SlashCommand {
  name: string;
  skill: boolean;
}
/** The most recent command list from any session: a fair guess for a session that hasn't started its CLI yet. */
export let lastCommands: SlashCommand[] = [];

/** Extra content for a request: images to send inline, and what was attached (for the conversation). */
export interface TurnExtras {
  images?: object[];
  attachments?: AttachmentInfo[];
  /** This request is being tried again after compacting, so a second "too long" isn't offered again. */
  afterCompact?: boolean;
}

/** Claude Code's reply when a request plus the conversation so far is over the model's limit. */
export const TOO_LONG = /prompt is too long/i;

const readPlan = (path: string) => {
  try {
    return readFileSync(path, "utf8").slice(0, 100_000);
  } catch {
    return null;
  }
};

export interface SessionDeps {
  claudePath: string;
  hookUrl: string;
  hookToken: string;
  progressAfterS: number;
  progressEveryS: number;
  /** The "Plain updates" switch, read live: keeps spoken updates free of file names and step names. */
  plainUpdates: boolean;
  /** Start sessions with the Claude in Chrome integration (config chromeTools). */
  chromeTools: boolean;
  /** Instructions appended to Claude's system prompt: the voice rules (dashboard-editable) or the browser rules. */
  instructions(surface: Surface): string;
}

export type SessionEvent =
  | { kind: "turn.started"; turnId: string; text: string; origin: Origin; attachments?: AttachmentInfo[] }
  | { kind: "commands"; commands: SlashCommand[] }
  | { kind: "suggestion"; text: string }
  | { kind: "item"; turnId: string; item: TurnItem }
  | { kind: "usage"; turnId: string; contextTokens: number; contextWindow: number; costUsd?: number }
  | { kind: "reply.delta"; turnId: string; text: string }
  | { kind: "turn.progress"; turnId: string; label: string }
  | { kind: "speak"; turnId?: string; text: string; priority: "normal" | "low" | "interrupt" }
  | { kind: "turn.done"; turnId: string; text: string; durationMs: number }
  | { kind: "turn.failed"; turnId: string; error: string }
  /** The request didn't fit: offer to compact the conversation and send it again. */
  | { kind: "too-long"; turnId: string; text: string; origin: Origin; extras?: TurnExtras }
  | { kind: "busy"; busy: boolean; queued: number }
  | { kind: "claude-session"; claudeSessionId: string };

interface Turn {
  id: string;
  text: string;
  origin: Origin;
  extras?: TurnExtras;
  startedAt: number;
  lastSpokeAt: number;
  lastLabel: string;
  stream: StreamState;
}

export class ClaudeSession extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private queue: { id: string; text: string; origin: Origin; extras?: TurnExtras }[] = [];
  /** Context use after the last request (not saved; fills in again after the next request). */
  context: { tokens: number; window: number } | null = null;
  /** Slash commands and skills this session's CLI offers (known once it has started). */
  commands: SlashCommand[] | null = null;
  private commandsKey = "";
  private current: Turn | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";
  private ownMtime = 0;

  constructor(public cfg: SessionConfig, private deps: SessionDeps) {
    super();
  }

  get busy() {
    return this.current !== null;
  }
  get queued() {
    return this.queue.length;
  }
  get currentTurnId() {
    return this.current?.id;
  }
  /** Who sent the request being worked on; the policy hook applies that side's rules. */
  get currentOrigin(): Origin | undefined {
    return this.current?.origin;
  }

  private emitEv(e: SessionEvent) {
    this.emit("event", e);
  }

  private args(): string[] {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${HOOK_SCRIPT.replace(/\\/g, "/")}"`, timeout: 600 }] }],
      },
    };
    const a = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", this.cfg.model,
      "--effort", this.cfg.effort,
      // Full access: every built-in tool plus the user's connectors (claude.ai and plugins) and user settings.
      // The PreToolUse hook still sees every call, so the audit log and kill switch keep working.
      "--setting-sources", "user,project,local",
      // Our own tool, added alongside the user's connectors (not instead of them): send-a-file-to-the-phone.
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          phone: {
            command: "node",
            args: [PHONE_MCP.replace(/\\/g, "/")],
            env: { CA_HOOK_URL: this.deps.hookUrl, CA_HOOK_KEY: this.deps.hookToken, CA_SESSION_ID: this.cfg.id },
          },
        },
      }),
      "--settings", JSON.stringify(settings),
      "--permission-prompts", "none",
      "--append-system-prompt", this.deps.instructions(this.cfg.surface ?? "voice"),
    ];
    // Claude in Chrome: the browser tools the desktop app's sessions have, so a phone or browser session can use the PC's Chrome.
    a.push(this.deps.chromeTools ? "--chrome" : "--no-chrome");
    // Browser sessions get Claude's guess at the next prompt after each turn (a small extra request); voice sessions don't need it.
    if (this.cfg.surface === "desktop") a.push("--prompt-suggestions", "true");
    // Plan mode is enforced by Claude Code itself; the other modes are applied by the helper's policy hook.
    if (this.cfg.permissionMode === "plan") a.push("--permission-mode", "plan");
    if (this.cfg.claudeSessionId) a.push("--resume", this.cfg.claudeSessionId);
    return a;
  }

  private ensureProcess() {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
      // ask_user waits for the user to choose; give it up to 15 minutes.
      MCP_TOOL_TIMEOUT: "900000",
      CA_HOOK_URL: this.deps.hookUrl,
      CA_HOOK_TOKEN: this.deps.hookToken,
      CA_SESSION_ID: this.cfg.id,
    };
    delete env.ANTHROPIC_API_KEY; // always the subscription sign-in
    // Claude Code skips a connector it once got a 401 from, even after the login works again. Clear that stale flag so
    // this session tries Microsoft 365 afresh; if the login really is bad, the flag comes back and the helper says so.
    try {
      const cleared = clearFlags(ANNOUNCED);
      if (cleared.length) audit({ event: "connectors.cache-cleared", sessionId: this.cfg.id, reason: `${cleared.join(", ")} (before starting a session)` });
    } catch {
      /* never stop a session from starting over this */
    }
    const p = spawn(this.deps.claudePath, this.args(), { cwd: this.cfg.cwd, env, windowsHide: true });
    this.proc = p;
    // The new process has just loaded the conversation as it is now, so only later outside changes count as stale.
    try {
      this.noteOwnWrite();
    } catch {
      /* no transcript yet */
    }
    this.buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => this.onData(d));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d: string) => (this.stderrTail = (this.stderrTail + d).slice(-4000)));
    p.on("exit", (code) => {
      if (this.proc !== p) return; // deliberate kill (cancel/stop) — already handled
      this.proc = null;
      if (this.current) {
        const err = this.stderrTail.trim().split("\n").pop() || `Claude stopped (exit ${code})`;
        this.finishTurn({ failed: `Claude stopped unexpectedly: ${err}` });
      }
    });
    p.on("error", (e) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.current) this.finishTurn({ failed: `Couldn't start Claude: ${e.message}` });
    });
    return p;
  }

  private restartPending = false;

  /** Settings changed (model, effort, instructions): use a fresh CLI, same conversation, from the next request on. */
  refresh() {
    if (this.current) this.restartPending = true;
    else this.killProcess();
  }

  /** Start the CLI ahead of the first request so the user's connectors have finished connecting by then. */
  warm() {
    if (this.current || (this.proc && this.proc.exitCode === null)) return;
    try {
      this.ensureProcess();
    } catch {
      /* the next turn will try again */
    }
  }

  /** Queue a user turn. Returns the turn id. */
  send(text: string, origin: Origin = "phone", extras?: TurnExtras): string {
    const id = `t_${randomBytes(6).toString("base64url")}`;
    this.queue.push({ id, text, origin, extras });
    this.pump();
    this.emitStatus();
    return id;
  }

  /** Keep phone and desktop app from holding two diverging copies of the same conversation. */
  private syncWithDesktop() {
    const id = this.cfg.claudeSessionId;
    if (!id) return;
    const file = sessionFile(id);
    // Someone else (the desktop app) added turns since ours: restart so --resume picks them up.
    if (file && this.proc && statSync(file).mtimeMs > this.ownMtime + 1000) this.killProcess();
    void releaseFromDesktop(id).then((n) => {
      if (n) audit({ event: "desktop.released", claudeSessionId: id, processes: n });
    });
  }

  private noteOwnWrite() {
    const file = this.cfg.claudeSessionId ? sessionFile(this.cfg.claudeSessionId) : null;
    if (file) this.ownMtime = statSync(file).mtimeMs;
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = { id: next.id, text: next.text, origin: next.origin, extras: next.extras, startedAt: Date.now(), lastSpokeAt: Date.now(), lastLabel: "", stream: newStreamState() };
    this.stderrTail = "";
    this.emitEv({ kind: "turn.started", turnId: next.id, text: next.text, origin: next.origin, attachments: next.extras?.attachments });
    try {
      this.syncWithDesktop();
    } catch {
      /* best effort */
    }
    const p = this.ensureProcess();
    const content = next.extras?.images?.length ? [{ type: "text", text: next.text }, ...next.extras.images] : next.text;
    p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    this.startProgressTimer();
  }

  private startProgressTimer() {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      const t = this.current;
      if (!t || t.origin === "browser") return; // the browser shows progress; nothing to read aloud
      const now = Date.now();
      const elapsed = (now - t.startedAt) / 1000;
      if (elapsed >= this.deps.progressAfterS && now - t.lastSpokeAt >= this.deps.progressEveryS * 1000) {
        t.lastSpokeAt = now;
        this.emitEv({ kind: "speak", turnId: t.id, text: stillWorkingText(t.lastLabel, this.deps.plainUpdates), priority: "low" });
      }
    }, 1000);
  }
  private stopProgressTimer() {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  /** Called by the hook handler so "Still working" can name the step. */
  noteSpoken() {
    if (this.current) this.current.lastSpokeAt = Date.now();
  }

  private onData(d: string) {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(m);
    }
  }

  private onMessage(m: any) {
    const t = this.current;
    if (m.type === "system" && m.subtype === "init" && m.session_id && m.session_id !== this.cfg.claudeSessionId) {
      this.cfg.claudeSessionId = m.session_id;
      this.emitEv({ kind: "claude-session", claudeSessionId: m.session_id });
    }
    if (m.type === "system" && m.subtype === "init" && Array.isArray(m.slash_commands)) this.noteCommands(m);
    // Arrives just after the turn's result, so it's handled before the "no turn running" check.
    if (m.type === "prompt_suggestion" && typeof m.suggestion === "string" && m.suggestion.trim()) {
      this.emitEv({ kind: "suggestion", text: m.suggestion.trim().slice(0, 300) });
      return;
    }
    if (!t) return;
    for (const o of parseTurnMessage(m, t.id, t.stream, readPlan)) {
      if (o.kind === "item") this.emitEv({ kind: "item", turnId: t.id, item: o.item });
      else if (o.kind === "compacted") {
        const window = this.context?.window ?? 0;
        this.context = { tokens: o.contextTokens, window };
        if (window) this.emitEv({ kind: "usage", turnId: t.id, contextTokens: o.contextTokens, contextWindow: window });
      } else {
        this.context = { tokens: o.contextTokens, window: o.contextWindow };
        this.emitEv({ kind: "usage", turnId: t.id, contextTokens: o.contextTokens, contextWindow: o.contextWindow, costUsd: o.costUsd });
      }
    }
    if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
      this.emitEv({ kind: "reply.delta", turnId: t.id, text: m.event.delta.text });
    }
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_use") {
          const label = progressLabel(b.name, b.input ?? {});
          t.lastLabel = label;
          this.emitEv({ kind: "turn.progress", turnId: t.id, label });
        }
      }
    }
    if (m.type === "result") {
      if (m.session_id && m.session_id !== this.cfg.claudeSessionId) {
        this.cfg.claudeSessionId = m.session_id;
        this.emitEv({ kind: "claude-session", claudeSessionId: m.session_id });
      }
      if (m.subtype === "success" && !m.is_error) this.finishTurn({ text: String(m.result ?? "").trim() || "Done." });
      else this.finishTurn({ failed: String(m.result ?? m.subtype ?? "Claude reported an error") });
    }
  }

  /** The CLI lists its slash commands and skills when it starts; terminal-only ones can't work here. */
  private noteCommands(m: any) {
    const terminal = new Set<string>(Array.isArray(m.terminal_slash_commands) ? m.terminal_slash_commands : []);
    const skills = new Set<string>(Array.isArray(m.skills) ? m.skills : []);
    const list: SlashCommand[] = (m.slash_commands as unknown[])
      .map(String)
      .filter((c) => c && !terminal.has(c) && !c.startsWith("__"))
      .map((name) => ({ name, skill: skills.has(name) }));
    const key = JSON.stringify(list);
    if (key === this.commandsKey) return;
    this.commandsKey = key;
    this.commands = list;
    lastCommands = list;
    this.emitEv({ kind: "commands", commands: list });
  }

  private finishTurn(r: { text?: string; failed?: string }) {
    const t = this.current;
    if (!t) return;
    this.current = null;
    this.stopProgressTimer();
    try {
      this.noteOwnWrite();
    } catch {
      /* best effort */
    }
    if (this.restartPending) {
      this.restartPending = false;
      this.killProcess();
    }
    const durationMs = Date.now() - t.startedAt;
    // Requests typed in a browser aren't read aloud on the phone (it still shows them).
    const speaks = t.origin !== "browser";
    if (r.failed) {
      this.emitEv({ kind: "turn.failed", turnId: t.id, error: r.failed });
      // Too long for Claude: the user is offered a compact-and-retry instead (once per request).
      const tooLong = TOO_LONG.test(r.failed) && !t.extras?.afterCompact;
      if (tooLong) this.emitEv({ kind: "too-long", turnId: t.id, text: t.text, origin: t.origin, extras: t.extras });
      // Cancellations are announced by whoever cancelled (phone button, kill switch), not here.
      else if (speaks && !r.failed.startsWith("Cancelled")) {
        this.emitEv({ kind: "speak", turnId: t.id, text: "Sorry, that didn't work. " + r.failed.slice(0, 160), priority: "normal" });
      }
    } else {
      if (speaks) this.emitEv({ kind: "speak", turnId: t.id, text: r.text!, priority: "normal" });
      this.emitEv({ kind: "turn.done", turnId: t.id, text: r.text!, durationMs });
    }
    this.pump();
    this.emitStatus();
  }

  private emitStatus() {
    this.emitEv({ kind: "busy", busy: this.busy, queued: this.queue.length });
  }

  /** Stop the running turn. The CLI process is killed and resumed on the next turn. */
  cancel(reason = "Cancelled") {
    if (!this.current) return false;
    const t = this.current;
    this.killProcess();
    if (this.current === t) this.finishTurn({ failed: reason });
    return true;
  }

  /** Stop everything: running turn and queue. */
  stopAll() {
    const dropped = this.queue.splice(0);
    for (const q of dropped) this.emitEv({ kind: "turn.failed", turnId: q.id, error: "Cancelled" });
    this.cancel("Cancelled");
    this.killProcess();
    this.emitStatus();
  }

  /** Start a fresh conversation in this session. */
  reset() {
    this.stopAll();
    this.cfg.claudeSessionId = undefined;
    this.context = null;
  }

  private killProcess() {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null || !p.pid) return;
    // Kill the whole tree: the CLI may have PowerShell children running.
    execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }, () => {});
  }

  dispose() {
    this.stopAll();
  }
}
