// "Check everything": one list of what's working and what isn't, each problem with a plain fix.
// evaluate() is pure so it can be tested; checkHealth() gathers the facts.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck, VersionInfo } from "@claude-anywhere/protocol";
import { AUDIT_DIR } from "./paths.js";
import { verifyChain } from "./audit.js";
import { ANNOUNCED, listConnectors, SIGN_IN_URL, type Connector } from "./connectors.js";
import { flaggedNames } from "./mcpcache.js";
import { versionInfo } from "./version.js";

export interface Facts {
  version: VersionInfo;
  cli: { version?: string; loggedIn?: boolean; email?: string; org?: string; error?: string };
  connectors: Connector[];
  connectorsError?: string;
  secure: { host: string | null; error: string | null };
  disabled: boolean;
  chromeTools: boolean;
  devices: number;
  auditBadLine: number; // -1 intact
  /** Microsoft 365 entries in Claude Code's "needs authentication" cache right now (it skips these connectors). */
  flagged?: string[];
}

export function evaluate(f: Facts): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], detail: string, fix?: string) => out.push({ name, status, detail, ...(fix ? { fix } : {}) });

  if (f.version.behind) add("Helper version", "warn", `Running ${f.version.commit ?? "an unknown version"}; ${f.version.behind} newer on GitHub.`, "Settings › Update the PC helper.");
  else add("Helper version", f.version.commit ? "ok" : "warn", f.version.commit ? `Running ${f.version.commit}${f.version.behind === 0 ? ", up to date" : ""}.` : "Couldn't read the version.", f.version.commit ? undefined : "Update the PC helper.");

  if (f.cli.error) add("Claude on the PC", "bad", f.cli.error, "Open a terminal on the PC and run: claude auth login");
  else if (!f.cli.loggedIn) add("Claude on the PC", "bad", "Claude isn't signed in on the PC, so phone sessions can't run.", "On the PC run: claude auth login");
  else add("Claude on the PC", "ok", `${f.cli.version ? `${f.cli.version}, ` : ""}signed in as ${f.cli.email ?? "unknown"}${f.cli.org ? ` (${f.cli.org})` : ""}.`);

  const m365 = f.connectors.find((c) => /microsoft 365$/i.test(c.name));
  if (f.connectors.length === 0) add("Microsoft 365", "warn", f.connectorsError || "Couldn't read the connector list.", "Check again in a minute.");
  else if (!m365) add("Microsoft 365", "warn", "Not set up as a connector.", `Add it at ${SIGN_IN_URL}`);
  else if (m365.status === "connected") add("Microsoft 365", "ok", "Connected.");
  else add("Microsoft 365", "bad", m365.status === "needs-auth" ? "Needs signing in." : `Not working (${m365.detail}).`, `Sign in at ${SIGN_IN_URL}; the helper will reconnect it if you say yes when asked.`);
  if (f.flagged?.length) {
    add("Microsoft 365 skipped by Claude", "warn", "Claude Code has an old sign-in failure on record and skips Microsoft 365 in new sessions, even where it shows as connected. Claude Desktop is unaffected.", "The helper clears this by itself within about 10 minutes, or the next time a session starts. If it comes back, sign in again at the connector page.");
  }

  const dc = f.connectors.find((c) => /desktop-control/i.test(c.name));
  if (!dc) add("Desktop control", "warn", "The plugin isn't installed, so Claude can't use the mouse and keyboard.", "Run apps/desktop-control/scripts/install.ps1 on the PC.");
  else add("Desktop control", dc.status === "connected" ? "ok" : "warn", dc.status === "connected" ? "Connected. It can't see or click a locked PC." : `Not connected (${dc.detail}).`, dc.status === "connected" ? undefined : "Restart the helper (Settings › Update the PC helper).");

  const others = f.connectors.filter((c) => c !== m365 && c !== dc);
  const waiting = others.filter((c) => c.status === "needs-auth").length;
  add("Other connectors", "ok", f.connectors.length ? `${others.filter((c) => c.status === "connected").length} connected, ${waiting} not signed in (that's normal for ones you don't use).` : "Not checked.");

  if (f.secure.host && !f.secure.error) add("Phone link (Tailscale)", "ok", `Reachable at https://${f.secure.host}.`);
  else add("Phone link (Tailscale)", "bad", f.secure.error || "The secure link isn't set up.", "Check Tailscale is running and signed in on the PC.");

  add("Remote access", f.disabled ? "warn" : "ok", f.disabled ? "Switched off on the PC, so the phone can't do anything." : `On. ${f.devices} paired device${f.devices === 1 ? "" : "s"}.`, f.disabled ? "Switch it on from the PC dashboard." : undefined);
  add("Browser tools", f.chromeTools ? "ok" : "warn", f.chromeTools ? "Switched on. Chrome has to be open with the Claude extension for them to work." : "Switched off, so Claude can't use Chrome.", f.chromeTools ? undefined : "Turn on browser tools in the PC dashboard.");
  add("Audit log", f.auditBadLine === -1 ? "ok" : "bad", f.auditBadLine === -1 ? "Intact." : "Today's audit log doesn't match its checksums; it may have been edited.", f.auditBadLine === -1 ? undefined : "Look at it on the PC dashboard.");
  return out;
}

function cliFacts(claudePath: string): Promise<Facts["cli"]> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile(claudePath, args, { env, windowsHide: true, timeout: 30_000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));
  return (async () => {
    try {
      const version = (await run(["--version"])).trim().split(/\s+/)[0];
      const st = JSON.parse(await run(["auth", "status"]));
      return { version, loggedIn: Boolean(st.loggedIn), email: st.email, org: st.orgName };
    } catch (e: any) {
      return { error: `Couldn't run Claude on the PC (${String(e?.message ?? e).split("\n")[0].slice(0, 100)}).` };
    }
  })();
}

function auditBadLine(): number {
  try {
    const files = readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).sort();
    const last = files[files.length - 1];
    return last ? verifyChain(join(AUDIT_DIR, last)) : -1;
  } catch {
    return -1;
  }
}

export async function checkHealth(args: { claudePath: string; secure: Facts["secure"]; disabled: boolean; chromeTools: boolean; devices: number }): Promise<DoctorCheck[]> {
  const [cli, conn] = await Promise.all([cliFacts(args.claudePath), listConnectors(args.claudePath)]);
  return evaluate({ version: versionInfo(), cli, connectors: conn.items, connectorsError: conn.error, secure: args.secure, disabled: args.disabled, chromeTools: args.chromeTools, devices: args.devices, auditBadLine: auditBadLine(), flagged: flaggedNames(ANNOUNCED) });
}
