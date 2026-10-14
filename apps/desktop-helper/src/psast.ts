// Client for ps/classify.ps1: a long-lived powershell.exe that parses commands into an AST summary.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PS_CLASSIFIER } from "./paths.js";

export interface PsCommand {
  name: string | null;
  args: string[];
  dynamic: boolean;
  invocation: string;
}
export interface PsAnalysis {
  ok: boolean;
  errors: string[];
  commands: PsCommand[];
  members: string[];
  redirections: number;
}

let proc: ChildProcessWithoutNullStreams | null = null;
let buf = "";
const waiting: Array<(a: PsAnalysis) => void> = [];

function ensure() {
  if (proc && proc.exitCode === null) return proc;
  proc = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS_CLASSIFIER], {
    windowsHide: true,
  });
  buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const resolve = waiting.shift();
      if (!resolve) continue;
      try {
        const a = JSON.parse(line);
        resolve({
          ok: Boolean(a.ok),
          errors: [].concat(a.errors ?? []),
          commands: [].concat(a.commands ?? []).map((c: any) => ({ ...c, args: [].concat(c.args ?? []) })),
          members: [].concat(a.members ?? []),
          redirections: Number(a.redirections ?? 0),
        });
      } catch {
        resolve({ ok: false, errors: ["classifier output unreadable"], commands: [], members: [], redirections: 0 });
      }
    }
  });
  proc.on("exit", () => {
    warm = false;
    // Fail closed for anything still waiting.
    while (waiting.length) waiting.shift()!({ ok: false, errors: ["classifier exited"], commands: [], members: [], redirections: 0 });
    proc = null;
  });
  return proc;
}

let warm = false;

/** Start PowerShell early: cold start takes a few seconds. */
export async function warmClassifier() {
  await analysePowerShell("Get-Date");
}

export function analysePowerShell(script: string, timeoutMs?: number): Promise<PsAnalysis> {
  const p = ensure();
  const limit = timeoutMs ?? (warm ? 5000 : 20000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (a: PsAnalysis) => {
      if (!done) {
        done = true;
        if (a.ok) warm = true;
        resolve(a);
      }
    };
    waiting.push(finish);
    setTimeout(() => {
      if (done) return;
      finish({ ok: false, errors: ["classifier timeout"], commands: [], members: [], redirections: 0 });
      p.kill(); // keeps request/response pairing aligned; the exit handler fails the rest closed
    }, limit);
    p.stdin.write(Buffer.from(script, "utf8").toString("base64") + "\n");
  });
}

export function stopClassifier() {
  proc?.kill();
}
