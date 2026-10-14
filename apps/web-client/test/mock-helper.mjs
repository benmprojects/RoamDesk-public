// A stand-in for the desktop helper, for working on the web client without touching the real PC:
// serves this folder with the helper's security headers, pairs, authenticates like the helper (HMAC both ways),
// and plays a scripted conversation that uses every kind of entry (tools, diff, approval, question, plan, file).
//
//   node apps/web-client/test/mock-helper.mjs [port]     then open http://127.0.0.1:<port>/
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = Number(process.argv[2]) || 8799;
const HELPER_ID = "hlp_mock";
// Fixed so a paired browser keeps working across mock restarts. Development only: it's public in this file.
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const DEVICE = "dev_mock";
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const mac = (text) => createHmac("sha256", Buffer.from(SECRET, "base64url")).update(text, "utf8").digest("base64url");

let inbox = {
  items: [
    { id: "i_1", ts: Date.now() - 3600_000, kind: "warn", title: "Microsoft 365 signed out", text: "Claude can't use Microsoft 365 until it's signed in again.", read: false },
    { id: "i_2", ts: Date.now() - 86400_000, kind: "info", title: "The PC helper was updated", text: "Now running 698f737.", read: true },
  ],
  unread: 1,
};
let routines = [];

const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const sessions = [
  { id: "s_main", name: "Tender register tidy-up", cwd: "C:\\Users\\ben\\Projects\\tenders", model: "claude-sonnet-5-5", effort: "medium", permissionMode: "default", surface: "desktop", busy: false, queued: 0, claudeSessionId: "abc" },
  { id: "home", name: "Home", cwd: "C:\\Users\\ben", model: "claude-sonnet-5-5", effort: "medium", permissionMode: "default", surface: "voice", busy: false, queued: 0 },
];
let seq = 0;
const sockets = new Set();
const send = (ws, type, payload, buffered = true) => ws.send(JSON.stringify({ v: 1, type, id: randomBytes(6).toString("hex"), ts: Date.now(), ...(buffered ? { seq: ++seq } : {}), payload }));
const all = (type, payload) => sockets.forEach((ws) => send(ws, type, payload));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pendingConfirms = new Map();
const uploads = new Map();
const MOCK_FILES = ["register.md", "src/app.ts", "src/components/AppHeader.tsx", "docs/Tender process.docx", "README.md", "test/app.test.ts"];
const MOCK_COMMANDS = ["compact", "context", "clear", "init", "review", "code-review", "deep-review:deep-review", "security-review", "simplify"].map((name) => ({ name, skill: /review:|simplify|code-review/.test(name) }));
const pendingAsks = new Map();

function list() {
  all("session.list", { sessions, activeSessionId: "s_main" });
}

async function stream(turnId, text) {
  for (const w of text.match(/\S+\s*/g) ?? []) {
    all("reply.delta", { turnId, text: w });
    await wait(25);
  }
}

let n = 0;
const item = (turnId, sessionId, it) => all("turn.item", { turnId, sessionId, item: it });

async function scripted(sessionId, text) {
  const s = sessions.find((x) => x.id === sessionId) ?? sessions[0];
  const turnId = `t_${++n}`;
  s.busy = true;
  list();
  all("turn.started", { turnId, sessionId: s.id, text, origin: "browser" });
  await wait(300);
  item(turnId, s.id, { kind: "thinking", id: `${turnId}:th`, text: "The user wants the register tidied. I'll look at the file first, then fix the dates." });
  const intro = "I'll check the register first.";
  await stream(turnId, intro);
  item(turnId, s.id, { kind: "text", id: `${turnId}:1`, text: intro });
  item(turnId, s.id, { kind: "tool_use", id: `${turnId}_read`, name: "Read", input: { file_path: "C:\\Users\\ben\\Projects\\tenders\\register.md" } });
  await wait(400);
  item(turnId, s.id, { kind: "tool_result", id: `${turnId}:2`, toolUseId: `${turnId}_read`, output: "| Tender | Closes |\n|---|---|\n| Eagle Farm park | 2026-10-14 |", isError: false, truncated: false });
  item(turnId, s.id, { kind: "tool_use", id: `${turnId}_edit`, name: "Edit", input: { file_path: "C:\\Users\\ben\\Projects\\tenders\\register.md", old_string: "| Tender | Closes |\n|---|---|\n| Eagle Farm park | 2026-10-14 |", new_string: "| Tender | Closes |\n|---|---|\n| Eagle Farm park | 14/10/2026 |" } });
  await wait(300);
  item(turnId, s.id, { kind: "tool_result", id: `${turnId}:3`, toolUseId: `${turnId}_edit`, output: "The file has been updated.", isError: false, truncated: false });
  // A risky step that needs approval in the browser.
  item(turnId, s.id, { kind: "tool_use", id: `${turnId}_ps`, name: "PowerShell", input: { command: "Remove-Item C:\\Users\\ben\\Projects\\tenders\\old -Recurse", description: "Delete the old tenders folder" } });
  const confirmId = `c_${n}`;
  all("confirm.request", { confirmId, turnId, sessionId: s.id, toolUseId: `${turnId}_ps`, tier: 2, summary: "Delete the old tenders folder", command: "Remove-Item C:\\Users\\ben\\Projects\\tenders\\old -Recurse", phrase: "confirm delete", expiresInS: 570, tool: "PowerShell", input: {} });
  const ok = await new Promise((r) => pendingConfirms.set(confirmId, r));
  all("confirm.resolved", { confirmId, decision: ok ? "confirm" : "cancel", by: "phone" });
  item(turnId, s.id, { kind: "tool_result", id: `${turnId}:4`, toolUseId: `${turnId}_ps`, output: ok ? "" : "Roam Desk: the user denied it", isError: !ok, truncated: false });
  // A question with choices.
  item(turnId, s.id, { kind: "tool_use", id: `${turnId}_ask`, name: "mcp__phone__ask_user", input: { questions: [{ question: "Which date format should the register use?" }] } });
  const askId = `q_${n}`;
  all("ask.request", { askId, turnId, sessionId: s.id, expiresInS: 840, questions: [{ question: "Which date format should the register use?", header: "Dates", options: [{ label: "DD/MM/YYYY", description: "Australian, as in the IMS" }, { label: "YYYY-MM-DD", description: "Sorts correctly as text" }] }] });
  const answers = await new Promise((r) => pendingAsks.set(askId, r));
  all("ask.resolved", { askId, answered: answers !== null });
  item(turnId, s.id, { kind: "tool_result", id: `${turnId}:5`, toolUseId: `${turnId}_ask`, output: answers ? `The user answered: ${JSON.stringify(answers)}` : "No answer", isError: !answers, truncated: false });
  const reply = `Done. Here's what changed:\n\n- Closing dates now use **${answers ? Object.values(answers)[0] : "DD/MM/YYYY"}**\n- The old folder was ${ok ? "deleted" : "kept (you denied it)"}\n\n\`\`\`powershell\nGet-Content register.md\n\`\`\`\n\n| Tender | Closes |\n|---|---|\n| Eagle Farm park | 14/10/2026 |`;
  await stream(turnId, reply);
  item(turnId, s.id, { kind: "text", id: `${turnId}:6`, text: reply });
  all("file", { fileId: `f_${n}`, turnId, name: "register.md", size: 2048, mime: "text/markdown", caption: "The updated register", access: "mockaccess", expiresAt: Date.now() + 3_600_000 });
  all("turn.usage", { turnId, sessionId: s.id, contextTokens: 61_250, contextWindow: 200_000 });
  all("turn.done", { turnId, text: reply, durationMs: 4200 });
  s.busy = false;
  list();
}

async function attached(sessionId, text, ids) {
  const s = sessions.find((x) => x.id === sessionId) ?? sessions[0];
  const turnId = `t_${++n}`;
  const infos = ids.map((id) => uploads.get(id)).filter((u) => u?.done).map((u) => ({ name: u.name, mime: u.mime, size: u.size, kind: u.mime.startsWith("image/") ? "image" : "file", ...(u.mime.startsWith("image/") ? {} : { path: `C:\\Users\\ben\\AppData\\Local\\ClaudeAnywhereUploads\\x\\${u.name}` }) }));
  const files = infos.filter((i) => i.kind === "file");
  const note = files.length ? `\n\nAttached files (saved on this PC; read them as needed):\n${files.map((f) => `- ${f.name}: ${f.path}`).join("\n")}` : "";
  all("turn.started", { turnId, sessionId: s.id, text: text + note, origin: "browser", attachments: infos });
  const reply = `I received ${infos.length} attachment${infos.length === 1 ? "" : "s"}: ${infos.map((i) => `**${i.name}** (${i.kind})`).join(", ")}.`;
  await stream(turnId, reply);
  item(turnId, s.id, { kind: "text", id: `${turnId}:1`, text: reply });
  all("turn.done", { turnId, text: reply, durationMs: 500 });
}

async function planned(sessionId, text) {
  const s = sessions.find((x) => x.id === sessionId);
  const turnId = `t_${++n}`;
  s.busy = true;
  list();
  all("turn.started", { turnId, sessionId: s.id, text, origin: "browser" });
  item(turnId, s.id, { kind: "tool_use", id: `${turnId}_w`, name: "Write", input: { file_path: "C:\\Users\\ben\\.claude\\plans\\tidy.md", content: "# Plan\n\n1. Convert dates to DD/MM/YYYY\n2. Remove the old folder\n3. Re-sort by closing date" } });
  item(turnId, s.id, { kind: "tool_result", id: `${turnId}:1`, toolUseId: `${turnId}_w`, output: "File created", isError: false, truncated: false });
  item(turnId, s.id, { kind: "plan", id: `${turnId}:2`, path: "C:\\Users\\ben\\.claude\\plans\\tidy.md", text: "# Plan\n\n1. Convert dates to DD/MM/YYYY\n2. Remove the old folder\n3. Re-sort by closing date" });
  const reply = "The plan is ready for your approval.";
  await stream(turnId, reply);
  item(turnId, s.id, { kind: "text", id: `${turnId}:3`, text: reply });
  all("turn.done", { turnId, text: reply, durationMs: 900 });
  s.busy = false;
  list();
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/pair") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ deviceId: DEVICE, deviceSecret: SECRET, helperId: HELPER_ID, helperName: "MOCK-PC" }));
  }
  if (req.method === "POST" && url.pathname.startsWith("/upload/")) {
    const id = url.pathname.slice(8);
    const slot = uploads.get(id);
    let size = 0;
    req.on("data", (c) => (size += c.length));
    req.on("end", () => {
      const ok = slot && slot.token === req.headers["x-ca-upload"] && size === slot.size;
      if (ok) slot.done = true;
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { ok: true } : { error: "bad upload" }));
    });
    return;
  }
  if (url.pathname.startsWith("/file/")) {
    res.writeHead(200, { "content-type": "text/markdown", "content-disposition": 'attachment; filename="register.md"', "content-security-policy": "sandbox; default-src 'none'" });
    return res.end("| Tender | Closes |\n|---|---|\n| Eagle Farm park | 14/10/2026 |\n");
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT + sep) || !existsSync(file) || !statSync(file).isFile() || rel.startsWith("test")) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": TYPES[file.split(".").pop()] ?? "application/octet-stream", "content-security-policy": CSP, "cache-control": "no-cache" });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const nonce = randomBytes(16).toString("base64url");
  let authed = false;
  send(ws, "auth.challenge", { nonce, helperId: HELPER_ID }, false);
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    const p = f.payload ?? {};
    if (!authed) {
      if (f.type !== "auth.response" || p.deviceId !== DEVICE || p.mac !== mac(`${nonce}|${DEVICE}`)) return ws.close(4003);
      authed = true;
      sockets.add(ws);
      send(ws, "auth.ok", { helperName: "MOCK-PC", sessions, activeSessionId: "s_main", replayFrom: 0, disabled: false, proof: mac(`helper|${p.phoneNonce}|${nonce}|${DEVICE}|${HELPER_ID}`), models: MODELS, efforts: EFFORTS }, false);
      send(ws, "status", { busy: false, queued: 0, disabled: false, skipConfirmations: false, plainUpdates: true, version: { commit: "9f84abf", date: "2026-10-12T11:17:50+10:00", behind: 2, checkedAt: Date.now() }, signIn: { names: ["Microsoft 365"], url: "https://claude.ai/customize/connectors" } });
      send(ws, "inbox", inbox, false);
      send(ws, "routines", { items: routines }, false);
      return;
    }
    switch (f.type) {
      case "inbox.read":
        inbox.items.forEach((i) => (i.read = true));
        inbox.unread = 0;
        send(ws, "inbox", inbox, false);
        return;
      case "inbox.clear":
        inbox = { items: [], unread: 0 };
        send(ws, "inbox", inbox, false);
        return;
      case "routine.save": {
        const id = p.id ?? `r_${routines.length + 1}`;
        const r = { id, name: p.name, prompt: p.prompt, schedule: p.schedule, enabled: p.enabled, nextRunAt: p.enabled ? Date.now() + 3600_000 : null };
        const i = routines.findIndex((x) => x.id === id);
        if (i >= 0) routines[i] = { ...routines[i], ...r };
        else routines.push(r);
        send(ws, "routines", { items: routines }, false);
        return;
      }
      case "routine.delete":
        routines = routines.filter((r) => r.id !== p.id);
        send(ws, "routines", { items: routines }, false);
        return;
      case "routine.run": {
        const r = routines.find((x) => x.id === p.id);
        if (r) {
          r.lastRunAt = Date.now();
          r.lastStatus = "ok";
          inbox.items.unshift({ id: `i_${Date.now()}`, ts: Date.now(), kind: "routine", title: r.name, text: "Two tenders close this week: Eagle Farm park (14/10/2026) and the Bulimba boardwalk (16/10/2026).", read: false });
          inbox.unread += 1;
          send(ws, "routines", { items: routines }, false);
          send(ws, "inbox", inbox, false);
        }
        return;
      }
      case "doctor.run":
        send(ws, "doctor", { at: Date.now(), checks: [
          { name: "Helper version", status: "ok", detail: "Running 698f737, up to date." },
          { name: "Microsoft 365", status: "bad", detail: "Needs signing in.", fix: "Sign in at https://claude.ai/customize/connectors" },
          { name: "Desktop control", status: "warn", detail: "Not connected.", fix: "Restart the helper." },
        ] }, false);
        return;
      case "connectors.check":
        // The mock pretends the sign-in worked.
        send(ws, "status", { busy: false, queued: 0, disabled: false, skipConfirmations: false, plainUpdates: true, signIn: { names: [], url: "https://claude.ai/customize/connectors" } });
        return;
      case "utterance":
        if (Array.isArray(p.attachments) && p.attachments.length) {
          attached(p.sessionId, p.text, p.attachments);
          break;
        }
        if (/plan/i.test(p.text)) planned(p.sessionId, p.text);
        else scripted(p.sessionId, p.text);
        break;
      case "upload.begin": {
        const id = `up_${randomBytes(4).toString("hex")}`;
        const token = randomBytes(8).toString("hex");
        uploads.set(id, { token, size: p.size, name: p.name, mime: p.mime });
        send(ws, "upload.ready", { ref: p.ref, uploadId: id, token, maxBytes: 25 * 1024 * 1024 }, false);
        break;
      }
      case "files.search": {
        const q = String(p.query ?? "").toLowerCase();
        send(ws, "files", { sessionId: p.sessionId, query: p.query, items: MOCK_FILES.filter((x) => x.toLowerCase().includes(q)) }, false);
        break;
      }
      case "history.page": {
        // Two pages of earlier conversation for the main session; the second is the start.
        const t0 = Date.now() - 86_400_000;
        const older = !p.cursor
          ? [
              { kind: "user", id: "h:u3", text: "Can you check the register for duplicate tenders?", ts: t0 + 30_000 },
              { kind: "tool_use", id: "toolu_h1", name: "Grep", input: { pattern: "Eagle Farm", path: "C:\\Users\\ben\\Projects\\tenders" }, ts: t0 + 31_000 },
              { kind: "tool_result", id: "h:r1", toolUseId: "toolu_h1", output: "register.md:3:| Eagle Farm park | 14/10/2026 |", isError: false, truncated: false, ts: t0 + 32_000 },
              { kind: "text", id: "h:t3", text: "No duplicates: **Eagle Farm park** appears once.", ts: t0 + 33_000 },
            ]
          : [
              { kind: "user", id: "h:u1", text: "Start a register of open tenders", ts: t0 },
              { kind: "tool_use", id: "toolu_h0", name: "Write", input: { file_path: "C:\\Users\\ben\\Projects\\tenders\\register.md", content: "| Tender | Closes |\n|---|---|\n| Eagle Farm park | 2026-10-14 |\n" }, ts: t0 + 1000 },
              { kind: "tool_result", id: "h:r0", toolUseId: "toolu_h0", output: "File created", isError: false, truncated: false, ts: t0 + 2000 },
              { kind: "note", id: "h:n0", text: "Conversation compacted automatically (410,677 → 17,496 tokens).", ts: t0 + 3000 },
            ];
        send(ws, "history.page", { sessionId: p.sessionId, entries: p.sessionId === "s_main" ? older : [], cursor: p.sessionId === "s_main" && !p.cursor ? 1 : null, requested: p.cursor ?? null }, false);
        break;
      }
      case "changes.get":
        send(ws, "changes", {
          sessionId: p.sessionId, git: p.sessionId === "s_main", root: "C:\\Users\\ben\\Projects\\tenders", branch: "main", files: p.sessionId !== "s_main" ? [] : [
            { path: "register.md", status: "M", added: 1, removed: 1, truncated: false, diff: "diff --git a/register.md b/register.md\n--- a/register.md\n+++ b/register.md\n@@ -1,3 +1,3 @@\n | Tender | Closes |\n |---|---|\n-| Eagle Farm park | 2026-10-14 |\n+| Eagle Farm park | 14/10/2026 |\n" },
            { path: "notes\\a-very-long-folder-name-for-testing-overflow\\and-an-even-longer-file-name-that-should-be-cut-short.md", status: "?", added: 2, removed: 0, truncated: false, diff: "@@ new file @@\n+# Notes\n+Check the bond." },
            { path: "old\\draft.txt", status: "D", added: 0, removed: 3, truncated: false, diff: "" },
          ],
        }, false);
        break;
      case "file.read": {
        const path = String(p.path);
        const md = /register\.md$/i.test(path);
        send(ws, "file.content", md
          ? { sessionId: p.sessionId, requested: path, path: "C:\\Users\\ben\\Projects\\tenders\\register.md", kind: "text", size: 96, text: "# Register\n\n| Tender | Closes |\n|---|---|\n| Eagle Farm park | 14/10/2026 |\n" }
          : /\.env$/.test(path)
            ? { sessionId: p.sessionId, requested: path, path, kind: "error", size: 0, error: "That file holds credentials or keys, so it isn't shown." }
            : { sessionId: p.sessionId, requested: path, path: `C:\\Users\\ben\\Projects\\tenders\\${path}`, kind: "text", size: 120, text: "export function main() {\n  const total = 1 + 2;\n  return total; // a fairly long comment line that should scroll sideways rather than wrap in the code view\n}\n" }, false);
        break;
      }
      case "folders.list": {
        const tree = {
          "C:\\": ["Program Files", "Users", "Windows"],
          "C:\\Users": ["ben", "Public"],
          "C:\\Users\\ben": ["Desktop", "Documents", "OneDrive - Example Pty Ltd", "Projects"],
          "C:\\Users\\ben\\Projects": ["tenders", "invoices", "A very long project folder name that goes on and on to test wrapping"],
          "D:\\": ["Backups"],
        };
        const path = p.path ? String(p.path).replace(/[\\/]+$/, "") || p.path : null;
        const key = path && path.length === 2 ? `${path}\\` : path;
        if (!key) send(ws, "folders", { path: null, parent: null, folders: ["C:\\", "D:\\"], shortcuts: [{ name: "Home", path: "C:\\Users\\ben" }, { name: "Recent: tenders", path: "C:\\Users\\ben\\Projects\\tenders" }] }, false);
        else send(ws, "folders", { path: key, parent: key.length <= 3 ? null : key.slice(0, key.lastIndexOf("\\")) || null, folders: tree[key] ?? [], shortcuts: [], ...(tree[key] || /tenders|invoices|Desktop|Documents|Backups|Public/.test(key) ? {} : { error: "That folder doesn't exist." }) }, false);
        break;
      }
      case "commands.get":
        send(ws, "commands", { sessionId: p.sessionId, commands: MOCK_COMMANDS }, false);
        break;
      case "confirm.response":
        pendingConfirms.get(p.confirmId)?.(p.decision === "confirm");
        break;
      case "ask.response":
        pendingAsks.get(p.askId)?.(p.answers);
        break;
      case "session.settings": {
        const s = sessions.find((x) => x.id === p.sessionId);
        if (!s) break;
        if (p.permissionMode === "bypassPermissions" && !p.bypassAcknowledged) break;
        Object.assign(s, Object.fromEntries(Object.entries({ permissionMode: p.permissionMode, model: p.model, effort: p.effort, name: p.name }).filter(([, v]) => v)));
        list();
        break;
      }
      case "session.new":
        sessions.push({ id: `s_${randomBytes(3).toString("hex")}`, name: p.name || "New session", cwd: p.cwd || "C:\\Users\\ben", model: "claude-sonnet-5-5", effort: "medium", permissionMode: "default", surface: "desktop", busy: false, queued: 0 });
        list();
        break;
      case "history.get":
        send(ws, "history", { sessionId: p.sessionId, items: [{ role: "user", text: "Earlier: what's in the register?", ts: 1 }, { role: "assistant", text: "Three open tenders.", ts: 2 }] }, false);
        break;
      case "catalog.list":
        send(ws, "catalog", { items: [
          { claudeSessionId: "cat1", title: "Fix invoice importer", project: "invoices", cwd: "C:\\x", origin: "desktop", lastActiveAt: Date.now() - 3_600_000, activeRecently: false },
          { claudeSessionId: "cat2", title: "I want to build an app that allows full remote access to Claude from my car, with Android Auto, voice, approvals and a desktop helper that drives the CLI on the PC", project: "C--Users-ben-OneDrive---Example-Pty-Ltd-Documents-Projects-Very-Long-Folder-Name", cwd: "C:\\Users\\ben\\OneDrive - Example Pty Ltd\\Documents\\Projects\\Very Long Folder Name", origin: "desktop", lastActiveAt: Date.now() - 600_000, activeRecently: true },
          { claudeSessionId: "cat3", title: "Averyveryverylongsinglewordtitlewithoutanyspacesthatwouldnormallyoverflowthebox_and_more_text", project: "x", cwd: "C:\\x", origin: "terminal", lastActiveAt: Date.now() - 86_400_000, activeRecently: false },
        ] }, false);
        break;
      case "ping":
        send(ws, "pong", {}, false);
        break;
      default:
        break;
    }
  });
  ws.on("close", () => sockets.delete(ws));
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock helper on http://127.0.0.1:${PORT}/`));
