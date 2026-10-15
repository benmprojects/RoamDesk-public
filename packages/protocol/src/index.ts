// Roam Desk wire protocol v1 — see ../PROTOCOL.md. Kotlin mirror lives in apps/android.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8787;

export interface Envelope<T extends string = string, P = unknown> {
  v: 1;
  type: T;
  id: string;
  ts: number;
  seq?: number;
  payload: P;
}

/** How tool calls are approved for turns sent from a browser (phone turns keep the voice rules). */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** "voice": replies written to be spoken (phone). "desktop": normal written replies with formatting (browser). */
export type Surface = "voice" | "desktop";

export interface Session {
  id: string;
  name: string;
  cwd: string;
  model: string;
  busy: boolean;
  /** Claude Code session being continued, when known. */
  claudeSessionId?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  surface?: Surface;
  queued?: number;
  /** Tokens in Claude's context after the last request, and the model's context window. */
  contextTokens?: number;
  contextWindow?: number;
}

/** One piece of a turn, for clients that show the full detail (browsers). */
export type TurnItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; toolUseId: string; output: string; isError: boolean; truncated: boolean }
  | { kind: "plan"; id: string; path: string; text: string };

/**
 * The helper's version: the commit it runs (short hash and ISO date), and how many newer commits GitHub has
 * (null until checked). `error` when the last check failed.
 */
export interface VersionInfo { commit: string | null; date: string | null; behind: number | null; checkedAt: number | null; error?: string }

export interface InboxItem { id: string; ts: number; kind: "info" | "warn" | "routine"; title: string; text: string; read: boolean }

/** time is "HH:MM" on the PC's clock. weekly: day is 0 (Sunday) to 6. once: date is "YYYY-MM-DD". */
export interface RoutineSchedule { kind: "daily" | "weekdays" | "weekly" | "once"; time: string; day?: number; date?: string }
export interface Routine {
  id: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  lastRunAt?: number;
  lastStatus?: "ok" | "failed" | "running";
  nextRunAt?: number | null;
}

export interface DoctorCheck { name: string; status: "ok" | "warn" | "bad"; detail: string; fix?: string }

/** One piece of a session's earlier conversation, read from its Claude Code transcript (browsers). */
export type HistoryEntry =
  | { kind: "user"; id: string; text: string; ts: number; attachments?: { name: string; kind: "image" | "file"; url?: string }[] }
  | { kind: "text" | "thinking"; id: string; text: string; ts: number }
  | { kind: "tool_use"; id: string; name: string; input: unknown; ts: number }
  | { kind: "tool_result"; id: string; toolUseId: string; output: string; isError: boolean; truncated: boolean; ts: number }
  | { kind: "note"; id: string; text: string; ts: number };

/** What changed in a session's folder (browsers' Changes pane). git false: the folder isn't a git repository. */
export interface WorkspaceChanges {
  git: boolean;
  root: string | null;
  branch: string | null;
  /** status: M modified, A added, D deleted, R renamed, ? new (untracked). diff: unified diff text against HEAD. */
  files: { path: string; from?: string; status: string; added: number; removed: number; diff: string; truncated: boolean }[];
  more?: boolean;
  error?: string;
}

/** A file shown read-only in the browser's file preview. */
export interface WorkspaceFile {
  path: string;
  kind: "text" | "image" | "binary" | "error";
  size: number;
  text?: string;
  truncated?: boolean;
  /** Images: base64 bytes and their real type. */
  data?: string;
  mime?: string;
  error?: string;
}

export interface AttachmentInfo {
  name: string;
  mime: string;
  size: number;
  /** "image": sent to Claude inline. "file": saved on the PC at `path`, which Claude was given. */
  kind: "image" | "file";
  path?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** An existing Claude Code session on the PC (desktop app, terminal or phone) that the phone can continue. */
export interface CatalogItem {
  claudeSessionId: string;
  title: string;
  project: string;
  cwd: string;
  origin: "desktop" | "terminal" | "phone" | "other";
  lastActiveAt: number;
  /** Modified in the last few minutes, so probably still open somewhere. */
  activeRecently: boolean;
  /** Helper session id if the phone already has it attached. */
  attachedSessionId?: string;
}

export interface PairQr {
  v: 1;
  kind: "claude-anywhere-pair";
  name: string;
  hosts: string[];
  port: number;
  code: string;
  exp: number;
  /** HTTPS link through `tailscale serve`: wss://secureHost:securePort/ws, https:// for /pair, /file and /app/apk. */
  secureHost?: string;
  securePort?: number;
}
export interface PairRequest { code: string; deviceName: string; platform: "android" | "ios" | "browser" }
export interface PairResponse { deviceId: string; deviceSecret: string; helperId: string; helperName: string }

export type ConfirmDecision = "confirm" | "cancel" | "timeout";

// Phone → PC
export interface PhoneMessages {
  /** `phoneNonce`: the phone's own random challenge; the helper answers it with `proof` in auth.ok. */
  "auth.response": { deviceId: string; mac: string; lastSeq: number; phoneNonce?: string };
  /** attachments: upload ids from upload.ready (browsers). Images go to Claude inline; other files are saved on the PC. */
  utterance: { text: string; sessionId?: string; source: "voice" | "typed"; queuedAt?: number; attachments?: string[] };
  /** Browsers: ask to upload a file. Answered with upload.ready (or error); then POST /upload/<uploadId> with header x-ca-upload: <token>. */
  "upload.begin": { ref: string; name: string; size: number; mime: string };
  /** Browsers: files in the session's folder whose path matches query (for @-mentions). Answered with `files`. */
  "files.search": { sessionId: string; query: string };
  /** Browsers: the slash commands and skills a session can use. Answered with `commands`. */
  "commands.get": { sessionId: string };
  /**
   * Browsers: a page of the session's full earlier conversation, going backwards. No cursor = the latest page;
   * beforeTs leaves out what the browser already shows live. Answered with `history.page`.
   */
  "history.page": { sessionId: string; cursor?: number; beforeTs?: number };
  /** Browsers: folder names inside `path` on the PC's local drives (no path: drives and shortcuts). Answered with `folders`. */
  "folders.list": { path?: string };
  /** Browsers: what changed in the session's folder (git). Answered with `changes`. */
  "changes.get": { sessionId: string };
  /** Browsers: a file from the session's folder, read-only. Answered with `file.content`. */
  "file.read": { sessionId: string; path: string };
  "confirm.response": { confirmId: string; decision: ConfirmDecision; heard: string };
  "turn.cancel": { turnId?: string };
  kill: Record<string, never>;
  "session.new": { name: string; cwd?: string; surface?: Surface };
  /**
   * Per-session settings (browsers). bypassPermissions needs bypassAcknowledged: true (the user saw the warning).
   * Only browsers may change permissionMode.
   */
  "session.settings": { sessionId: string; permissionMode?: PermissionMode; model?: string; effort?: string; name?: string; bypassAcknowledged?: boolean };
  /** Answer to ask.request. null answers = the user skipped the question. */
  "ask.response": { askId: string; answers: Record<string, string> | null };
  "session.select": { sessionId: string };
  "session.reset": { sessionId?: string };
  "catalog.list": Record<string, never>;
  /** surface: how replies are written for this session; a browser continues sessions as "desktop". */
  "session.attach": { claudeSessionId: string; surface?: Surface };
  /** Hand a session back to the PC: the helper ends its process and forgets the session. */
  "session.release": { sessionId: string };
  /** adminAllowAll: false switches "Admin: allow everything" off; it can't be turned on from a device. */
  "settings.set": { skipConfirmations?: boolean; plainUpdates?: boolean; adminAllowAll?: false };
  /** Ask for the latest app build (the helper answers with app.update, or nothing if it has none). */
  "app.check": Record<string, never>;
  /** Ask for the recent conversation of a session (default: the active one); answered with `history`. */
  "history.get": { sessionId?: string; limit?: number };
  /** Rebuild and restart the desktop helper from the latest code on the PC. */
  "helper.update": Record<string, never>;
  "inbox.read": Record<string, never>;
  "inbox.clear": Record<string, never>;
  /** Create (no id) or change a routine. */
  "routine.save": { id?: string; name: string; prompt: string; schedule: RoutineSchedule; enabled: boolean };
  "routine.delete": { id: string };
  "routine.run": { id: string };
  /** Run the health check; answered with `doctor`. */
  "doctor.run": Record<string, never>;
  /** Re-check the connectors after signing one in; running sessions restart to pick up any that now connect. */
  "connectors.check": Record<string, never>;
  ack: { seq: number };
  ping: Record<string, never>;
}

// PC → Phone
export interface HelperMessages {
  "auth.challenge": { nonce: string; helperId: string };
  /** `proof` = base64url(HMAC-SHA256(deviceSecret, "helper|" + phoneNonce + "|" + nonce + "|" + deviceId + "|" + helperId)), when the phone sent a phoneNonce. */
  "auth.ok": {
    helperName: string; sessions: Session[]; activeSessionId: string; replayFrom: number; disabled: boolean; proof?: string;
    /** Browsers only: what the model and effort pickers offer. */
    models?: readonly string[]; efforts?: readonly string[];
  };
  "auth.fail": { reason: string };
  /** origin: what sent the request, so each client knows whose approvals and questions it will get. */
  "turn.started": { turnId: string; sessionId: string; text: string; origin?: "phone" | "browser"; attachments?: AttachmentInfo[] };
  "upload.ready": { ref: string; uploadId: string; token: string; maxBytes: number };
  files: { sessionId: string; query: string; items: string[] };
  changes: { sessionId: string } & WorkspaceChanges;
  "file.content": { sessionId: string; requested: string } & WorkspaceFile;
  /** path null: the top level, where `folders` are drive roots such as "C:\". Otherwise folder names inside `path`. */
  folders: { path: string | null; parent: string | null; folders: string[]; shortcuts: { name: string; path: string }[]; labels?: Record<string, string>; error?: string };
  /** `cursor`: pass it back for the next, older page; null at the start of the conversation. `requested`: the cursor asked for. */
  "history.page": { sessionId: string; entries: HistoryEntry[]; cursor: number | null; requested: number | null };
  commands: { sessionId: string; commands: { name: string; skill: boolean }[] };
  /** Browsers only: a finished piece of the turn (text block, tool call, tool result, thinking, plan). */
  "turn.item": { turnId: string; sessionId: string; item: TurnItem };
  /** Browsers only: Claude's guess at what the user will ask next, after a request (Tab fills it in). */
  "prompt.suggestion": { sessionId: string; text: string };
  /** Browsers only: context use after a request. */
  "turn.usage": { turnId: string; sessionId: string; contextTokens: number; contextWindow: number; costUsd?: number };
  /** Browsers only: Claude asks the user to choose (its ask_user tool). Answer with ask.response. */
  "ask.request": { askId: string; turnId: string; sessionId: string; questions: AskQuestion[]; expiresInS: number };
  "ask.resolved": { askId: string; answered: boolean };
  /** Things the PC wants you to see later (reconnects, routine results, updates). Whole list, sent on connect and on every change. */
  inbox: { items: InboxItem[]; unread: number };
  /** The scheduled routines, whole list, sent on connect and on every change. */
  routines: { items: Routine[] };
  /** Result of a health check (doctor.run). */
  doctor: { at: number; checks: DoctorCheck[] };
  "reply.delta": { turnId: string; text: string };
  "turn.progress": { turnId: string; label: string };
  speak: { turnId?: string; text: string; priority: "normal" | "low" | "interrupt" };
  "turn.done": { turnId: string; text: string; durationMs: number };
  "turn.failed": { turnId: string; error: string };
  /** sessionId, tool, toolUseId and input are sent to browsers, which show the call in full. */
  "confirm.request": {
    confirmId: string; turnId: string; tier: 1 | 2; summary: string; command: string; phrase: string; expiresInS: number;
    sessionId?: string; tool?: string; toolUseId?: string; input?: unknown;
  };
  "confirm.resolved": { confirmId: string; decision: ConfirmDecision; by: "phone" | "server" };
  "session.list": { sessions: Session[]; activeSessionId: string };
  catalog: { items: CatalogItem[] };
  /**
   * A file Claude is giving the phone. The phone downloads it with
   * GET http://<helper host>:<port>/file/<fileId>?a=<access> (no other auth; the access key is the capability).
   */
  /** Recent turns of a session, oldest first, read from Claude's own session record on the PC. Not buffered for replay. */
  history: { sessionId: string; items: { role: "user" | "assistant"; text: string; ts: number }[] };
  /**
   * Latest phone app build on this PC. Sent after auth and on app.check. The phone downloads it with
   * GET http://<helper host>:<port>/app/apk?a=<access> if versionCode is newer than its own.
   */
  "app.update": { versionCode: number; versionName: string; size: number; access: string };
  file: { fileId: string; turnId?: string; name: string; size: number; mime: string; caption: string; access: string; expiresAt: number };
  /** skipConfirmations: tier-2 actions run without spoken confirmation (hard-deny list still applies). */
  /** adminAllowUntil: "Admin: allow everything" is on until then (epoch ms), -1 until switched off; null when off. */
  status: { busy: boolean; queued: number; disabled: boolean; skipConfirmations: boolean; plainUpdates: boolean; adminAllowUntil?: number | null; version?: VersionInfo; signIn?: { names: string[]; url: string } };
  error: { code: string; message: string };
  pong: Record<string, never>;
}

export type PhoneFrame = { [K in keyof PhoneMessages]: Envelope<K, PhoneMessages[K]> }[keyof PhoneMessages];
export type HelperFrame = { [K in keyof HelperMessages]: Envelope<K, HelperMessages[K] & { replay?: boolean }> }[keyof HelperMessages];
