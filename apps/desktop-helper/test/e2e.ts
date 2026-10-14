// End-to-end test with a simulated phone against a real helper + real `claude` CLI (uses your subscription).
// Runs on port 8788 with throwaway config/data folders. Usage: npm run e2e
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8788;
const tmp = mkdtempSync(join(tmpdir(), "ca-e2e-"));
const configDir = join(tmp, "config");
const dataDir = join(tmp, "data");
const work = join(tmp, "work");
const { mkdirSync } = await import("node:fs");
mkdirSync(configDir, { recursive: true });
mkdirSync(work, { recursive: true });
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: PORT,
    bind: [],
    sessions: [{ id: "home", name: "Home", cwd: work, model: "claude-sonnet-5-5", effort: "low" }],
    activeSessionId: "home",
    confirmTimeoutS: 45,
    progressAfterS: 8,
  }),
);
const victim = join(work, "delete-me.txt");
writeFileSync(victim, "test");

const helper = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  env: { ...process.env, CA_CONFIG_DIR: configDir, CA_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let helperOut = "";
helper.stdout.on("data", (d) => (helperOut += d));
helper.stderr.on("data", (d) => (helperOut += d));

const base = `http://127.0.0.1:${PORT}`;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${base}/api/state`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("helper did not start:\n" + helperOut);
}

const results: Record<string, boolean | string> = {};
const check = (name: string, ok: boolean, info = "") => {
  results[name] = ok ? true : `FAIL ${info}`;
  console.log(`${ok ? "✔" : "✖"} ${name}${info ? ` — ${info}` : ""}`);
};

try {
  await waitUp();

  // Dashboard must refuse calls without the dashboard header.
  check("dashboard blocks header-less POST", (await fetch(`${base}/api/pair-code`, { method: "POST" })).status === 403);

  // 1. Pairing
  const pc = await (await fetch(`${base}/api/pair-code`, { method: "POST", headers: { "x-ca-dashboard": "1" } })).json();
  check("pair code issued with QR", typeof pc.qr?.code === "string" && pc.svg.includes("<svg"));
  const bad = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: "nope", deviceName: "x", platform: "android" }) });
  check("wrong pair code rejected", bad.status === 401);
  const pair = await (await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: pc.qr.code, deviceName: "E2E phone", platform: "android" }) })).json();
  check("paired", typeof pair.deviceSecret === "string");
  const reuse = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: pc.qr.code, deviceName: "x", platform: "android" }) });
  check("pair code is single-use", reuse.status === 401);

  // 2. Bad auth
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === "auth.challenge") ws.send(JSON.stringify({ v: 1, type: "auth.response", id: "1", ts: Date.now(), payload: { deviceId: pair.deviceId, mac: "wrong", lastSeq: 0 } }));
      if (f.type === "auth.fail") check("bad signature rejected", true);
    });
    ws.on("close", () => resolve());
  });

  // 3. Real session
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (type: string, payload: any) => ws.send(JSON.stringify({ v: 1, type, id: String(Math.random()), ts: Date.now(), payload }));
  let confirmAnswer: "cancel" | "confirm" = "cancel";
  const waitFor = (pred: (f: any) => boolean, ms = 180_000) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      const iv = setInterval(() => {
        const f = frames.find(pred);
        if (f) {
          clearTimeout(t);
          clearInterval(iv);
          frames.splice(frames.indexOf(f), 1);
          resolve(f);
        }
      }, 50);
    });
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "auth.challenge") {
      const mac = createHmac("sha256", Buffer.from(pair.deviceSecret, "base64url")).update(`${f.payload.nonce}|${pair.deviceId}`).digest("base64url");
      send("auth.response", { deviceId: pair.deviceId, mac, lastSeq: 0 });
      return;
    }
    if (f.type === "confirm.request") {
      console.log(`  🔊 "${f.payload.summary}. Say '${f.payload.phrase}' to go ahead, or 'cancel'."   → answering ${confirmAnswer}`);
      send("confirm.response", { confirmId: f.payload.confirmId, decision: confirmAnswer, heard: confirmAnswer === "confirm" ? f.payload.phrase : "cancel" });
    }
    if (f.type === "speak") console.log(`  🔊 [${f.payload.priority}] ${f.payload.text}`);
    if (f.type === "turn.progress") console.log(`  … ${f.payload.label}`);
    frames.push(f);
  });
  const ok = await waitFor((f) => f.type === "auth.ok" || f.type === "auth.fail", 10_000);
  check("authenticated", ok.type === "auth.ok");

  // Read-only question.
  let t0 = Date.now();
  send("utterance", { text: "How much free space is on my C drive?", source: "typed" });
  let done = await waitFor((f) => f.type === "turn.done" || f.type === "turn.failed");
  check("read-only turn completes", done.type === "turn.done", `${((Date.now() - t0) / 1000).toFixed(1)} s: ${done.payload.text ?? done.payload.error}`);

  // Tier 2 → cancel.
  confirmAnswer = "cancel";
  send("utterance", { text: `Delete the file delete-me.txt in ${work}`, source: "typed" });
  const req1 = await waitFor((f) => f.type === "confirm.request");
  check("delete asks for spoken confirmation", req1.payload.tier === 2 && /^confirm \w+$/.test(req1.payload.phrase), req1.payload.phrase);
  done = await waitFor((f) => f.type === "turn.done" || f.type === "turn.failed");
  check("cancelled delete did not run", existsSync(victim), done.payload.text ?? done.payload.error);

  // Tier 2 → confirm.
  confirmAnswer = "confirm";
  t0 = Date.now();
  send("utterance", { text: "Okay, go ahead and delete it now.", source: "typed" });
  await waitFor((f) => f.type === "confirm.request");
  done = await waitFor((f) => f.type === "turn.done" || f.type === "turn.failed");
  check("confirmed delete ran", !existsSync(victim), done.payload.text ?? done.payload.error);

  // Kill switch while busy.
  send("utterance", { text: "Count slowly from 1 to 200 using PowerShell with Start-Sleep 1 between numbers.", source: "typed" });
  await waitFor((f) => f.type === "turn.started");
  await new Promise((r) => setTimeout(r, 4000));
  t0 = Date.now();
  send("kill", {});
  const killed = await waitFor((f) => f.type === "turn.failed", 10_000);
  check("kill stops a running turn within 2 s", Date.now() - t0 < 2000, `${Date.now() - t0} ms (${killed.payload.error})`);

  // Session still usable after kill (resume).
  send("utterance", { text: "What file did I ask you to delete earlier? Answer without tools.", source: "typed" });
  done = await waitFor((f) => f.type === "turn.done" || f.type === "turn.failed");
  check("session resumes after kill", done.type === "turn.done" && /delete-me/i.test(done.payload.text), done.payload.text ?? done.payload.error);

  // Hand-off: forget the session, then continue the same Claude Code session by id (as the phone does from the catalogue).
  const before = JSON.parse((await import("node:fs")).readFileSync(join(configDir, "config.json"), "utf8"));
  const oldClaudeId: string = before.sessions[0].claudeSessionId;
  send("session.reset", {});
  await waitFor((f) => f.type === "session.list");
  send("catalog.list", {});
  const cat = await waitFor((f) => f.type === "catalog", 15_000);
  check("catalogue lists PC sessions", Array.isArray(cat.payload.items) && cat.payload.items.length > 0, `${cat.payload.items.length} sessions`);
  send("session.attach", { claudeSessionId: oldClaudeId });
  const attachedList = await waitFor((f) => f.type === "session.list" && f.payload.sessions.some((s: any) => s.claudeSessionId === oldClaudeId));
  const attached = attachedList.payload.sessions.find((s: any) => s.claudeSessionId === oldClaudeId);
  check("attach creates an active session for that conversation", attachedList.payload.activeSessionId === attached.id && attached.cwd === work);
  send("utterance", { text: "Without using tools: what was the very first thing I asked you in this conversation?", source: "typed" });
  done = await waitFor((f) => f.type === "turn.done" || f.type === "turn.failed");
  check("continued session remembers its history", done.type === "turn.done" && /disk|space|drive/i.test(done.payload.text), done.payload.text ?? done.payload.error);
  const after = JSON.parse((await import("node:fs")).readFileSync(join(configDir, "config.json"), "utf8"));
  check("hand-off keeps the same Claude session id", after.sessions.find((s: any) => s.id === attached.id)?.claudeSessionId === oldClaudeId);
  send("session.attach", { claudeSessionId: "00000000-0000-0000-0000-000000000000" });
  const err = await waitFor((f) => f.type === "error" && f.payload.code === "attach_failed", 10_000);
  check("attaching an unknown session fails cleanly", Boolean(err));

  // Replay on reconnect.
  ws.close();
  const lastSeq = 3;
  const replayed: any[] = [];
  await new Promise<void>((resolve) => {
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws2.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === "auth.challenge") {
        const mac = createHmac("sha256", Buffer.from(pair.deviceSecret, "base64url")).update(`${f.payload.nonce}|${pair.deviceId}`).digest("base64url");
        ws2.send(JSON.stringify({ v: 1, type: "auth.response", id: "r", ts: Date.now(), payload: { deviceId: pair.deviceId, mac, lastSeq } }));
      } else if (f.payload?.replay) replayed.push(f);
      if (f.type === "status") setTimeout(() => (ws2.close(), resolve()), 300);
    });
  });
  check("replay sends missed frames with replay flag", replayed.length > 0 && replayed.every((f) => f.seq > lastSeq), `${replayed.length} frames`);

  const state = await (await fetch(`${base}/api/state`)).json();
  const toolEvents = state.audit.filter((a: any) => a.event === "tool");
  check("audit recorded tool decisions", toolEvents.some((a: any) => a.approver === "voice") && toolEvents.some((a: any) => a.decision === "deny"));
} catch (e: any) {
  check("e2e run", false, e.message);
  console.log(helperOut.slice(-3000));
} finally {
  helper.kill();
  const failed = Object.values(results).filter((v) => v !== true).length;
  console.log(`\n${Object.keys(results).length - failed}/${Object.keys(results).length} checks passed. Data: ${tmp}`);
  process.exit(failed ? 1 : 0);
}
