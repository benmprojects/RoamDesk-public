import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { PermissionMode, Surface } from "@claude-anywhere/protocol";
import { CONFIG_DIR } from "./paths.js";

export interface SessionConfig {
  id: string;
  name: string;
  cwd: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Claude Code session id to resume; set by the helper. */
  claudeSessionId?: string;
  /** Approvals for turns sent from a browser. Phone turns always use the voice rules. Default "default". */
  permissionMode?: PermissionMode;
  /** "voice" (default): replies written to be spoken. "desktop": written replies with formatting, for browsers. */
  surface?: Surface;
}

export interface Config {
  helperName: string;
  port: number;
  /** Extra bind addresses besides 127.0.0.1. "tailscale" = auto-detect the 100.x address. */
  bind: string[];
  sessions: SessionConfig[];
  activeSessionId: string;
  /** Seconds to wait for a spoken confirmation before denying. */
  confirmTimeoutS: number;
  /** Speak a "still working" update when a turn runs longer than this. */
  progressAfterS: number;
  /** After the first "still working", how often to repeat it while a request is still running. */
  progressEveryS: number;
  claudePath: string;
  /** Run tier-2 actions without spoken confirmation, and lift the hard-deny list. Credentials, keys and the
   *  helper's own files stay off limits. Only the dashboard can turn it on; the phone can only turn it off. */
  skipConfirmations: boolean;
  /** Instructions added to every phone session (edited in the dashboard). Empty = the built-in default. */
  instructions: string;
  /** Tell phone sessions to keep spoken updates plain: no file names, code or tool names. */
  plainUpdates: boolean;
  /** Give sessions the Claude in Chrome tools (the PC's Chrome, with its sign-ins). Risky steps still need approval. Default on. */
  chromeTools: boolean;
  /** HTTPS port phones use on this PC's .ts.net name (set up with `tailscale serve`). */
  securePort: number;
  /** Loopback-only port `tailscale serve` forwards to. Serves the phone routes only. */
  phonePort: number;
  /** Tailscale logins allowed through the HTTPS link. Empty = only the account this PC is signed in with. */
  allowedUsers: string[];
  /** Also accept phones on the plain ws:// Tailscale address (older app versions). Turn off once every phone uses HTTPS. */
  plainTailnet: boolean;
  /**
   * "Admin: allow everything" (admin.ts): 0 off, -1 until switched off, otherwise when it switches itself off
   * (epoch ms). Only the PC dashboard can turn it on.
   */
  adminAllowUntil: number;
}

const FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  helperName: hostname(),
  port: 8787,
  bind: ["tailscale"],
  sessions: [
    { id: "home", name: "Home", cwd: homedir(), model: "claude-sonnet-5-5", effort: "medium" },
  ],
  activeSessionId: "home",
  confirmTimeoutS: 45,
  progressAfterS: 8,
  progressEveryS: 20,
  claudePath: "claude",
  skipConfirmations: false,
  instructions: "",
  plainUpdates: true,
  chromeTools: true,
  securePort: 8443,
  phonePort: 8788,
  allowedUsers: [],
  plainTailnet: true,
  adminAllowUntil: 0,
};

export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function loadConfig(): Config {
  if (!existsSync(FILE)) {
    saveConfig(DEFAULTS);
    return structuredClone(DEFAULTS);
  }
  const raw = JSON.parse(readFileSync(FILE, "utf8"));
  return { ...DEFAULTS, ...raw };
}

export function saveConfig(c: Config) {
  writeFileSync(FILE, JSON.stringify(c, null, 2));
}

export const CONFIG_FILE = FILE;
