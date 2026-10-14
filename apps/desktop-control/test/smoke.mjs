// Live smoke test: starts the server over stdio and drives it like Claude would.
// Usage: node test/smoke.mjs <path to DesktopControl.exe> <scratch folder>
// It opens its own small test window (test/target.ps1), types into it, waits for the text, saves and closes it.
// It never types into any other app.
// Don't touch the mouse or keyboard while it runs (the server stops if you move the mouse).
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [exe, scratch] = process.argv.slice(2);
if (!exe || !scratch) throw new Error("usage: node test/smoke.mjs <exe> <scratch folder>");
mkdirSync(scratch, { recursive: true });

const proc = spawn(exe, [], { stdio: ["pipe", "pipe", "inherit"] });
let target;
let buf = "";
const waiting = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
let id = 0;
function rpc(method, params) {
  const n = ++id;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${method} timed out`)), 60_000);
    waiting.set(n, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  });
}
async function call(name, args = {}, save) {
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const img = r.content.find((c) => c.type === "image");
  if (img && save) writeFileSync(join(scratch, save), Buffer.from(img.data, "base64"));
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${ms} ms${r.isError ? ", ERROR" : ""}${img ? `, image ${Math.round(img.data.length * 0.75 / 1024)} KB` : ""})`);
  console.log(text.split("\n").slice(0, 14).join("\n"));
  return { r, text, ms };
}

const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) process.exitCode = 1; };

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name).sort();
  console.log("tools:", names.join(", "));
  check(["act", "focus_window", "screen", "wait_for", "windows", "zoom"].every((n) => names.includes(n)), "all six tools are listed");
  const actSchema = JSON.stringify(tools.tools.find((t) => t.name === "act").inputSchema);
  check(actSchema.includes("\"element\"") && actSchema.includes("\"keys\""), "act's step schema has element and keys");

  const s1 = await call("screen", {}, "1-screen.jpg");
  check(/Screen \d+: monitor \d of \d/.test(s1.text), "screen describes the monitor");
  check(s1.ms < 4000, `screen is quick (${s1.ms} ms)`);
  const s2 = await call("screen", { elements: false });
  check(/No change since your last look|changed \d+ time/.test(s2.text), "screen reports changes since the last look");

  // The test's own window (never the user's apps). No shared pipes; a detached PowerShell exits before showing a form,
  // and windowsHide would hide the form too (Windows applies it to the first window shown), so only the console is hidden.
  const file = join(scratch, "target-out.txt");
  writeFileSync(file, "");
  target = spawn("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "target.ps1"), "-Out", file], { stdio: "ignore" });
  // PowerShell and WinForms take a few seconds to start.
  for (let i = 0; i < 30; i++) {
    const r = await rpc("tools/call", { name: "windows", arguments: {} });
    if (r.content[0].text.includes("DesktopControl Test Target")) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const f = await call("focus_window", { title: "DesktopControl Test Target" }, "2-target.jpg");
  check(f.text.includes("DesktopControl Test Target") && !f.r.isError, "the test window is in front");
  check(!/MenuItem|key tip/i.test(f.text.split("\n").find((l) => l.startsWith("Keyboard focus")) ?? ""), "bringing it to the front didn't open a menu");

  const id = (role, name) => Number(new RegExp(`\\[(\\d+)\\] ${role} "${name}"`).exec(f.text)?.[1]);
  const box = id("Edit", "Test text"), save = id("Button", "Save");
  check(box > 0 && save > 0, `the text box and Save button are listed (ids ${box}, ${save})`);

  const phrase = "Claude smoke test 0912 #3 (A-Z) a+b=c";
  const a = await call("act", { steps: [{ action: "click", element: box }, { action: "type", text: phrase }, { action: "click", element: save }] }, "3-typed.jpg");
  check(/Did 3 of 3 steps/.test(a.text), "act ran all three steps");
  check(/settled \d+ ms/.test(a.text), "act waited for the screen to settle");

  const w = await call("wait_for", { until: "text", text: "smoke test 0912", timeout_ms: 8000 }, "4-found.jpg");
  check(/Found "smoke test 0912"/.test(w.text) && /at \d+,\d+/.test(w.text), "wait_for found the typed text and where it is");

  const z = await call("zoom", { x: 0, y: 0, width: 400, height: 200 }, "5-zoom.jpg");
  check(!z.r.isError && /Zoom of screen/.test(z.text), "zoom returns a close-up");

  const bad = await call("act", { steps: [{ action: "click", element: 9999 }] , screenshot: false });
  check(/no control 9999/.test(bad.text), "a bad element id is refused clearly");

  await new Promise((r) => setTimeout(r, 500));
  const saved = readFileSync(file, "utf8");
  check(saved === phrase, `the exact text reached the window and was saved (got "${saved}")`);

  const win = await call("windows");
  check(win.text.includes("DesktopControl Test Target"), "windows lists the test window");
} finally {
  // Only ever close the test's own window, by its process id.
  if (target?.pid) try { process.kill(target.pid); } catch {}
  proc.stdin.end();
  proc.kill();
}
