// Roam Desk desktop helper — entry point.
import { audit } from "./audit.js";
import { ensureServe, tailscaleInfo } from "./tailscale.js";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { listDevices } from "./devices.js";
import { DATA_DIR } from "./paths.js";
import { stopClassifier, warmClassifier } from "./psast.js";
import { HelperServer } from "./server.js";
import { Sessions } from "./sessions.js";
import type { Surface } from "@claude-anywhere/protocol";
import { cleanUploads } from "./uploads.js";
import { DESKTOP_RULES, PLAIN_UPDATES_RULE, VOICE_RULES, projectFoldersRule } from "./voice.js";
import { syncRoots } from "./folders.js";

const config = loadConfig();
const ts = tailscaleInfo();
const bind = ["127.0.0.1"];
const hosts: string[] = [];
for (const b of config.bind) {
  if (b === "tailscale") {
    if (!config.plainTailnet) continue; // phones use the HTTPS link only
    if (ts.ip) {
      bind.push(ts.ip);
      hosts.push(ts.ip);
      if (ts.dnsName) hosts.push(ts.dnsName);
    } else console.warn("⚠ Tailscale address not found — the phone won't be able to reach this PC. Is Tailscale running?");
  } else if (b && b !== "127.0.0.1") {
    bind.push(b);
    hosts.push(b);
  }
}

// Server needs session deps (hook URL/token) and sessions need the server's token — build in order.
let server: HelperServer;
const deps = {
  claudePath: config.claudePath,
  // Read live so dashboard changes apply without a restart.
  get progressAfterS() {
    return config.progressAfterS;
  },
  get progressEveryS() {
    return config.progressEveryS ?? 20;
  },
  get plainUpdates() {
    return config.plainUpdates !== false;
  },
  get chromeTools() {
    return config.chromeTools !== false;
  },
  // The project-folder rule is added even to custom voice instructions, so saving into projects always works.
  instructions: (surface: Surface) => {
    const projects = projectFoldersRule(syncRoots());
    if (surface === "desktop") return `${DESKTOP_RULES}\n${projects}`;
    const base = `${config.instructions?.trim() || VOICE_RULES}\n${projects}`;
    return config.plainUpdates !== false ? `${base}\n${PLAIN_UPDATES_RULE}` : base;
  },
  get hookUrl() {
    return server.hookUrl;
  },
  get hookToken() {
    return server.hookToken;
  },
};
const sessions = new Sessions(config, deps);
server = new HelperServer(config, sessions, hosts);

try {
  await server.listen(bind);
  await server.listenPhone(config.phonePort);
} catch (e: any) {
  console.error(`Couldn't start on port ${config.port}/${config.phonePort}: ${e?.code ?? e?.message}. Is another copy of the helper running?`);
  process.exit(1);
}

// The HTTPS link: tailscale serve terminates TLS with a real certificate and adds the caller's Tailscale login.
const secure = ensureServe(ts, config.securePort, config.phonePort);
server.setSecure({
  host: secure.ok ? ts.dnsName : null,
  port: config.securePort,
  ownerLogin: ts.ownerLogin,
  error: secure.ok ? null : secure.error ?? "unknown",
});
audit({ event: "helper.start", bind, devices: listDevices().length, secure: secure.ok ? secure.url : secure.error });

// Browser attachments are kept a week.
cleanUploads();
setInterval(cleanUploads, 6 * 3_600_000).unref();

// If the link couldn't be set up (e.g. HTTPS certificates only just switched on), keep trying without a restart.
if (!secure.ok) {
  const retry = setInterval(() => {
    const info = tailscaleInfo();
    const r = ensureServe(info, config.securePort, config.phonePort);
    server.setSecure({ host: r.ok ? info.dnsName : null, port: config.securePort, ownerLogin: info.ownerLogin, error: r.ok ? null : r.error ?? "unknown" });
    if (r.ok) {
      clearInterval(retry);
      audit({ event: "secure.up", reason: r.url });
      console.log(`  Encrypted link is up: ${r.url}`);
    }
  }, 60_000);
  retry.unref();
}
void warmClassifier();

console.log(`
  Roam Desk helper is running
  ─────────────────────────────────
  Dashboard  http://127.0.0.1:${config.port}/
  Phones     ${secure.ok ? `${(secure.url ?? "").replace(/^https/, "wss")}/ws (encrypted, ${ts.ownerLogin ?? "owner unknown"} only)` : `HTTPS link off: ${secure.error}`}
  Plain      ${hosts.length ? hosts.map((h) => `ws://${h}:${config.port}/ws`).join("  ") : "(off)"}
  Sessions   ${config.sessions.map((s) => `${s.name} (${s.model})`).join(", ")}
  Paired     ${listDevices().length} phone(s)
  Config     ${CONFIG_FILE}
  Data       ${DATA_DIR}
`);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  audit({ event: "helper.stop", signal: sig });
  sessions.dispose();
  stopClassifier();
  server.close();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGBREAK", () => shutdown("SIGBREAK"));
// Last line of defence: one bad message or callback is logged instead of taking the helper (and the phone) down.
process.on("uncaughtException", (e) => {
  console.error("Uncaught error:", e);
  audit({ event: "helper.error", reason: String(e?.stack ?? e).slice(0, 2000) });
});
process.on("unhandledRejection", (e: any) => {
  console.error("Unhandled rejection:", e);
  audit({ event: "helper.error", reason: String(e?.stack ?? e).slice(0, 2000) });
});
