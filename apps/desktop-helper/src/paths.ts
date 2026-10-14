import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/src/ (built).
export const APP_ROOT = resolve(here, /[\\/]dist[\\/]apps[\\/]desktop-helper[\\/]src$/.test(here) ? "../../../.." : "..");
/** The monorepo root: its shared packages and node_modules run inside the helper, so they're protected too. */
export const REPO_ROOT = resolve(APP_ROOT, "..", "..");

const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

export const CONFIG_DIR = process.env.CA_CONFIG_DIR ?? join(appData, "ClaudeAnywhere");
export const DATA_DIR = process.env.CA_DATA_DIR ?? join(localAppData, "ClaudeAnywhere");
export const AUDIT_DIR = join(DATA_DIR, "audit");
export const REPLAY_DIR = join(DATA_DIR, "replay");
export const DISABLED_FLAG = join(DATA_DIR, "DISABLED");
export const HOOK_SCRIPT = join(APP_ROOT, "hooks", "pretool.mjs");
export const PHONE_MCP = join(APP_ROOT, "mcp", "phone.mjs");
export const PS_CLASSIFIER = join(APP_ROOT, "ps", "classify.ps1");
/** The web client the helper serves to browsers (apps/web-client). */
export const WEB_ROOT = resolve(APP_ROOT, "..", "web-client");

for (const d of [CONFIG_DIR, DATA_DIR, AUDIT_DIR, REPLAY_DIR]) mkdirSync(d, { recursive: true });
