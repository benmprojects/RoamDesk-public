// HTTP + WebSocket server: phone pairing and messaging, the CLI hook endpoint, and the local dashboard.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import type { AskQuestion, PermissionMode, PhoneFrame } from "@claude-anywhere/protocol";
import { answerConfirmation, requestAnswers, requestConfirmation, settleAsk } from "./approvals.js";
import { audit, recentAudit } from "./audit.js";
import { EFFORTS, MODELS, PERMISSION_MODES, saveConfig, type Config, type SessionConfig } from "./config.js";
import { browserVerdict } from "./modes.js";
import { WEB_ROOT } from "./paths.js";
import { trimInput } from "./stream.js";
import { lastCommands, type ClaudeSession } from "./session.js";
import { beginUpload, MAX_UPLOAD_BYTES, receiveUpload, takeAttachments } from "./uploads.js";
import { searchFiles } from "./filesearch.js";
import { readHistoryPage } from "./transcript.js";
import { listFolders } from "./folders.js";
import { readWorkspaceFile, workspaceChanges } from "./workspace.js";
import { ADMIN_CHOICES, adminExpired, adminState, adminUntilFor, deviceAdminRequest, type AdminChoice } from "./admin.js";
import { sessionFile } from "./catalog.js";
import { VOICE_RULES, announcesRoutineSteps } from "./voice.js";
import { ANNOUNCED, listConnectors, needsSignIn, onConnectorsRecovered, setFlaggedDown } from "./connectors.js";
import { clearFlags, flaggedNames, runProbe } from "./mcpcache.js";
import { newRelinkState, relinkDue, runRelink } from "./relink.js";
import { clearInbox, inboxView, markInboxRead, notifyInbox } from "./inbox.js";
import { deleteRoutine, routineList, runNow, saveRoutine, tickRoutines } from "./routines.js";
import { checkHealth } from "./doctor.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { createPairCode, helperId, listDevices, redeemPairCode, revokeDevice, touchDevice, verifyDevice } from "./devices.js";
import { attach, audienceOf, broadcast, connectedCountFor, connectedDevices, detach, disconnectDevice, replay, sendDirect } from "./hub.js";
import { DISABLED_FLAG } from "./paths.js";
import { serveApk, updateOffer } from "./appupdate.js";
import { loadHistory } from "./history.js";
import { startHelperUpdate, takeUpdatedNotice } from "./selfupdate.js";
import { checkForUpdate, versionInfo } from "./version.js";
import { offerFile, serveFile } from "./files.js";
import { decide, isSensitivePath } from "./policy.js";
import type { Sessions } from "./sessions.js";

const MAX_BODY = 64 * 1024;
const UTTERANCES_PER_MIN = 10;
const TIER2_PER_HOUR = 20;
// The web client is used like the desktop app, so far more approvals are normal there.
const BROWSER_APPROVALS_PER_HOUR = 200;
// Just under the hook's own 600 s limit (hooks/pretool.mjs gives up at 590 s and denies).
const BROWSER_APPROVAL_TIMEOUT_S = 570;
const ASK_TIMEOUT_S = 840;
const PAIR_ATTEMPTS_PER_MIN = 5; // per source address
const MAX_PENDING_SOCKETS = 20; // connections that haven't authenticated yet
const MAX_PENDING_PER_ADDRESS = 4;
// Frames a paired phone may still send while remote access is switched off.
const ALLOWED_WHILE_DISABLED = new Set(["ping", "ack", "kill", "turn.cancel", "utterance"]);

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const clip = (v: unknown, n = 64) => String(v ?? "").slice(0, n);

export const isDisabled = () => existsSync(DISABLED_FLAG);

// Requests that arrived through `tailscale serve` on the phone port. They reach us from 127.0.0.1,
// so they must never count as "this PC" for the dashboard or hooks (which aren't served on that port at all).
const viaServe = new WeakSet<IncomingMessage>();

function isLoopback(req: IncomingMessage) {
  if (viaServe.has(req)) return false;
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
/** The real caller: tailscale serve passes the phone's tailnet address in X-Forwarded-For. */
function clientAddr(req: IncomingMessage) {
  if (viaServe.has(req)) return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "serve";
  return req.socket.remoteAddress ?? "?";
}
const PHONE_ROUTES = /^\/(pair|ws|file\/[^/]+|app\/apk|upload\/[\w-]+)$/;
// The web client (apps/web-client), served on the same HTTPS link.
const WEB_ROUTES = /^\/(|index\.html|manifest\.webmanifest|[\w-]+\.(css|svg|png|ico)|js\/[\w-]+\.js)$/;
const WEB_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
};
const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function serveWeb(path: string, res: ServerResponse) {
  const rel = path === "/" ? "index.html" : path.slice(1);
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  res.writeHead(200, {
    "content-type": WEB_TYPES[ext] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "content-security-policy": WEB_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    // The microphone is for this page only (dictation in the message box); camera and location stay off.
    "permissions-policy": "camera=(), microphone=(self), geolocation=()",
  });
  res.end(readFileSync(file));
}

/** Claude's ask_user questions, cut down to sensible sizes. Null if unusable. */
function cleanQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const qs = raw.slice(0, 4).flatMap((q: any) => {
    const options = Array.isArray(q?.options)
      ? q.options.slice(0, 8).map((o: any) => ({ label: clip(o?.label, 80), ...(o?.description ? { description: clip(o.description, 240) } : {}) })).filter((o: any) => o.label.trim())
      : [];
    const question = clip(q?.question, 400).trim();
    if (!question || options.length < 2) return [];
    return [{ question, ...(q?.header ? { header: clip(q.header, 20) } : {}), options, multiSelect: q?.multiSelect === true }];
  });
  return qs.length ? qs : null;
}

export interface SecureLink {
  /** This PC's .ts.net name when the HTTPS link is up, else null. */
  host: string | null;
  port: number;
  ownerLogin: string | null;
  error: string | null;
}
function isLocalHost(req: IncomingMessage, port: number) {
  // Dashboard APIs: loopback socket AND a loopback Host header (blocks DNS-rebinding from web pages).
  const h = (req.headers.host ?? "").toLowerCase();
  return isLoopback(req) && (h === `127.0.0.1:${port}` || h === `localhost:${port}`);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export class HelperServer {
  readonly hookToken = randomBytes(24).toString("base64url");
  private servers: Server[] = [];
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  private utteranceTimes = new Map<string, number[]>();
  private tier2Times: number[] = [];
  private browserApprovalTimes: number[] = [];
  private pairAttempts = new Map<string, number[]>();
  private pending = new Map<string, number>(); // unauthenticated sockets per address
  private secure: SecureLink = { host: null, port: 0, ownerLogin: null, error: "not set up yet" };

  constructor(private config: Config, private sessions: Sessions, private hosts: string[]) {
    // A timed "allow everything" switches itself off when its time is up.
    setInterval(() => {
      if (!adminExpired(this.config)) return;
      this.setAdmin("off", "expired");
    }, 15_000).unref();
    // A connector that has just been signed in only reaches a running session after its CLI restarts.
    onConnectorsRecovered(() => {
      audit({ event: "connectors.recovered", approver: "auto" });
      this.sessions.refreshAll();
      this.sessions.broadcastStatus(isDisabled());
    });
    // While one is waiting for a sign-in, look again every minute so nobody has to tap "Check again".
    setInterval(() => {
      if (needsSignIn().length && !isDisabled()) void this.checkConnectors();
    }, 60_000).unref();
    // And a quiet check every 10 minutes, so a drop is noticed (and re-linked) even with no phone connected.
    setInterval(() => {
      if (!isDisabled()) void this.checkConnectors();
    }, 10 * 60_000).unref();
    // Scheduled routines: what's due runs (read-only) and its answer lands in the inbox.
    setInterval(() => {
      if (!isDisabled()) tickRoutines(this.config.claudePath, () => this.sendRoutines(), (r, ok, text) => this.routineDone(r, ok, text));
    }, 30_000).unref();
  }

  private relink = newRelinkState();
  private wasDown = false;
  private healedAt = 0;

  /**
   * Claude Code remembers one 401 from Microsoft 365 and skips the connector from then on, even once the login works.
   * Clear that flag and start Claude once for real: if the flag comes back, the login really is bad (so it's treated as
   * signed out and the reconnect is offered); if not, the connector works again and running sessions restart to load it.
   */
  private async healStaleFlag() {
    const flagged = flaggedNames(ANNOUNCED);
    if (!flagged.length) return setFlaggedDown([]);
    if (Date.now() - this.healedAt < 15 * 60_000) return setFlaggedDown(flagged); // flagged again soon after a clear: genuinely failing
    this.healedAt = Date.now();
    let cleared: string[] = [];
    try {
      cleared = clearFlags(ANNOUNCED);
    } catch (e: any) {
      audit({ event: "connectors.cache-cleared", decision: "failed", reason: String(e?.message ?? e).slice(0, 160) });
      return setFlaggedDown(flagged);
    }
    await runProbe(this.config.claudePath);
    const again = flaggedNames(ANNOUNCED);
    setFlaggedDown(again);
    audit({ event: "connectors.cache-cleared", approver: "auto", decision: again.length ? "flag-returned" : "cleared", reason: cleared.join(", ") });
    if (again.length) return;
    await listConnectors(this.config.claudePath, true);
    this.sessions.refreshAll();
    notifyInbox("info", "Microsoft 365 was wrongly marked as signed out", "Claude had remembered an old sign-in failure and was skipping Microsoft 365. The helper cleared that, and it works again in new requests.");
  }

  private health() {
    return checkHealth({ claudePath: this.config.claudePath, secure: { host: this.secure.host, error: this.secure.error }, disabled: isDisabled(), chromeTools: this.config.chromeTools !== false, devices: listDevices().length });
  }

  private sendRoutines() {
    broadcast("routines", { items: routineList() });
  }

  private routineDone(r: { name: string }, ok: boolean, text: string) {
    notifyInbox(ok ? "routine" : "warn", ok ? r.name : `${r.name} didn't finish`, text);
  }

  /** Look at the connectors; if Microsoft 365 has stayed signed out, re-link it through the PC's Chrome. */
  private async checkConnectors() {
    await listConnectors(this.config.claudePath, true);
    await this.healStaleFlag();
    this.sessions.broadcastStatus(isDisabled());
    const down = needsSignIn().length > 0;
    if (down && !this.wasDown) notifyInbox("warn", "Microsoft 365 signed out", "Claude can't use Microsoft 365 until it's signed in again. You'll be asked if you want it reconnected through the PC's browser.");
    if (!down && this.wasDown) notifyInbox("info", "Microsoft 365 is back", "It's connected again.");
    this.wasDown = down;
    if (!relinkDue(this.relink, needsSignIn().length > 0, Date.now())) return;
    if (connectedCountFor("all") === 0) return; // nobody to ask; try again at the next check
    this.relink.running = true;
    this.relink.attempts.push(Date.now());
    try {
      // Nothing is clicked in the browser until the user says yes here (phone or web client).
      const ask = await requestConfirmation({
        turnId: "",
        tier: 2,
        summary: "Microsoft 365 has disconnected. Reconnect it through your PC's browser?",
        command: "Open claude.ai/customize/connectors in Chrome and click Connect for Microsoft 365. Your password and MFA are never typed for you.",
        verb: "reconnect",
        timeoutS: Math.max(this.config.confirmTimeoutS, 120),
        to: "all",
      });
      const approved = ask.decision === "confirm";
      audit({ event: "connectors.relink", approver: approved ? (ask.heard === "[on-screen button]" ? "phone-button" : "voice") : "server", decision: approved ? "approved" : ask.decision, reason: "Microsoft 365 signed out" });
      if (!approved) return;
      const r = await runRelink(this.config.claudePath);
      audit({ event: "connectors.relink", approver: "auto", decision: r.ok ? "done" : "needs-user", reason: r.message });
      await listConnectors(this.config.claudePath, true); // recovered sessions restart via onConnectorsRecovered
      this.sessions.broadcastStatus(isDisabled());
      if (!r.ok) {
        const text = r.message.replace(/^NEEDS YOU:\s*/i, "Microsoft 365 needs you: ");
        notifyInbox("warn", "Microsoft 365 needs you", text);
        broadcast("speak", { text, priority: "normal" });
      }
    } finally {
      this.relink.running = false;
    }
  }

  /** Turn "Admin: allow everything" on (dashboard) or off (anywhere). */
  private setAdmin(choice: AdminChoice, by: string) {
    this.config.adminAllowUntil = adminUntilFor(choice);
    saveConfig(this.config);
    audit({ event: "admin.allow-all", approver: by === "dashboard" ? "server" : "auto", decision: choice === "off" ? "off" : "on", reason: `${choice} (by ${by})` });
    this.sessions.broadcastStatus(isDisabled());
  }

  setSecure(s: SecureLink) {
    this.secure = s;
  }

  /** Tailscale logins allowed through the HTTPS link. Fails closed if the owner can't be worked out. */
  private allowedUsers(): string[] {
    const list = (this.config.allowedUsers ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean);
    if (list.length) return list;
    return this.secure.ownerLogin ? [this.secure.ownerLogin.toLowerCase()] : [];
  }

  /** Checks the Tailscale identity tailscale serve attached. Returns the login, or null if not allowed. */
  private serveIdentity(req: IncomingMessage): string | null {
    const login = String(req.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
    return login && this.allowedUsers().includes(login) ? login : null;
  }

  /**
   * Browsers always send an Origin on WebSocket and cross-site requests; it must be this link's own address.
   * The phone app sends none, which is fine (it authenticates with its device key either way).
   */
  private sameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (!this.secure.host) return false;
    const host = this.secure.host.toLowerCase();
    const own = new Set([`https://${host}:${this.secure.port}`, ...(this.secure.port === 443 ? [`https://${host}`] : [])]);
    return own.has(String(origin).toLowerCase());
  }

  /** The port that `tailscale serve` forwards the HTTPS link to (loopback only): phone routes and the web client. */
  async listenPhone(port: number) {
    const srv = createServer((req, res) => {
      viaServe.add(req);
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const web = req.method === "GET" && WEB_ROUTES.test(path);
      if ((!PHONE_ROUTES.test(path) && !web) || path === "/ws") return json(res, 404, { error: "not found" });
      if (!this.serveIdentity(req)) {
        audit({ event: "secure.refused", from: clientAddr(req), login: clip(req.headers["tailscale-user-login"]), path });
        return json(res, 403, { error: "This Tailscale account isn't allowed to use this PC." });
      }
      // A web page elsewhere can't use this link: anything sent with a foreign Origin is refused.
      if (!this.sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      if (web) return serveWeb(path, res);
      this.handle(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) }));
    });
    srv.on("upgrade", (req, socket, head) => {
      viaServe.add(req);
      if (!req.url?.startsWith("/ws")) return socket.destroy();
      if (!this.serveIdentity(req) || !this.sameOrigin(req)) {
        audit({ event: "secure.refused", from: clientAddr(req), login: clip(req.headers["tailscale-user-login"]), path: "/ws", reason: clip(req.headers.origin, 120) });
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve());
    });
    this.servers.push(srv);
  }

  get hookUrl() {
    return `http://127.0.0.1:${this.config.port}/hook/pretool`;
  }

  async listen(addresses: string[]) {
    for (const addr of addresses) {
      const srv = createServer((req, res) => this.handle(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) })));
      srv.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/ws")) return socket.destroy();
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
      });
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(this.config.port, addr, () => resolve());
      });
      this.servers.push(srv);
    }
  }

  close() {
    this.wss.clients.forEach((c) => c.close(1001, "helper stopping"));
    this.servers.forEach((s) => s.close());
  }

  private hookAuthorised(req: IncomingMessage) {
    const got = Buffer.from(String(req.headers["x-ca-token"] ?? ""));
    const want = Buffer.from(this.hookToken);
    return isLoopback(req) && got.length === want.length && timingSafeEqual(got, want);
  }

  // ---------------- HTTP ----------------
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const port = this.config.port;

    if (req.method === "POST" && url.pathname === "/pair") return this.pair(req, res);

    // A browser's attachment, into the one-time slot it asked for over its authenticated WebSocket.
    if (req.method === "POST" && url.pathname.startsWith("/upload/")) {
      if (isDisabled()) return json(res, 404, { error: "not found" });
      const r = await receiveUpload(url.pathname.slice(8), String(req.headers["x-ca-upload"] ?? ""), req);
      return r.ok ? json(res, 200, { ok: true }) : json(res, r.code, { error: r.error });
    }

    // The phone downloads a file Claude offered it. The unguessable access key in the URL is the only credential.
    if (req.method === "GET" && url.pathname.startsWith("/file/")) {
      if (isDisabled()) return json(res, 404, { error: "not found" });
      return serveFile(decodeURIComponent(url.pathname.slice(6)), url.searchParams.get("a") ?? "", res);
    }

    // Phone app self-update: the access key is only sent to authenticated phones.
    if (req.method === "GET" && url.pathname === "/app/apk") {
      if (isDisabled()) return json(res, 404, { error: "not found" });
      return serveApk(url.searchParams.get("a") ?? "", res);
    }

    // Claude's phone tool hands a file to the phone (loopback only, same shared secret as the policy hook).
    if (req.method === "POST" && url.pathname === "/hook/send-file") {
      if (!this.hookAuthorised(req)) return json(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const session = body.sessionId ? this.sessions.bySessionId(String(body.sessionId)) : undefined;
      const wanted = String(body.path ?? "");
      // Applies even with "skip confirmations" on: credentials and the helper's own files never leave the PC.
      if (isSensitivePath(wanted) && !adminState(this.config).on) return json(res, 200, { ok: false, error: "That file holds credentials or keys, so it can't be sent." });
      const r = offerFile(wanted, String(body.caption ?? ""), session?.currentTurnId);
      audit({ event: "file.offer", sessionId: body.sessionId, decision: r.ok ? "offered" : "failed", reason: r.ok ? `${r.name} (${r.size} bytes)` : r.error, path: wanted });
      return json(res, 200, r);
    }

    if (req.method === "POST" && url.pathname === "/hook/pretool") {
      if (!this.hookAuthorised(req)) return json(res, 403, { error: "forbidden" });
      return json(res, 200, await this.onHook(await readBody(req)));
    }

    // Claude's ask_user tool: show the choices in the browser that sent the request and wait for the answer.
    if (req.method === "POST" && url.pathname === "/hook/ask") {
      if (!this.hookAuthorised(req)) return json(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const session = body.sessionId ? this.sessions.bySessionId(String(body.sessionId)) : undefined;
      const turnId = session?.currentTurnId;
      if (!session || !turnId) return json(res, 200, { ok: false, error: "No request is being worked on." });
      if (session.currentOrigin !== "browser") {
        return json(res, 200, { ok: false, error: "The user is on their phone, which can't show choices. Ask the question briefly in your reply instead." });
      }
      const questions = cleanQuestions(body.questions);
      if (!questions) return json(res, 200, { ok: false, error: "Each question needs text and at least two options." });
      const answers = await requestAnswers({ turnId, sessionId: session.cfg.id, questions, timeoutS: ASK_TIMEOUT_S });
      audit({ event: "ask", sessionId: session.cfg.id, turnId, decision: answers ? "answered" : "no answer", reason: questions.map((q) => q.question).join(" | ").slice(0, 300) });
      return json(res, 200, answers ? { ok: true, answers } : { ok: false, error: "The user didn't answer (skipped, timed out or not connected). Carry on with your best judgement, or ask in your reply." });
    }

    // Everything below is the local dashboard.
    if (viaServe.has(req) || !isLocalHost(req, port)) return json(res, 404, { error: "not found" });

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      return res.end(DASHBOARD_HTML);
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      // The dashboard asks on load; ?check=1 checks GitHub (at most every few minutes), &force=1 right now.
      if (url.searchParams.get("check") === "1") await checkForUpdate(url.searchParams.get("force") === "1");
      return json(res, 200, versionInfo());
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const connected = new Set(connectedDevices());
      return json(res, 200, {
        helperName: this.config.helperName,
        hosts: this.hosts,
        port,
        secure: { ...this.secure, allowedUsers: this.allowedUsers(), plainTailnet: this.config.plainTailnet !== false },
        disabled: isDisabled(),
        ...this.sessions.status(),
        sessions: this.sessions.list(),
        activeSessionId: this.sessions.activeId,
        devices: listDevices().map((d) => ({ ...d, connected: connected.has(d.deviceId) })),
        audit: recentAudit(40),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/doctor") return json(res, 200, { at: Date.now(), checks: await this.health() });
    if (req.method === "GET" && url.pathname === "/api/connectors") {
      const c = await listConnectors(this.config.claudePath, url.searchParams.get("refresh") === "1");
      return json(res, 200, { ...c, skipConfirmations: this.config.skipConfirmations });
    }
    // State-changing dashboard calls need a custom header (blocks simple cross-site form posts).
    if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, this.settingsView());
    if (req.method === "POST" && url.pathname === "/api/settings" && req.headers["x-ca-dashboard"] === "1") {
      const b = await readBody(req);
      const changed: string[] = [];
      if (typeof b.skipConfirmations === "boolean" && b.skipConfirmations !== this.config.skipConfirmations) {
        this.sessions.setSkipConfirmations(b.skipConfirmations);
        this.sessions.broadcastStatus(isDisabled());
        changed.push(`skip confirmations ${b.skipConfirmations ? "on" : "off"}`);
      }
      if (typeof b.chromeTools === "boolean" && b.chromeTools !== (this.config.chromeTools !== false)) {
        this.sessions.setChromeTools(b.chromeTools);
        changed.push(`browser tools ${b.chromeTools ? "on" : "off"}`);
      }
      if (typeof b.plainUpdates === "boolean" && b.plainUpdates !== (this.config.plainUpdates !== false)) {
        this.sessions.setPlainUpdates(b.plainUpdates);
        this.sessions.broadcastStatus(isDisabled());
        changed.push(`plain updates ${b.plainUpdates ? "on" : "off"}`);
      }
      if (typeof b.adminAllowAll === "string" && (ADMIN_CHOICES as readonly string[]).includes(b.adminAllowAll)) {
        this.setAdmin(b.adminAllowAll as AdminChoice, "dashboard");
        changed.push(`admin: allow everything ${b.adminAllowAll === "off" ? "off" : `on (${b.adminAllowAll})`}`);
      }
      const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : undefined);
      const confirmS = num(b.confirmTimeoutS, 10, 300);
      if (confirmS !== undefined && confirmS !== this.config.confirmTimeoutS) {
        this.config.confirmTimeoutS = confirmS;
        changed.push(`approval timeout ${confirmS}s`);
      }
      const progressS = num(b.progressAfterS, 3, 120);
      if (progressS !== undefined && progressS !== this.config.progressAfterS) {
        this.config.progressAfterS = progressS;
        changed.push(`"still working" after ${progressS}s`);
      }
      const everyS = num(b.progressEveryS, 5, 300);
      if (everyS !== undefined && everyS !== this.config.progressEveryS) {
        this.config.progressEveryS = everyS;
        changed.push(`"still working" repeats every ${everyS}s`);
      }
      let restart = false;
      if (typeof b.instructions === "string") {
        const text = b.instructions.slice(0, 20_000);
        // Saving the default text unchanged keeps following future default updates.
        const stored = text.trim() === VOICE_RULES.trim() ? "" : text;
        if (stored !== this.config.instructions) {
          this.config.instructions = stored;
          changed.push(stored ? "instructions edited" : "instructions reset to default");
          restart = true;
        }
      }
      saveConfig(this.config);
      const active = this.sessions.active.cfg;
      const model = typeof b.model === "string" && (MODELS as readonly string[]).includes(b.model) ? b.model : active.model;
      const effort = typeof b.effort === "string" && (EFFORTS as readonly string[]).includes(b.effort) ? (b.effort as SessionConfig["effort"]) : active.effort;
      if (model !== active.model || effort !== active.effort) {
        this.sessions.setModel(model, effort); // saves and restarts the CLIs itself
        changed.push(`model ${model}, effort ${effort}`);
      } else if (restart) {
        this.sessions.refreshAll();
      }
      if (changed.length) audit({ event: "settings.set", approver: "server", by: "dashboard", reason: changed.join("; ") });
      return json(res, 200, { ...this.settingsView(), changed });
    }
    if (req.method === "POST" && req.headers["x-ca-dashboard"] !== "1") return json(res, 403, { error: "forbidden" });
    if (req.method === "POST" && url.pathname === "/api/pair-code") {
      const qr = createPairCode(this.config.helperName, this.hosts, port, this.secure.host ? { host: this.secure.host, port: this.secure.port } : undefined);
      const text = JSON.stringify(qr);
      const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      audit({ event: "pair.code-issued", approver: "auto" });
      return json(res, 200, { qr, text, svg });
    }
    if (req.method === "POST" && url.pathname === "/api/revoke") {
      const { deviceId } = await readBody(req);
      const ok = revokeDevice(String(deviceId));
      disconnectDevice(String(deviceId));
      audit({ event: "device.revoked", deviceId, decision: ok ? "revoked" : "not-found" });
      return json(res, 200, { ok });
    }
    if (req.method === "POST" && url.pathname === "/api/update-helper") {
      audit({ event: "helper.update", approver: "server", by: "dashboard" });
      const r = startHelperUpdate("dashboard", (msg) => audit({ event: "helper.update", decision: "failed", reason: msg }));
      return json(res, 200, r);
    }
    if (req.method === "POST" && url.pathname === "/api/kill") {
      this.kill("dashboard");
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/disabled") {
      const { disabled } = await readBody(req);
      if (disabled) writeFileSync(DISABLED_FLAG, new Date().toISOString());
      else rmSync(DISABLED_FLAG, { force: true });
      if (disabled) this.kill("dashboard-disable");
      audit({ event: disabled ? "remote.disabled" : "remote.enabled", approver: "auto" });
      this.sessions.broadcastStatus(isDisabled());
      return json(res, 200, { disabled: isDisabled() });
    }
    return json(res, 404, { error: "not found" });
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    const now = Date.now();
    const from = clientAddr(req);
    const recent = (this.pairAttempts.get(from) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= PAIR_ATTEMPTS_PER_MIN) return json(res, 429, { error: "too many attempts" });
    recent.push(now);
    this.pairAttempts.set(from, recent);
    if (this.pairAttempts.size > 1000) this.pairAttempts.clear();
    const body = await readBody(req);
    if (!isObject(body)) return json(res, 400, { error: "bad request" });
    const out = redeemPairCode({ code: clip(body.code, 200), deviceName: clip(body.deviceName), platform: body.platform }, this.config.helperName);
    audit({ event: "pair.attempt", decision: out ? "paired" : "rejected", deviceName: clip(body.deviceName), from });
    if (!out) return json(res, 401, { error: "invalid or expired code" });
    return json(res, 200, out);
  }

  // ---------------- hook (policy gate) ----------------
  private async onHook(body: { sessionId?: string; tool: string; input: Record<string, any>; toolUseId?: string }) {
    const out = (decision: "allow" | "deny", reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: `Roam Desk: ${reason}` },
    });
    const session = body.sessionId ? this.sessions.bySessionId(body.sessionId) : undefined;
    const turnId = session?.currentTurnId ?? "";
    const base = { sessionId: body.sessionId, turnId, tool: body.tool, input: body.input };

    if (isDisabled()) {
      audit({ ...base, event: "tool", tier: "deny", decision: "deny", approver: "policy", reason: "remote access disabled" });
      return out("deny", "remote access is switched off on the PC");
    }
    if (!session) {
      audit({ ...base, event: "tool", tier: "deny", decision: "deny", approver: "policy", reason: "unknown session" });
      return out("deny", "unknown session");
    }

    const origin = session.currentOrigin ?? "phone";
    const d = await decide(body.tool, body.input ?? {}, { sessionCwd: session.cfg.cwd, origin });
    // Ben's "Admin: allow everything" (dashboard only, time-limited): nothing is asked or refused, all of it logged.
    if (adminState(this.config).on) {
      audit({ ...base, event: "tool", tier: d.tier, decision: "allow", approver: "auto", reason: `${d.reason}; admin: allow everything`, source: origin });
      return out("allow", "admin: allow everything is switched on");
    }
    if (origin === "browser") return this.browserHook(session, base, d, body, out);

    // The user chose to drop all safety prompts, including the hard-deny list. Credentials, keys and the
    // helper's own files (d.locked) stay off limits, and tools that aren't enabled stay unavailable.
    if (d.tier === "deny" && this.config.skipConfirmations && !d.locked && !/is not enabled/.test(d.reason)) {
      audit({ ...base, event: "tool", tier: "deny", decision: "allow", approver: "auto", reason: `${d.reason}; blocked list skipped (setting)` });
      broadcast("speak", { turnId, text: `Running a normally blocked action: ${d.reason}.`, priority: "low" });
      session.noteSpoken();
      return out("allow", "the user switched off all safety checks");
    }
    if (d.tier === "deny") {
      audit({ ...base, event: "tool", tier: "deny", decision: "deny", approver: "policy", reason: d.reason });
      return out("deny", `${d.reason}. This is blocked by policy and can't be approved remotely.`);
    }
    if (d.tier === 0) {
      audit({ ...base, event: "tool", tier: 0, decision: "allow", approver: "auto", reason: d.reason });
      return out("allow", d.reason);
    }
    if (d.tier === 1) {
      audit({ ...base, event: "tool", tier: 1, decision: "allow", approver: "auto", reason: d.reason });
      // Routine steps ("Edit hub.ts.") are only read aloud with Plain updates off; the phone still shows them.
      if (announcesRoutineSteps(this.config.plainUpdates)) {
        broadcast("speak", { turnId, text: `${d.summary.charAt(0).toUpperCase()}${d.summary.slice(1)}.`, priority: "low" });
        session.noteSpoken();
      }
      return out("allow", d.reason);
    }

    if (this.config.skipConfirmations) {
      audit({ ...base, event: "tool", tier: 2, decision: "allow", approver: "auto", reason: `${d.reason}; confirmations skipped (setting)` });
      broadcast("speak", { turnId, text: `${d.summary.charAt(0).toUpperCase()}${d.summary.slice(1)}.`, priority: "low" });
      session.noteSpoken();
      return out("allow", "confirmations are switched off by the user");
    }

    // Tier 2: spoken confirmation.
    const now = Date.now();
    this.tier2Times = this.tier2Times.filter((t) => now - t < 3_600_000);
    if (this.tier2Times.length >= TIER2_PER_HOUR) {
      audit({ ...base, event: "tool", tier: 2, decision: "deny", approver: "policy", reason: "tier 2 rate limit" });
      return out("deny", "too many approval requests this hour");
    }
    this.tier2Times.push(now);
    const command = body.tool === "PowerShell" ? String(body.input.command ?? "") : JSON.stringify(body.input).slice(0, 1500);
    const r = await requestConfirmation({ turnId, tier: 2, summary: d.summary, command, verb: d.verb, timeoutS: this.config.confirmTimeoutS });
    session.noteSpoken();
    const allowed = r.decision === "confirm";
    audit({ ...base, event: "tool", tier: 2, decision: allowed ? "allow" : "deny", approver: r.by !== "phone" ? "server" : r.heard === "[on-screen button]" ? "phone-button" : "voice", heard: r.heard, reason: `${d.reason}; ${r.decision}` });
    return allowed ? out("allow", "approved by voice") : out("deny", r.decision === "timeout" ? "no answer from the user, so it was not run" : "the user cancelled it");
  }

  /** A request typed in the web client: the session's permission mode decides; risky steps are approved in the browser. */
  private async browserHook(
    session: ClaudeSession,
    base: Record<string, unknown>,
    d: Awaited<ReturnType<typeof decide>>,
    body: { tool: string; input: Record<string, any>; toolUseId?: string },
    out: (decision: "allow" | "deny", reason: string) => unknown,
  ) {
    const mode: PermissionMode = session.cfg.permissionMode ?? "default";
    const v = browserVerdict(d, mode, body.tool);
    if (v.verdict === "deny") {
      audit({ ...base, event: "tool", tier: d.tier, decision: "deny", approver: "policy", reason: d.reason, source: "browser" });
      return out("deny", `${d.reason}. This is blocked by policy${d.locked ? "" : " (only bypass permissions lifts it)"}.`);
    }
    if (v.verdict === "allow") {
      audit({ ...base, event: "tool", tier: d.tier, decision: "allow", approver: "auto", reason: `${v.why} [${mode}]`, source: "browser" });
      return out("allow", v.why);
    }
    const now = Date.now();
    this.browserApprovalTimes = this.browserApprovalTimes.filter((t) => now - t < 3_600_000);
    if (this.browserApprovalTimes.length >= BROWSER_APPROVALS_PER_HOUR) {
      audit({ ...base, event: "tool", tier: 2, decision: "deny", approver: "policy", reason: "browser approval rate limit", source: "browser" });
      return out("deny", "too many approval requests this hour");
    }
    this.browserApprovalTimes.push(now);
    const command = body.tool === "PowerShell" ? String(body.input.command ?? "") : JSON.stringify(body.input).slice(0, 1500);
    const r = await requestConfirmation({
      turnId: session.currentTurnId ?? "", tier: 2, summary: d.summary || `use ${body.tool}`, command, verb: d.verb, timeoutS: BROWSER_APPROVAL_TIMEOUT_S,
      to: "browser", sessionId: session.cfg.id, tool: body.tool, toolUseId: body.toolUseId, input: trimInput(body.input),
    });
    const allowed = r.decision === "confirm";
    audit({ ...base, event: "tool", tier: 2, decision: allowed ? "allow" : "deny", approver: r.by === "phone" ? "browser" : "server", reason: `${d.reason}; ${r.decision} [${mode}]`, source: "browser" });
    return allowed ? out("allow", "approved in the browser") : out("deny", r.decision === "timeout" ? "no answer from the user, so it was not run" : "the user denied it");
  }

  // ---------------- WebSocket ----------------
  private onSocket(ws: WebSocket, req: IncomingMessage) {
    const addr = clientAddr(req);
    const pendingTotal = [...this.pending.values()].reduce((a, b) => a + b, 0);
    if (pendingTotal >= MAX_PENDING_SOCKETS || (this.pending.get(addr) ?? 0) >= MAX_PENDING_PER_ADDRESS) return ws.close(4029, "too many connections");
    this.pending.set(addr, (this.pending.get(addr) ?? 0) + 1);
    let counted = true;
    const unpend = () => {
      if (!counted) return;
      counted = false;
      const n = (this.pending.get(addr) ?? 1) - 1;
      if (n <= 0) this.pending.delete(addr);
      else this.pending.set(addr, n);
    };

    const nonce = randomBytes(32).toString("base64url");
    let deviceId: string | null = null;
    const authTimer = setTimeout(() => !deviceId && ws.close(4000, "auth timeout"), 10_000);
    sendDirect(ws, "auth.challenge", { nonce, helperId });

    const onAuth = (f: PhoneFrame) => {
      if (f.type !== "auth.response") return ws.close(4000, "auth required");
      const p = f.payload as Record<string, unknown>;
      const proof = verifyDevice(clip(p.deviceId), nonce, clip(p.mac, 200), clip(p.phoneNonce, 200));
      if (proof === null) {
        audit({ event: "auth.fail", deviceId: clip(p.deviceId), from: addr });
        sendDirect(ws, "auth.fail", { reason: "unknown device or bad signature" });
        return ws.close(4003, "auth failed");
      }
      deviceId = clip(p.deviceId);
      clearTimeout(authTimer);
      unpend();
      touchDevice(deviceId);
      const from = attach(deviceId, ws, Number(p.lastSeq) || 0);
      audit({ event: "auth.ok", deviceId, from: addr });
      sendDirect(ws, "auth.ok", {
        helperName: this.config.helperName,
        sessions: this.sessions.list(),
        activeSessionId: this.sessions.activeId,
        replayFrom: from,
        disabled: isDisabled(),
        ...(proof ? { proof } : {}),
        ...(audienceOf(deviceId) === "browser" ? { models: MODELS, efforts: EFFORTS } : {}),
      });
        replay(deviceId, ws, from);
        const update = updateOffer();
        if (update) sendDirect(ws, "app.update", update);
        if (takeUpdatedNotice()) {
          broadcast("speak", { text: "The PC helper has been updated and restarted.", priority: "normal" });
          notifyInbox("info", "The PC helper was updated", `Now running ${versionInfo().commit ?? "the latest version"}.`);
        }
        if (!isDisabled()) this.sessions.active.warm();
        sendDirect(ws, "status", { ...this.sessions.status(), disabled: isDisabled() });
        sendDirect(ws, "inbox", inboxView());
        sendDirect(ws, "routines", { items: routineList() });
        // Opening the web client (or a phone reconnecting) checks GitHub for a newer helper, at most every few minutes.
        const before = versionInfo().checkedAt;
        void checkForUpdate().then((v) => v.checkedAt !== before && this.sessions.broadcastStatus(isDisabled()));
        // Same for the connectors: if one needs signing in (Microsoft 365, say), every device is told with a link.
        void listConnectors(this.config.claudePath)
          .then(() => this.healStaleFlag())
          .then(() => this.sessions.broadcastStatus(isDisabled()));
    };

    ws.on("message", (raw) => {
      let f: PhoneFrame;
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return sendDirect(ws, "error", { code: "bad_json", message: "Frame is not JSON" });
      }
      // Anything that isn't { type: string, payload: object } is dropped before it's looked at.
      if (!isObject(f) || typeof f.type !== "string") return deviceId ? undefined : ws.close(4000, "auth required");
      if (!isObject(f.payload)) (f as any).payload = {};
      try {
        if (!deviceId) return onAuth(f);
        this.onFrame(deviceId, ws, f);
      } catch (e: any) {
        audit({ event: "frame.error", deviceId: deviceId ?? undefined, from: addr, type: clip(f.type), reason: clip(e?.message ?? e, 300) });
        if (!deviceId) ws.close(4000, "auth required");
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      unpend();
      if (deviceId) detach(deviceId, ws);
    });
    ws.on("error", () => ws.terminate());
  }

  private onFrame(deviceId: string, ws: WebSocket, f: PhoneFrame) {
    // "Remote access off" means off: only keep-alives, cancel and stop work until it's switched back on.
    if (isDisabled() && !ALLOWED_WHILE_DISABLED.has(f.type)) {
      return sendDirect(ws, "error", { code: "disabled", message: "Remote access is switched off on the PC." });
    }
    switch (f.type) {
      case "ping":
        return sendDirect(ws, "pong", {});
      case "ack":
        return;
      case "utterance": {
        const text = String(f.payload.text ?? "").trim().slice(0, 4000);
        if (!text) return;
        if (isDisabled()) {
          return broadcast("speak", { text: "Remote access is switched off on the PC.", priority: "normal" });
        }
        if (/^(stop|cancel) everything\.?$/i.test(text)) return this.kill("voice");
        const now = Date.now();
        const times = (this.utteranceTimes.get(deviceId) ?? []).filter((t) => now - t < 60_000);
        if (times.length >= UTTERANCES_PER_MIN) {
          audit({ event: "rate-limit", deviceId, text });
          return broadcast("speak", { text: "That's a lot of requests at once. Give me a moment.", priority: "normal" });
        }
        times.push(now);
        this.utteranceTimes.set(deviceId, times);
        const session = (f.payload.sessionId && this.sessions.get(f.payload.sessionId)) || this.sessions.active;
        const origin = audienceOf(deviceId) === "browser" ? "browser" : "phone";
        audit({ event: "utterance", deviceId, sessionId: session.cfg.id, text, source: origin === "browser" ? "browser" : f.payload.source });
        if (origin === "browser" && Array.isArray(f.payload.attachments) && f.payload.attachments.length) {
          const a = takeAttachments(deviceId, f.payload.attachments);
          if (a.missing) sendDirect(ws, "error", { code: "attachment_missing", message: `${a.missing} attachment${a.missing === 1 ? " wasn't" : "s weren't"} uploaded, so ${a.missing === 1 ? "it was" : "they were"} left out.` });
          session.send(text + a.filesNote, origin, { images: a.images, attachments: a.infos });
          return;
        }
        session.send(text, origin);
        return;
      }
      case "upload.begin": {
        if (audienceOf(deviceId) !== "browser") return;
        const ref = clip(f.payload.ref, 64);
        const r = beginUpload(deviceId, { name: clip(f.payload.name, 200), size: f.payload.size, mime: clip(f.payload.mime, 100) });
        if (!r.ok) return sendDirect(ws, "error", { code: "upload_refused", message: r.error });
        sendDirect(ws, "upload.ready", { ref, uploadId: r.id, token: r.token, maxBytes: MAX_UPLOAD_BYTES });
        return;
      }
      case "files.search": {
        const s = this.sessions.get(clip(f.payload.sessionId));
        if (!s || audienceOf(deviceId) !== "browser") return;
        const query = clip(f.payload.query, 200);
        void searchFiles(s.cfg.cwd, query).then((items) => sendDirect(ws, "files", { sessionId: s.cfg.id, query, items }), () => sendDirect(ws, "files", { sessionId: s.cfg.id, query, items: [] }));
        return;
      }
      case "history.page": {
        const s = this.sessions.get(clip(f.payload.sessionId));
        if (!s || audienceOf(deviceId) !== "browser") return;
        const c = Number(f.payload.cursor);
        const b = Number(f.payload.beforeTs);
        const cursor = Number.isInteger(c) && c > 0 ? c : undefined;
        const beforeTs = Number.isFinite(b) && b > 0 ? b : undefined;
        const file = s.cfg.claudeSessionId ? sessionFile(s.cfg.claudeSessionId) : null;
        if (!file) return sendDirect(ws, "history.page", { sessionId: s.cfg.id, entries: [], cursor: null, requested: cursor ?? null });
        try {
          const page = readHistoryPage(file, { cursor, beforeTs });
          sendDirect(ws, "history.page", { sessionId: s.cfg.id, entries: page.entries, cursor: page.cursor, requested: cursor ?? null });
        } catch (e: any) {
          audit({ event: "history.get", deviceId, sessionId: s.cfg.id, decision: "failed", reason: String(e?.message ?? e) });
          sendDirect(ws, "history.page", { sessionId: s.cfg.id, entries: [], cursor: null, requested: cursor ?? null });
        }
        return;
      }
      case "changes.get": {
        const s = this.sessions.get(clip(f.payload.sessionId));
        if (!s || audienceOf(deviceId) !== "browser") return;
        void workspaceChanges(s.cfg.cwd).then(
          (c) => sendDirect(ws, "changes", { sessionId: s.cfg.id, ...c }),
          (e) => sendDirect(ws, "changes", { sessionId: s.cfg.id, git: true, root: null, branch: null, files: [], error: `git couldn't list the changes (${String(e?.message ?? e).split("\n")[0].slice(0, 160)})` }),
        );
        return;
      }
      case "file.read": {
        const s = this.sessions.get(clip(f.payload.sessionId));
        if (!s || audienceOf(deviceId) !== "browser") return;
        const requested = clip(f.payload.path, 1000);
        void readWorkspaceFile(s.cfg.cwd, requested).then(
          (r) => sendDirect(ws, "file.content", { sessionId: s.cfg.id, requested, ...r }),
          () => sendDirect(ws, "file.content", { sessionId: s.cfg.id, requested, path: requested, kind: "error", size: 0, error: "That file couldn't be read." }),
        );
        return;
      }
      case "folders.list": {
        if (audienceOf(deviceId) !== "browser") return;
        const path = typeof f.payload.path === "string" && f.payload.path.trim() ? f.payload.path.trim().slice(0, 500) : undefined;
        const recent = [...new Set(this.sessions.list().map((s) => s.cwd))].slice(0, 6);
        sendDirect(ws, "folders", listFolders(path, recent));
        return;
      }
      case "commands.get": {
        const s = this.sessions.get(clip(f.payload.sessionId));
        if (!s || audienceOf(deviceId) !== "browser") return;
        sendDirect(ws, "commands", { sessionId: s.cfg.id, commands: s.commands ?? lastCommands });
        return;
      }
      case "confirm.response":
        answerConfirmation(String(f.payload.confirmId), f.payload.decision, String(f.payload.heard ?? "").slice(0, 300));
        return;
      case "ask.response": {
        const raw = f.payload.answers;
        let answers: Record<string, string> | null = null;
        if (isObject(raw)) {
          answers = {};
          for (const [k, v] of Object.entries(raw).slice(0, 8)) answers[clip(k, 400)] = clip(v, 2000);
        }
        settleAsk(clip(f.payload.askId), answers);
        return;
      }
      case "session.settings": {
        const p = f.payload;
        const fromBrowser = audienceOf(deviceId) === "browser";
        let mode = (PERMISSION_MODES as readonly string[]).includes(String(p.permissionMode)) ? (p.permissionMode as PermissionMode) : undefined;
        if (mode && !fromBrowser) {
          sendDirect(ws, "error", { code: "mode_refused", message: "Permission modes are set from the web client." });
          mode = undefined;
        }
        if (mode === "bypassPermissions" && p.bypassAcknowledged !== true) {
          sendDirect(ws, "error", { code: "bypass_unacknowledged", message: "Bypass permissions needs the warning to be accepted." });
          return;
        }
        const model = typeof p.model === "string" && (MODELS as readonly string[]).includes(p.model) ? p.model : undefined;
        const effort = typeof p.effort === "string" && (EFFORTS as readonly string[]).includes(p.effort) ? (p.effort as SessionConfig["effort"]) : undefined;
        const name = typeof p.name === "string" ? clip(p.name, 60) : undefined;
        const changed = this.sessions.updateSettings(clip(p.sessionId), { permissionMode: mode, model, effort, name });
        if (changed.length) audit({ event: "session.settings", deviceId, sessionId: clip(p.sessionId), reason: changed.join("; ") });
        return;
      }
      case "turn.cancel": {
        let any = false;
        for (const s of this.sessions.list()) {
          const sess = this.sessions.get(s.id)!;
          if (!f.payload.turnId || sess.currentTurnId === f.payload.turnId) any = sess.cancel() || any;
        }
        if (any && audienceOf(deviceId) !== "browser") broadcast("speak", { text: "Cancelled.", priority: "interrupt" });
        audit({ event: "turn.cancel", deviceId, turnId: f.payload.turnId });
        return;
      }
      case "kill":
        return this.kill("phone");
      case "session.new":
        if (
          !this.sessions.create(
            clip(f.payload.name, 200),
            typeof f.payload.cwd === "string" ? f.payload.cwd.slice(0, 500) : undefined,
            // Sessions started in the browser get written (not spoken) replies.
            f.payload.surface === "desktop" || (f.payload.surface !== "voice" && audienceOf(deviceId) === "browser") ? "desktop" : "voice",
          )
        ) {
          broadcast("speak", { text: "There are too many sessions. Hand some back to the PC first.", priority: "normal" });
        }
        return;
      case "session.select":
        if (!this.sessions.select(String(f.payload.sessionId))) sendDirect(ws, "error", { code: "no_session", message: "No such session" });
        return;
      case "history.get": {
        const s = (f.payload.sessionId && this.sessions.get(String(f.payload.sessionId))) || this.sessions.active;
        const limit = Math.min(300, Math.max(1, Math.round(Number(f.payload.limit) || 150)));
        let items: ReturnType<typeof loadHistory> = [];
        try {
          items = s.cfg.claudeSessionId ? loadHistory(s.cfg.claudeSessionId, limit) : [];
        } catch (e: any) {
          audit({ event: "history.get", deviceId, sessionId: s.cfg.id, decision: "failed", reason: String(e?.message ?? e) });
        }
        sendDirect(ws, "history", { sessionId: s.cfg.id, items });
        return;
      }
      case "helper.update": {
        audit({ event: "helper.update", deviceId, approver: "phone-button" });
        const r = startHelperUpdate("phone", (msg) => {
          audit({ event: "helper.update", decision: "failed", reason: msg });
          broadcast("speak", { text: msg, priority: "normal" });
        });
        broadcast("speak", { text: r.message, priority: "normal" });
        return;
      }
      case "inbox.read":
        return markInboxRead();
      case "inbox.clear":
        return clearInbox();
      case "routine.save": {
        const r = saveRoutine({ id: typeof f.payload.id === "string" ? f.payload.id : undefined, name: String(f.payload.name ?? ""), prompt: String(f.payload.prompt ?? ""), schedule: f.payload.schedule as any, enabled: f.payload.enabled !== false });
        audit({ event: "routine.save", deviceId, decision: r.ok ? "saved" : "refused", reason: r.ok ? r.routine.name : r.reason });
        if (!r.ok) sendDirect(ws, "error", { code: "routine", message: r.reason });
        this.sendRoutines();
        return;
      }
      case "routine.delete":
        audit({ event: "routine.delete", deviceId, decision: deleteRoutine(String(f.payload.id ?? "")) ? "deleted" : "not-found" });
        this.sendRoutines();
        return;
      case "routine.run":
        if (!runNow(this.config.claudePath, String(f.payload.id ?? ""), () => this.sendRoutines(), (r, ok, text) => this.routineDone(r, ok, text))) sendDirect(ws, "error", { code: "routine", message: "That routine is already running, or doesn't exist." });
        return;
      case "doctor.run":
        void this.health().then((checks) => sendDirect(ws, "doctor", { at: Date.now(), checks }));
        return;
      case "connectors.check": {
        // After signing in on claude.ai: look again now, and tell every device what's still waiting.
        void listConnectors(this.config.claudePath, true).then((c) => {
          this.sessions.broadcastStatus(isDisabled());
          const waiting = needsSignIn();
          broadcast("speak", { text: waiting.length ? `Still waiting for you to sign in to ${waiting.join(" and ")}.` : c.items.length ? "All your connectors are signed in." : "Couldn't check the connectors.", priority: "normal" });
        });
        return;
      }
      case "app.check": {
        const update = updateOffer();
        sendDirect(ws, update ? "app.update" : "error", update ?? { code: "no_build", message: "No app build found on the PC." });
        return;
      }
      case "catalog.list":
        sendDirect(ws, "catalog", { items: this.sessions.catalog() });
        return;
      case "session.attach": {
        // Continued from a browser: written replies, not the phone's spoken style.
        const surface = f.payload.surface === "desktop" || (f.payload.surface !== "voice" && audienceOf(deviceId) === "browser") ? "desktop" : "voice";
        const r = this.sessions.attach(String(f.payload.claudeSessionId ?? ""), surface);
        audit({ event: "session.attach", deviceId, claudeSessionId: f.payload.claudeSessionId, decision: r.ok ? "attached" : "failed", reason: r.ok ? r.item.title : r.reason });
        if (!r.ok) {
          sendDirect(ws, "error", { code: "attach_failed", message: r.reason });
          broadcast("speak", { text: r.reason, priority: "normal" });
          return;
        }
        const warn = r.item.activeRecently && r.item.origin !== "phone" ? " It was in use on the PC a few minutes ago, so close it there before carrying on." : "";
        broadcast("speak", { text: `Continuing ${r.item.title}, in ${r.item.project}.${warn} Ask "where were we?" for a recap.`, priority: "normal" });
        return;
      }
      case "session.release": {
        const r = this.sessions.release(String(f.payload.sessionId ?? ""));
        audit({ event: "session.release", deviceId, sessionId: f.payload.sessionId, decision: r.ok ? "released" : "failed", reason: r.ok ? `${r.name}; desktop ${r.desktop}` : r.reason });
        const where = r.ok && r.desktop === "registered" ? " It's been added to the Claude desktop app; restart the app if it isn't in the list yet." : "";
        broadcast("speak", { text: r.ok ? `Handed ${r.name} back to your PC.${where}` : r.reason, priority: "normal" });
        return;
      }
      case "settings.set": {
        // The phone can turn "skip confirmations" off, but only the PC dashboard can turn it on:
        // a lost or stolen phone mustn't be able to remove every safety check in one tap.
        if (f.payload.skipConfirmations === true && !this.config.skipConfirmations) {
          audit({ event: "settings.set", deviceId, decision: "refused", reason: "skip confirmations can only be turned on from the PC dashboard" });
          broadcast("speak", { text: "For safety, skipping confirmations can only be turned on from the dashboard on your PC.", priority: "normal" });
          this.sessions.broadcastStatus(isDisabled());
        } else if (f.payload.skipConfirmations === false && this.config.skipConfirmations) {
          this.sessions.setSkipConfirmations(false);
          audit({ event: "settings.set", deviceId, skipConfirmations: false });
          broadcast("speak", { text: "Confirmations are back on.", priority: "normal" });
          this.sessions.broadcastStatus(isDisabled());
        }
        // A phone or browser can switch "Admin: allow everything" off, never on.
        const admin = deviceAdminRequest((f.payload as Record<string, unknown>).adminAllowAll);
        if (admin === "off" && adminState(this.config).on) this.setAdmin("off", deviceId);
        if (admin === "refuse") {
          audit({ event: "settings.set", deviceId, decision: "refused", reason: "admin: allow everything can only be turned on from the PC dashboard" });
          sendDirect(ws, "error", { code: "admin_refused", message: "Admin: allow everything can only be turned on from the dashboard on the PC." });
        }
        if (typeof f.payload.plainUpdates === "boolean") {
          this.sessions.setPlainUpdates(f.payload.plainUpdates);
          audit({ event: "settings.set", deviceId, plainUpdates: f.payload.plainUpdates });
          this.sessions.broadcastStatus(isDisabled());
        }
        return;
      }
      case "session.reset":
        this.sessions.reset(f.payload.sessionId);
        broadcast("speak", { text: "Started a fresh conversation.", priority: "normal" });
        return;
      default:
        return; // unknown types are ignored
    }
  }

  private settingsView() {
    const active = this.sessions.active.cfg;
    return {
      instructions: this.config.instructions?.trim() ? this.config.instructions : VOICE_RULES,
      instructionsCustomised: Boolean(this.config.instructions?.trim()),
      defaultInstructions: VOICE_RULES,
      model: active.model,
      effort: active.effort,
      models: MODELS,
      efforts: EFFORTS,
      confirmTimeoutS: this.config.confirmTimeoutS,
      progressAfterS: this.config.progressAfterS,
      progressEveryS: this.config.progressEveryS ?? 20,
      skipConfirmations: this.config.skipConfirmations,
      plainUpdates: this.config.plainUpdates !== false,
      chromeTools: this.config.chromeTools !== false,
      adminAllowUntil: adminState(this.config).until,
    };
  }

  kill(by: string) {
    this.sessions.killAll();
    audit({ event: "kill", approver: "auto", by });
    broadcast("speak", { text: "Stopped everything.", priority: "interrupt" });
    this.sessions.broadcastStatus(isDisabled());
  }
}
