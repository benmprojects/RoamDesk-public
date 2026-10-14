// Tailscale integration: this PC's address and name, the tailnet owner's login, and the HTTPS front door
// (`tailscale serve`) that gives phones an encrypted wss:// link with a real certificate and tells the helper
// which Tailscale user is connecting.
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";

const run = (args: string[], timeout = 8000) => execFileSync("tailscale", args, { encoding: "utf8", timeout, windowsHide: true });

export interface TailscaleInfo {
  ip: string | null;
  /** MagicDNS name, e.g. my-pc.tail1234.ts.net (no trailing dot). */
  dnsName: string | null;
  /** Login of the account this PC is signed in with, e.g. user@github. */
  ownerLogin: string | null;
  /** HTTPS certificates are switched on for the tailnet (needed for `tailscale serve --https`). */
  certsEnabled: boolean;
}

function ipFromInterfaces(): string | null {
  // CGNAT range 100.64.0.0/10 on any interface.
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
}

export function tailscaleInfo(): TailscaleInfo {
  let ip: string | null = null;
  try {
    const first = run(["ip", "-4"], 4000).trim().split(/\s+/)[0];
    if (/^100\.\d+\.\d+\.\d+$/.test(first)) ip = first;
  } catch {
    /* fall back below */
  }
  ip ??= ipFromInterfaces();
  try {
    // User IDs are 64-bit and lose precision as JS numbers, so read them as strings before parsing.
    const st = JSON.parse(run(["status", "--json"]).replace(/"(UserID|ID)":\s*(\d+)/g, '"$1":"$2"'));
    const dnsName = String(st?.Self?.DNSName ?? "").replace(/\.$/, "") || null;
    const ownerLogin = st?.User?.[String(st?.Self?.UserID)]?.LoginName ?? null;
    const certDomains: string[] = Array.isArray(st?.CertDomains) ? st.CertDomains : [];
    return { ip, dnsName, ownerLogin, certsEnabled: Boolean(dnsName && certDomains.some((d) => d.replace(/\.$/, "") === dnsName)) };
  } catch {
    return { ip, dnsName: null, ownerLogin: null, certsEnabled: false };
  }
}

export interface ServeResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Makes https://<dnsName>:<httpsPort> on the tailnet forward to the helper's phone port on 127.0.0.1.
 * Idempotent: leaves an existing identical mapping alone. Persists in Tailscale until removed with
 * `tailscale serve --https=<port> off`.
 */
export function ensureServe(info: TailscaleInfo, httpsPort: number, localPort: number): ServeResult {
  if (!info.dnsName) return { ok: false, error: "Tailscale isn't running or has no machine name." };
  if (!info.certsEnabled) return { ok: false, error: "HTTPS certificates are off for your tailnet. Turn them on in the Tailscale admin console (DNS › HTTPS Certificates)." };
  const url = `https://${info.dnsName}:${httpsPort}`;
  const target = `http://127.0.0.1:${localPort}`;
  try {
    const current = run(["serve", "status", "--json"]);
    if (current.includes(`${info.dnsName}:${httpsPort}`) && current.includes(target)) return { ok: true, url };
  } catch {
    /* no serve config yet */
  }
  try {
    run(["serve", "--bg", `--https=${httpsPort}`, target], 20000);
    return { ok: true, url };
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e).trim().split(/\r?\n/)[0];
    return { ok: false, error: `tailscale serve failed: ${msg}` };
  }
}
