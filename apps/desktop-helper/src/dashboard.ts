// Local dashboard served at http://127.0.0.1:8787/ — pairing, devices, sessions, activity, kill switch.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roam Desk</title>
<style>
:root{
  --bg:#f6f5f2;--panel:#ffffff;--ink:#1d1c1a;--muted:#6b6862;--line:#e6e3dd;
  --accent:#d9774b;--accent-ink:#ffffff;--ok:#2f8f5b;--warn:#b7791f;--bad:#c2412d;--chip:#f0eee9;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#141413;--panel:#1d1c1a;--ink:#f1efe9;--muted:#a19d95;--line:#2e2c29;
  --accent:#e08a5f;--accent-ink:#1a120d;--ok:#5cc28a;--warn:#e0b24f;--bad:#ef6f5a;--chip:#272522;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:center;gap:14px;margin-bottom:24px}
.mark{width:36px;height:36px;border-radius:10px;background:radial-gradient(circle at 50% 40%,#1d232c,#0b0e12);display:grid;place-items:center}
.mark svg{width:20px;height:20px}
h1{font-size:20px;margin:0;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px}
.spacer{flex:1}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;background:var(--chip);font-size:13px;font-weight:500}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:600}
.c4{grid-column:span 4}.c5{grid-column:span 5}.c7{grid-column:span 7}.c12{grid-column:span 12}
@media (max-width:860px){.c4,.c5,.c7{grid-column:span 12}}
.big{font-size:22px;font-weight:600;letter-spacing:-.01em}
.muted{color:var(--muted)}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:10px;padding:8px 14px;cursor:pointer;font-weight:500}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
button.danger{background:var(--bad);color:#fff;border-color:transparent}
button.link{border:none;background:none;color:var(--bad);padding:4px 6px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:none}
.qr{display:none;margin-top:14px;gap:18px;align-items:center}
.qr.show{display:flex}
.qr .code{width:200px;height:200px;background:#fff;border-radius:12px;padding:8px}
.qr .code svg{width:100%;height:100%}
.pairtext{display:none;margin-top:12px}
.pairtext.show{display:block}
.pairtext textarea{width:100%;box-sizing:border-box;height:84px;resize:vertical;font:12px ui-monospace,Consolas,monospace;padding:8px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.mono{font-family:var(--mono);font-size:12px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{display:inline-block;padding:1px 8px;border-radius:6px;font-size:12px;font-weight:600;background:var(--chip)}
.tag.allow{color:var(--ok)}.tag.deny{color:var(--bad)}.tag.t2{color:var(--warn)}
.switch{position:relative;width:44px;height:26px;border-radius:999px;background:var(--line);border:none;padding:0}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}
.switch.on{background:var(--ok)}.switch.on::after{left:21px}
.footer{margin-top:22px;color:var(--muted);font-size:12px}
button.collapse{display:flex;align-items:center;gap:8px;border:none;background:none;padding:2px 0;cursor:pointer}
button.collapse .chev{display:inline-block;transition:transform .15s;color:var(--muted)}
button.collapse[aria-expanded="false"] .chev{transform:rotate(-90deg)}
#connBody[hidden],#setBody[hidden]{display:none}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--ink)}
label.block{display:block}
select,input[type=number],textarea{font:inherit;font-weight:400;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
textarea{width:100%;margin-top:6px;font-family:var(--mono);font-size:13px;line-height:1.45;resize:vertical}
.admin-banner{background:#b3261e;color:#fff;border-radius:12px;padding:10px 14px;margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.admin-banner[hidden]{display:none}
.admin-banner button{background:#fff;color:#b3261e;border-color:#fff}
.admin-row{display:grid;gap:8px;margin:0 0 14px;padding:12px;border:1px solid var(--line);border-radius:12px}
.admin-row.on{border-color:#b3261e}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#f0936a" stroke-width="2.2" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg></div>
    <div><h1>Roam Desk</h1><div class="sub" id="helperName">Desktop helper</div><div class="sub" id="versionText"></div></div>
    <div class="spacer"></div>
    <button id="updateHelperBtn" title="Get the latest version, rebuild the helper and restart it">Update helper</button>
    <span class="pill"><span class="dot" id="connDot"></span><span id="connText">No phone connected</span></span>
  </header>

  <div class="admin-banner" id="adminBanner" hidden><b>Admin: allow everything is ON</b> <span id="adminBannerText"></span> <button class="danger" id="adminOffBtn">Turn it off</button></div>

  <div class="grid">
    <section class="card c4">
      <h2>Activity</h2>
      <div class="big" id="activity">Idle</div>
      <div class="muted" id="activitySub">Waiting for a request</div>
    </section>
    <section class="card c4">
      <h2>Remote access</h2>
      <div class="row"><button class="switch" id="remoteSwitch" aria-label="Remote access"></button><span class="big" id="remoteText">On</span></div>
      <div class="muted">Turning it off stops everything and refuses new requests.</div>
      <div class="muted" id="secureText" style="margin-top:8px"></div>
    </section>
    <section class="card c4">
      <h2>Kill switch</h2>
      <button class="danger" id="killBtn">Stop everything</button>
      <div class="muted" style="margin-top:8px">Cancels running work and pending approvals.</div>
    </section>

    <section class="card c7">
      <h2>Paired devices</h2>
      <ul class="list" id="devices"></ul>
      <div class="row" style="margin-top:12px"><button class="primary" id="pairBtn">Pair a device</button><span class="muted" id="pairHint"></span></div>
      <div class="muted" id="webClient" style="margin-top:8px"></div>
      <div class="qr" id="qr"><div class="code" id="qrCode"></div><div><div class="big">Scan with Roam Desk</div><div class="muted">Open the app on your phone and choose <b>Pair with PC</b>. This code works once and expires in <b id="qrTtl">5:00</b>.</div></div></div>
      <div class="pairtext" id="pairText">
        <div class="row"><span class="muted">For a browser, or if the phone can't scan: paste this into the web client's pairing box (or the app's <b>Paste pairing text instead</b>). Treat it like a password until it expires.</span><button id="copyPairBtn">Copy text</button></div>
        <textarea id="pairTextBox" readonly spellcheck="false" aria-label="Pairing text"></textarea>
      </div>
    </section>
    <section class="card c5">
      <h2>Sessions</h2>
      <ul class="list" id="sessions"></ul>
    </section>

    <section class="card c12">
      <div class="row" style="justify-content:space-between">
        <button class="collapse" id="setToggle" aria-expanded="true" aria-controls="setBody"><span class="chev">▾</span><h2 style="margin:0">Settings</h2></button>
        <span class="muted" id="setSummary" style="font-size:13px;flex:1"></span>
      </div>
      <div id="setBody">
        <div class="row" style="margin:14px 0"><button class="switch" id="skipSwitch" aria-label="Skip confirmations"></button><div><b>Skip confirmations</b><div class="muted" style="font-size:13px" id="skipText"></div></div></div>
        <div class="admin-row">
          <div><b>Admin: allow everything</b> <span class="tag" id="adminState">Off</span>
            <div class="muted" style="font-size:13px">For you only. Allows every step with no questions and no blocks, including credentials, keys and the helper's own files. Everything is still written to the audit log. Turns itself off when the time ends.</div>
          </div>
          <div class="row" style="flex-wrap:wrap">
            <button data-admin="1h">On for 1 hour</button>
            <button data-admin="8h">On for 8 hours</button>
            <button data-admin="until-off">On until I turn it off</button>
            <button data-admin="off">Off</button>
          </div>
        </div>
        <div class="row" style="margin:0 0 14px"><button class="switch" id="chromeSwitch" aria-label="Browser tools"></button><div><b>Browser tools (Chrome)</b><div class="muted" style="font-size:13px" id="chromeText"></div></div></div>
        <div class="row" style="margin:0 0 14px"><button class="switch" id="plainSwitch" aria-label="Plain updates"></button><div><b>Plain updates</b><div class="muted" style="font-size:13px" id="plainText"></div></div></div>
        <div class="form">
          <label>Model<select id="setModel"></select></label>
          <label>Effort<select id="setEffort"></select></label>
          <label>Approval timeout (seconds)<input type="number" id="setConfirm" min="10" max="300"></label>
          <label>Say "still working" after (seconds)<input type="number" id="setProgress" min="3" max="120"></label>
          <label>Repeat "still working" every (seconds)<input type="number" id="setEvery" min="5" max="300"></label>
        </div>
        <label class="block">Phone instructions <span class="muted" id="setInstrState" style="font-weight:400"></span>
          <textarea id="setInstructions" rows="16" spellcheck="true"></textarea>
        </label>
        <div class="muted" style="font-size:13px;margin:4px 0 12px">Added to every phone conversation: how Claude speaks while you drive, and what it may do. Changes apply from the next request.</div>
        <div class="row"><button class="primary" id="setSave">Save settings</button><button id="setReset">Reset instructions to default</button><span class="muted" id="setStatus"></span></div>
      </div>
    </section>

    <section class="card c12">
      <div class="row" style="justify-content:space-between">
        <button class="collapse" id="connToggle" aria-expanded="true" aria-controls="connBody"><span class="chev">▾</span><h2 style="margin:0">Tools &amp; connectors</h2></button>
        <span class="muted" id="connSummary" style="font-size:13px;flex:1"></span>
        <button id="connRefresh">Refresh</button>
      </div>
      <div id="connBody">
      <div class="muted" style="margin:8px 0 12px">Phone sessions get every Claude Code tool (files, PowerShell, web, sub-agents) plus every connector below that is connected. To connect one that needs sign-in, open claude.ai → Settings → Connectors (for plugins, run <b>/mcp</b> in Claude Code), then press Refresh.</div>
      <ul class="list" id="connectors"><li class="muted">Checking connectors…</li></ul>
      </div>
    </section>

    <section class="card c12">
      <h2>Recent activity</h2>
      <table><thead><tr><th>Time</th><th>Event</th><th>Decision</th><th>Detail</th></tr></thead><tbody id="audit"></tbody></table>
    </section>
  </div>
  <div class="footer" id="footer"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ca-dashboard": "1" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const fmtTime = (iso) => { const d = new Date(iso); return d.toLocaleDateString("en-AU",{day:"2-digit",month:"2-digit"}) + " " + d.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",second:"2-digit"}); };
let qrTimer = null;

function detail(a) {
  if (a.tool === "PowerShell") return a.input?.command;
  if (a.tool) return a.tool + " " + (a.input?.file_path ?? a.input?.pattern ?? a.input?.url ?? "");
  return a.text ?? a.reply ?? a.error ?? a.reason ?? a.deviceName ?? "";
}
function decisionTag(a) {
  if (!a.decision) return "";
  const cls = a.decision === "allow" ? (a.tier === 2 ? "t2" : "allow") : a.decision === "deny" ? "deny" : "";
  const label = a.decision === "allow" ? (a.tier === 2 ? "approved by voice" : a.tier === 1 ? "allowed · announced" : "allowed") : a.decision;
  return '<span class="tag ' + cls + '">' + esc(label) + "</span>";
}

// The commit the helper runs, and whether GitHub has newer ones (Update helper is highlighted then).
function renderVersion(v) {
  if (!v) return;
  const when = v.date ? new Date(v.date).toLocaleDateString("en-AU") : "";
  const base = v.commit ? "Version " + v.commit + (when ? " · " + when : "") : "Version unknown";
  const upd = v.behind ? " · Update available (" + v.behind + " new)" : v.behind === 0 ? " · Up to date" : v.error ? " · " + v.error : v.commit ? " · Checking for updates…" : "";
  $("versionText").textContent = base + upd;
  $("updateHelperBtn").classList.toggle("primary", Boolean(v.behind));
}

async function refresh() {
  let s;
  try { s = await fetch("/api/state").then((r) => r.json()); } catch { $("connText").textContent = "Helper not responding"; $("connDot").className = "dot bad"; return; }
  $("helperName").textContent = s.helperName + " · " + (s.hosts.length ? s.hosts.join(", ") : "localhost only") + ":" + s.port;
  const connected = s.devices.filter((d) => d.connected);
  $("connDot").className = "dot " + (s.disabled ? "bad" : connected.length ? "ok" : "warn");
  $("connText").textContent = s.disabled ? "Remote access off" : connected.length ? connected.map((d) => d.name).join(", ") + " connected" : "No phone connected";
  renderVersion(s.version);
  $("activity").textContent = s.busy ? "Working" : "Idle";
  $("activitySub").textContent = s.busy ? (s.queued ? s.queued + " more queued" : "Running a request") : "Waiting for a request";
  const adminUntil = s.adminAllowUntil;
  const adminOn = adminUntil !== null && adminUntil !== undefined;
  $("adminBanner").hidden = !adminOn;
  const adminWhen = !adminOn ? "" : adminUntil === -1 ? "until you turn it off." : "until " + new Date(adminUntil).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }) + ".";
  $("adminBannerText").textContent = adminOn ? "Every step runs with no questions or blocks, " + adminWhen : "";
  $("adminState").textContent = adminOn ? "On " + adminWhen.replace(/\\.$/, "") : "Off";
  $("adminState").className = "tag" + (adminOn ? " deny" : "");
  document.querySelector(".admin-row").classList.toggle("on", adminOn);
  $("remoteSwitch").className = "switch" + (s.disabled ? "" : " on");
  $("remoteText").textContent = s.disabled ? "Off" : "On";
  const sec = s.secure || {};
  $("secureText").textContent = sec.host
    ? "Encrypted link: https://" + sec.host + ":" + sec.port + " · only " + (sec.allowedUsers || []).join(", ") + (sec.plainTailnet ? " · older phones can still use the plain link" : "")
    : "Encrypted link off: " + (sec.error || "unknown");
  $("webClient").textContent = sec.host ? "Web client (any browser on your tailnet): https://" + sec.host + ":" + sec.port + "/" : "The web client needs the encrypted link.";
  const KIND = { android: "Phone", ios: "iPhone", browser: "Browser" };
  $("devices").innerHTML = s.devices.length ? s.devices.map((d) =>
    '<li><span class="dot ' + (d.connected ? "ok" : "") + '"></span><div style="flex:1"><div>' + esc(d.name) + ' <span class="tag">' + esc(KIND[d.platform] || "Other") + '</span></div><div class="muted" style="font-size:13px">Paired ' + esc(fmtTime(d.createdAt)) + (d.lastSeen ? " · last seen " + esc(fmtTime(d.lastSeen)) : "") + '</div></div><button class="link" data-revoke="' + esc(d.deviceId) + '">Unpair</button></li>').join("")
    : '<li class="muted">Nothing paired yet.</li>';
  $("sessions").innerHTML = s.sessions.map((x) =>
    '<li><span class="dot ' + (x.busy ? "warn" : "") + '"></span><div style="flex:1"><div>' + esc(x.name) + (x.id === s.activeSessionId ? ' <span class="tag">active</span>' : "") + '</div><div class="muted" style="font-size:13px">' + esc(x.cwd) + " · " + esc(x.model) + "</div></div>" +
    (x.claudeSessionId ? '<button data-resume="' + esc(x.claudeSessionId) + '" data-cwd="' + esc(x.cwd) + '" title="Copy a terminal command that continues this conversation on the PC">Continue on PC</button>' : "") +
    "</li>").join("");
  $("audit").innerHTML = s.audit.map((a) =>
    "<tr><td>" + esc(fmtTime(a.ts)) + "</td><td>" + esc(a.event + (a.tool ? " · " + a.tool : "")) + "</td><td>" + decisionTag(a) + '</td><td class="mono" title="' + esc(detail(a)) + '">' + esc(detail(a)) + "</td></tr>").join("");
  $("footer").textContent = "Audit log: %LOCALAPPDATA%\\\\ClaudeAnywhere\\\\audit · Config: %APPDATA%\\\\ClaudeAnywhere";
}

const CONN_LABEL = { connected: ["ok", "Connected"], "needs-auth": ["warn", "Needs sign-in"], failed: ["bad", "Failed"], "not-configured": ["", "Not set up"], unknown: ["", "Unknown"] };
async function loadConnectors(refresh) {
  if (refresh) $("connectors").innerHTML = '<li class="muted">Checking connectors… (up to a minute)</li>';
  let c;
  try { c = await fetch("/api/connectors" + (refresh ? "?refresh=1" : "")).then((r) => r.json()); } catch { return; }
  const skip = !!c.skipConfirmations;
  const all = c.items || [];
  const nConn = all.filter((x) => x.status === "connected").length;
  const nAuth = all.filter((x) => x.status === "needs-auth").length;
  $("connSummary").textContent = all.length ? nConn + " connected" + (nAuth ? " · " + nAuth + " need sign-in" : "") + (skip ? " · confirmations off" : "") : "";
  const items = all.slice().sort((a, b) => (a.status === "connected" ? 0 : 1) - (b.status === "connected" ? 0 : 1) || a.name.localeCompare(b.name));
  $("connectors").innerHTML = items.length ? items.map((x) => {
    const [cls, label] = CONN_LABEL[x.status] || CONN_LABEL.unknown;
    return '<li><span class="dot ' + cls + '"></span><div style="flex:1">' + esc(x.name) + '</div>' + (x.status === "needs-auth" ? '<a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener noreferrer">Sign in</a> ' : "") + '<span class="tag">' + esc(label) + "</span></li>";
  }).join("") : '<li class="muted">' + esc(c.error || "No connectors found.") + "</li>";
}
loadConnectors(false);

// Collapsible cards: start collapsed (the header shows a summary) and remember the choice in this browser.
const COLLAPSIBLE = { connToggle: ["connBody", "ca.connOpen"], setToggle: ["setBody", "ca.setOpen"] };
function setOpen(toggleId, open) {
  const [bodyId, key] = COLLAPSIBLE[toggleId];
  $(bodyId).hidden = !open;
  $(toggleId).setAttribute("aria-expanded", String(open));
  try { localStorage.setItem(key, open ? "1" : "0"); } catch {}
}
for (const id of Object.keys(COLLAPSIBLE)) {
  let open = false;
  try { open = localStorage.getItem(COLLAPSIBLE[id][1]) === "1"; } catch {}
  setOpen(id, open);
}

// Settings card.
let settings = null;
function fillOptions(sel, values, current) {
  sel.innerHTML = values.map((v) => '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>").join("");
}
function renderSettings(s) {
  settings = s;
  const skip = !!s.skipConfirmations;
  $("skipSwitch").className = "switch" + (skip ? " on" : "");
  $("skipText").textContent = skip ? "On: everything runs without asking, including normally blocked actions." : "Off: risky actions wait for a spoken \\"confirm …\\".";
  $("chromeSwitch").className = "switch" + (s.chromeTools ? " on" : "");
  $("chromeText").textContent = s.chromeTools ? "On: sessions can use this PC's Chrome (signed in as you). Looking is free; clicking, typing and scripts ask first." : "Off: sessions can't use Chrome.";
  $("plainSwitch").className = "switch" + (s.plainUpdates ? " on" : "");
  $("plainText").textContent = s.plainUpdates ? "On: spoken updates use everyday words, with no file names or code, and the PC doesn't read out each step." : "Off: Claude may mention file names, commands and tools.";
  fillOptions($("setModel"), s.models, s.model);
  fillOptions($("setEffort"), s.efforts, s.effort);
  $("setConfirm").value = s.confirmTimeoutS;
  $("setProgress").value = s.progressAfterS;
  $("setEvery").value = s.progressEveryS;
  $("setInstructions").value = s.instructions;
  $("setInstrState").textContent = s.instructionsCustomised ? "(customised)" : "(default)";
  $("setSummary").textContent = s.model + " · " + s.effort + " effort · " + (skip ? "confirmations off" : "confirmations on") + (s.plainUpdates ? " · plain updates" : "") + (s.instructionsCustomised ? " · custom instructions" : "");
}
async function loadSettings() {
  try { renderSettings(await fetch("/api/settings").then((r) => r.json())); } catch {}
}
async function saveSettings(extra) {
  const r = await post("/api/settings", Object.assign({
    model: $("setModel").value,
    effort: $("setEffort").value,
    confirmTimeoutS: Number($("setConfirm").value),
    progressAfterS: Number($("setProgress").value),
    progressEveryS: Number($("setEvery").value),
    instructions: $("setInstructions").value,
  }, extra || {}));
  renderSettings(r);
  $("setStatus").textContent = r.changed && r.changed.length ? "Saved: " + r.changed.join(", ") + "." : "No changes.";
  setTimeout(() => ($("setStatus").textContent = ""), 6000);
  loadConnectors(false);
}
loadSettings();

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "pairBtn") {
    const r = await post("/api/pair-code");
    $("qrCode").innerHTML = r.svg;
    $("qr").classList.add("show");
    $("pairTextBox").value = r.text;
    $("pairText").classList.add("show");
    $("copyPairBtn").textContent = "Copy text";
    clearInterval(qrTimer);
    qrTimer = setInterval(() => {
      const left = r.qr.exp - Math.floor(Date.now() / 1000);
      if (left <= 0) {
        clearInterval(qrTimer);
        $("qr").classList.remove("show");
        $("pairText").classList.remove("show");
        $("pairTextBox").value = "";
        $("pairHint").textContent = "Code expired. Generate a new one.";
        return;
      }
      $("qrTtl").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
    }, 500);
    $("pairHint").textContent = "";
  }
  if (t.id === "copyPairBtn") {
    const box = $("pairTextBox");
    try { await navigator.clipboard.writeText(box.value); } catch { box.select(); document.execCommand("copy"); }
    t.textContent = "Copied";
    setTimeout(() => (t.textContent = "Copy text"), 2000);
  }
  if (t.dataset.revoke && confirm("Unpair this device? It will need new pairing to connect again.")) { await post("/api/revoke", { deviceId: t.dataset.revoke }); refresh(); }
  if (t.dataset.resume) {
    // Single quotes: PowerShell doesn't expand $(...) inside them, so a folder name can't run code when pasted.
    const cmd = "cd '" + t.dataset.cwd.replace(/'/g, "''") + "'; claude --resume " + t.dataset.resume;
    try { await navigator.clipboard.writeText(cmd); t.textContent = "Copied"; } catch { prompt("Run this in a terminal:", cmd); }
    setTimeout(() => (t.textContent = "Continue on PC"), 2000);
  }
  if (t.id === "updateHelperBtn" && confirm("Rebuild and restart the helper? Phones reconnect by themselves in about a minute.")) {
    const r = await post("/api/update-helper");
    t.textContent = r.ok ? "Updating…" : "Update helper";
    if (!r.ok) alert(r.message);
  }
  if (COLLAPSIBLE[t.id]) setOpen(t.id, $(COLLAPSIBLE[t.id][0]).hidden);
  if (t.id === "connRefresh") loadConnectors(true);
  if (t.id === "skipSwitch") {
    const on = t.classList.contains("on");
    if (on || confirm("Let phone requests run anything on this PC without asking, including deleting files and sending messages?")) {
      renderSettings(await post("/api/settings", { skipConfirmations: !on }));
      loadConnectors(false);
    }
  }
  if (t.dataset.admin || t.id === "adminOffBtn") {
    const choice = t.id === "adminOffBtn" ? "off" : t.dataset.admin;
    if (choice === "off" || confirm("Turn on Admin: allow everything?\\n\\nEvery step Claude takes will run with no questions and no blocks, including reading or sending credentials and keys and changing the helper itself.\\n\\nAnything Claude reads (emails, web pages, files) could steer it into deleting files or sending passwords out, with nothing to stop it. Everything is still written to the audit log.")) {
      renderSettings(await post("/api/settings", { adminAllowAll: choice }));
      refresh();
    }
  }
  if (t.id === "chromeSwitch") renderSettings(await post("/api/settings", { chromeTools: !t.classList.contains("on") }));
  if (t.id === "plainSwitch") renderSettings(await post("/api/settings", { plainUpdates: !t.classList.contains("on") }));
  if (t.id === "setSave") await saveSettings();
  if (t.id === "setReset" && settings && confirm("Replace the phone instructions with the built-in default?")) {
    $("setInstructions").value = settings.defaultInstructions;
    await saveSettings();
  }
  if (t.id === "killBtn") { await post("/api/kill"); refresh(); }
  if (t.id === "remoteSwitch") { const on = t.classList.contains("on"); await post("/api/disabled", { disabled: on }); refresh(); }
});
refresh();
setInterval(refresh, 2000);
// Opening the dashboard checks GitHub for a newer version (the helper limits this to every few minutes).
fetch("/api/version?check=1").then((r) => r.json()).then(renderVersion).catch(() => {});
</script>
</body>
</html>`;
