// Tool-call policy: decides Tier 0 (auto), Tier 1 (announce + run), Tier 2 (spoken confirmation) or deny.
// Enforced in code via the PreToolUse hook — content Claude reads can never change these rules.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { analysePowerShell, type PsAnalysis } from "./psast.js";
import { join } from "node:path";
import { syncRoots } from "./folders.js";
import { APP_ROOT, CONFIG_DIR, DATA_DIR, REPO_ROOT, WEB_ROOT } from "./paths.js";
import { isPlanFile } from "./stream.js";

export type Tier = 0 | 1 | 2 | "deny";
export interface Decision {
  tier: Tier;
  reason: string;
  /** Short spoken description, e.g. "delete 4 log files in Downloads". */
  summary: string;
  /** Verb for the confirmation phrase: "confirm <verb>". */
  verb: string;
  /** Short progress label for the screen, e.g. "Checking disk space". */
  label: string;
  /** A deny that "skip confirmations" can't lift: credentials, keys and the helper's own files. */
  locked?: boolean;
}
export interface PolicyContext {
  sessionCwd: string;
  /** What sent the request being worked on. Phone (the default) is the stricter. */
  origin?: "phone" | "browser";
}

const HOME = homedir();

// ---------- path rules ----------
// WEB_ROOT: the web client is served to browsers that hold a device key, so it's as sensitive as the helper itself.
const PROTECTED_ROOTS = [CONFIG_DIR, DATA_DIR, APP_ROOT, WEB_ROOT, join(REPO_ROOT, "packages"), join(REPO_ROOT, "node_modules"), join(REPO_ROOT, "package.json"), join(REPO_ROOT, "package-lock.json")].map((p) =>
  normalize(p).toLowerCase(),
);
const SENSITIVE_PATH = new RegExp(
  [
    String.raw`[\\/](\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.claude[\\/](\.credentials|credentials))([\\/]|$|["'\s])`,
    String.raw`[\\/]Microsoft[\\/](Credentials|Protect|Vault)[\\/]`,
    String.raw`\.(pem|pfx|p12|kdbx|jks|keystore)(?=$|["'\s])`,
    String.raw`id_(rsa|ed25519|ecdsa)`,
    // Token and secret files commonly found in home and project folders.
    String.raw`(^|[\\/'"\s])(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|keystore\.properties)(?=$|["'\s])`,
    // Browser profiles: saved passwords and cookies.
    String.raw`[\\/]User Data[\\/].*[\\/](Login Data|Cookies|Web Data|Local State)|[\\/]Firefox[\\/]Profiles[\\/].*(logins\.json|key4\.db|cookies\.sqlite)`,
  ].join("|"),
  "i",
);
const OWN_FILES = /((\$env:|%)(APPDATA|LOCALAPPDATA)%?|AppData[\\/](Roaming|Local))[\\/]ClaudeAnywhere|Roam Desk[\\/](apps[\\/]desktop-helper|packages|node_modules|package(-lock)?\.json)/i;
// Files that make a later "safe" command run code: git hooks, Claude/VS Code settings, package scripts, shell scripts.
const RUNS_LATER = /[\\/]\.(git|claude|vscode|husky|github)[\\/]|[\\/](package\.json|\.npmrc|\.mcp\.json|CLAUDE\.md|Makefile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$|\.(ps1|psm1|bat|cmd|vbs|reg|lnk)$/i;
const ONEDRIVE = /[\\/](OneDrive|SharePoint)([ -][^\\/]*)?[\\/]/i;

function within(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
const envVar = (name: string) => process.env[name] ?? process.env[Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""] ?? "";
function absPath(p: string, cwd: string) {
  const expanded = p
    .replace(/^~(?=[\\/]|$)/, HOME)
    .replace(/\$HOME\b/gi, HOME)
    .replace(/\$env:(\w+)/gi, (_, n) => envVar(n))
    .replace(/%(\w+)%/g, (_, n) => envVar(n));
  return normalize(resolve(cwd, expanded));
}
/** In OneDrive or a synced SharePoint library: changes there sync to the cloud and to whoever it's shared with. */
function isCloud(p: string) {
  return ONEDRIVE.test(p) || syncRoots().some((r) => within(p, r));
}
const mentionsCloud = (cmd: string) => ONEDRIVE.test(cmd) || syncRoots().some((r) => cmd.toLowerCase().includes(r.toLowerCase()));

/**
 * A single plain `Copy-Item <file> <destination>` that puts a finished file (say a Word document or PDF built
 * elsewhere) into OneDrive/SharePoint as a NEW file: nothing there is overwritten, and nothing else runs.
 */
const COPY_ITEM = /^\s*Copy-Item\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]+"|'[^']+'|[^\s'"-][^\s'"]*)\s+(?:-Destination\s+)?("[^"]+"|'[^']+'|[^\s'"-][^\s'"]*)\s*$/i;
function newFileIntoCloud(cmd: string, cwd: string): boolean {
  if (/[;|&`$<>\r\n*?[\]]/.test(cmd)) return false;
  const m = COPY_ITEM.exec(cmd);
  if (!m) return false;
  const unquote = (s: string) => s.replace(/^(['"])([\s\S]*)\1$/, "$2");
  const src = absPath(unquote(m[1]), cwd);
  const dst = absPath(unquote(m[2]), cwd);
  try {
    if (!statSync(src).isFile()) return false;
  } catch {
    return false;
  }
  if (isSensitivePath(src)) return false;
  let target = dst;
  try {
    if (statSync(dst).isDirectory()) target = join(dst, basename(src));
  } catch {
    /* a new file name */
  }
  return isCloud(target) && !existsSync(target) && existsSync(dirname(target)) && !RUNS_LATER.test(target) && !isSensitivePath(target) && !isProtectedPath(target);
}

export function isSensitivePath(p: string) {
  return SENSITIVE_PATH.test(p) || OWN_FILES.test(p);
}

export function isProtectedPath(p: string) {
  const lp = p.toLowerCase();
  return PROTECTED_ROOTS.some((r) => lp === r || lp.startsWith(r + "\\") || lp.startsWith(r + "/"));
}

// ---------- PowerShell command rules ----------
const READ_VERBS = new Set(["get", "test", "select", "sort", "where", "foreach", "measure", "format", "convertto", "convertfrom", "compare", "group", "resolve", "split", "join", "find", "search", "show"]);
const READ_CMDLETS = new Set([
  "out-string", "out-null", "out-host", "write-output", "write-host", "write-verbose",
  // common aliases
  "dir", "ls", "gci", "cat", "type", "gc", "pwd", "gl", "echo", "where", "?", "%", "foreach", "sort", "select", "ft", "fl", "fw", "measure", "gps", "ps", "gsv", "gwmi", "gcim",
  // native read-only
  "hostname", "whoami", "ipconfig", "systeminfo", "tasklist", "where", "findstr", "tree", "ver", "netstat", "driverquery",
]);
// Network look-ups are read-only, but a long or many-part host name can smuggle data out through DNS.
const LOOKUP_CMDS = new Set(["nslookup", "ping", "tracert", "resolve-dnsname", "test-connection", "test-netconnection", "tnc"]);
const suspiciousHost = (args: string[]) => args.some((a) => a.split(".").some((label) => label.replace(/^['"]|['"]$/g, "").length > 24) || a.split(".").length > 6);
const TIER1_CMDLETS = new Set(["set-location", "cd", "sl", "push-location", "pop-location", "start-sleep", "sleep", "mkdir", "md"]);
const HARD_DENY_CMD = new Set([
  "format", "format-volume", "clear-disk", "initialize-disk", "diskpart", "bcdedit", "manage-bde", "disable-bitlocker", "cipher",
  "set-mppreference", "add-mppreference", "set-executionpolicy", "netsh", "reg", "regedit", "cmdkey", "vssadmin", "wbadmin",
  "net", "net1", "new-localuser", "remove-localuser", "set-localuser", "add-localgroupmember", "remove-localgroupmember",
  "restart-computer", "stop-computer", "shutdown", "logoff", "send-mailmessage", "set-netfirewallprofile", "disable-netfirewallrule",
  "takeown", "icacls", "set-acl", "schtasks", "register-scheduledtask", "unregister-scheduledtask",
]);
const DANGEROUS_MEMBER = /^(Delete|Write\w*|Remove\w*|Move\w*|Copy\w*|Kill|Start|Create\w*|Set\w*|Save\w*|Append\w*|Open\w*|Execute\w*|Invoke\w*|Download\w*|Upload\w*|Send\w*|Encrypt|Decrypt|Replace|Terminate|Win32Shutdown\w*|Shutdown|Reboot|Format|Load\w*|Run\w*|Exec\w*|Spawn\w*|Post\w*|Put\w*|Connect\w*)$/i;
// A member written as anything but a plain name ($o.$name, $o.('De'+'lete')) can't be checked, so it needs approval.
const PLAIN_MEMBER = /^\w+$/;

// Git options that run programs, write files or change config for one command.
const GIT_RISKY_OPTION = /^(-c|--config-env|--exec-path(=.*)?|--output(=.*)?|-O.*|--open-files-in-pager(=.*)?|--upload-pack(=.*)?|--receive-pack(=.*)?|--ext-diff|--textconv|-x|--exec(=.*)?|--run(=.*)?)$/;

function gitDecision(args: string[]): { tier: Tier; verb: string } {
  const a: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i].replace(/^['"]|['"]$/g, "");
    if (GIT_RISKY_OPTION.test(x)) return { tier: 2, verb: "run" };
    if (x === "-C" || x === "--git-dir" || x === "--work-tree") {
      i++; // skip the option's value
      continue;
    }
    if (x === "--no-pager" || /^--(git-dir|work-tree)=/.test(x)) continue;
    a.push(x);
  }
  const sub = a.find((x) => !x.startsWith("-")) ?? "";
  if (sub === "push") return a.some((x) => /^(-f|--force|--force-with-lease|--mirror|--delete|-d)$/.test(x) || x.startsWith("+")) ? { tier: "deny", verb: "push" } : { tier: 2, verb: "push" };
  if (["status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "blame", "shortlog", "ls-files", "tag", "config", "reflog", "grep"].includes(sub)) {
    if (sub === "branch" && a.some((x) => /^-(d|D|m|M)$|--delete|--move/.test(x))) return { tier: 2, verb: "change" };
    if (sub === "tag" && a.length > 1 && !a.includes("-l") && !a.includes("--list")) return { tier: 1, verb: "tag" };
    if (sub === "config" && !a.some((x) => /--get|--list|-l/.test(x))) return { tier: 2, verb: "change" };
    if (sub === "remote" && a.some((x) => /^(add|remove|rm|set-url|rename)$/.test(x))) return { tier: 2, verb: "change" };
    return { tier: 0, verb: "" };
  }
  if (["add", "commit", "fetch", "stash", "switch"].includes(sub)) return { tier: 1, verb: sub };
  if (sub === "checkout") return a.includes("-b") ? { tier: 1, verb: "branch" } : { tier: 2, verb: "discard" };
  if (sub === "pull") return { tier: 1, verb: "pull" };
  if (["reset", "clean", "restore", "rebase", "merge", "cherry-pick", "revert", "rm", "mv", "filter-branch", "gc", "prune", "worktree"].includes(sub)) return { tier: 2, verb: sub === "reset" || sub === "clean" || sub === "restore" ? "discard" : "change" };
  return { tier: 2, verb: "run" };
}

function pkgDecision(name: string, args: string[]): { tier: Tier; verb: string } {
  const sub = (args.find((x) => !x.startsWith("-")) ?? "").replace(/^['"]|['"]$/g, "");
  const readOnly = ["ls", "list", "view", "info", "outdated", "show", "search", "version", "audit", "why", "explain", "config-get"];
  // A version check only counts when it's the whole command: "-v" means "verbose" or "version to install" to several of these tools.
  const versionOnly = args.length === 1 && /^['"]?(--version|-v|-V)['"]?$/.test(args[0]);
  if (args.length === 0 || versionOnly || (readOnly.includes(sub) && !(sub === "audit" && args.some((x) => /^fix$/.test(x))))) return { tier: 0, verb: "" };
  if (["test", "t", "run", "run-script", "start", "build", "lint"].includes(sub)) return { tier: 1, verb: "run" };
  return { tier: 2, verb: name === "winget" || name === "choco" || name === "scoop" || /install|add|i|ci|update|upgrade|uninstall|remove/.test(sub) ? "install" : "run" };
}

const ORDER: Record<string, number> = { "0": 0, "1": 1, "2": 2, deny: 3 };
const worst = (a: Tier, b: Tier): Tier => (ORDER[String(a)] >= ORDER[String(b)] ? a : b);

export function classifyPowerShellAst(an: PsAnalysis, ctx: PolicyContext): { tier: Tier; verb: string; reason: string } {
  if (!an.ok) return { tier: 2, verb: "run", reason: `could not parse command (${an.errors[0] ?? "unknown"})` };
  let tier: Tier = 0;
  let verb = "";
  let reason = "read-only command";
  const bump = (t: Tier, v: string, r: string) => {
    if (ORDER[String(t)] > ORDER[String(tier)]) {
      tier = t;
      verb = v;
      reason = r;
    }
  };

  if (an.redirections > 0) bump(2, "write", "redirects output to a file");
  for (const m of an.members) {
    if (!PLAIN_MEMBER.test(m)) bump(2, "run", "calls a .NET method chosen at run time");
    else if (DANGEROUS_MEMBER.test(m)) bump(2, "run", `calls .NET method ${m}`);
  }

  for (const c of an.commands) {
    if (c.dynamic || !c.name) {
      bump(2, "run", "runs a dynamically named command");
      continue;
    }
    const raw = c.name.toLowerCase();
    const name = raw.replace(/\.exe$/, "").replace(/^.*[\\/]/, "");
    const argsText = c.args.join(" ");

    for (const a of c.args) {
      if (/^['"]?[a-z]:[\\/]|^['"]?[\\/]|^['"]?~|\$env:|\.\.[\\/]/i.test(a)) {
        const p = absPath(a.replace(/^['"]|['"]$/g, ""), ctx.sessionCwd);
        if (isProtectedPath(p)) bump("deny", "change", "touches Roam Desk's own files");
      }
    }
    if (OWN_FILES.test(argsText)) bump("deny", "change", "touches Roam Desk's own files");
    if (SENSITIVE_PATH.test(argsText)) bump("deny", "read", "touches credentials or keys");

    if (HARD_DENY_CMD.has(name)) {
      bump("deny", "run", `${name} is on the hard denylist`);
      continue;
    }
    if (/^(new-object)$/.test(name) && /-com/i.test(argsText) && /outlook/i.test(argsText)) {
      bump(2, "send", "uses Outlook (can send email as you)");
      continue;
    }
    if (/^(new-object)$/.test(name) && /-com/i.test(argsText) && /shell\.application|wscript/i.test(argsText)) {
      bump("deny", "run", "automates the Windows shell");
      continue;
    }
    if (name === "git") {
      const g = gitDecision(c.args);
      bump(g.tier, g.verb, `git ${c.args[0] ?? ""}`.trim());
      continue;
    }
    if (["npm", "pnpm", "yarn", "pip", "pip3", "winget", "choco", "scoop", "dotnet", "cargo"].includes(name)) {
      const p = pkgDecision(name, c.args);
      bump(p.tier, p.verb, `${name} ${c.args[0] ?? ""}`.trim());
      continue;
    }
    if (["node", "python", "python3", "py"].includes(name) && c.args.every((a) => /^(-v|--version|-V)$/.test(a))) continue;
    if (LOOKUP_CMDS.has(name)) {
      if (suspiciousHost(c.args)) bump(2, "run", `${name} with an unusual host name (could carry data out)`);
      continue;
    }

    const verbPart = name.includes("-") ? name.split("-")[0] : "";
    if (READ_CMDLETS.has(name) || READ_VERBS.has(verbPart)) {
      if (name === "get-content" && SENSITIVE_PATH.test(argsText)) bump("deny", "read", "reads credentials or keys");
      continue;
    }
    if (TIER1_CMDLETS.has(name) || (name === "new-item" && /-itemtype\s+['"]?directory/i.test(argsText))) {
      bump(1, "create", `${name}`);
      continue;
    }
    const v =
      /^(remove|del|erase|rd|rmdir|rm|ri|clear)/.test(name) ? "delete"
      : /^(move|mv|mi|rename|ren|rni)/.test(name) ? "move"
      : /^(stop|kill|taskkill)/.test(name) ? "end" // never "stop": the phone treats it as cancel
      : /^(install|uninstall|update)/.test(name) ? "install"
      : /^(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|start-bitstransfer)$/.test(name) ? "download"
      : /^(set|add|new|copy|cp|cpi|out-file|export|enable|disable|write)/.test(name) ? "change"
      : "run";
    bump(2, v, `${name} needs approval`);
  }
  return { tier, verb: verb || "run", reason };
}

function short(s: string, n = 90) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

// mcp__desktop-control__screen, or as a plugin server mcp__plugin_desktop-control_desktop__act.
const DESKTOP_CONTROL = /^mcp__(plugin_)?desktop[-_]control/i;

// Claude in Chrome: the PC's own Chrome, signed in as the user. Looking is free; moving between pages and tabs is
// announced; clicking, typing, running scripts, uploading files and anything batched needs approval.
const CHROME = /^mcp__claude-in-chrome__(.+)$/i;
const CHROME_LOOK = /^(tabs_context_mcp|get_page_text|read_page|find|read_console_messages|read_network_requests|list_connected_browsers|shortcuts_list)$/;
const CHROME_MOVE = /^(navigate|tabs_create_mcp|tabs_close_mcp|resize_window|select_browser|switch_browser)$/;
const CHROME_LOOK_ACTIONS = /^(screenshot|zoom|wait|scroll|scroll_to|hover)$/;

export function chromeDecision(action: string, input: Record<string, any>): Decision {
  const look = (label: string): Decision => ({ tier: 0, reason: "browser: look", summary: "", verb: "", label });
  if (CHROME_LOOK.test(action)) return look("Looking at the browser");
  if (action === "computer" && CHROME_LOOK_ACTIONS.test(String(input.action ?? ""))) return look("Looking at the browser");
  if (CHROME_MOVE.test(action)) return { tier: 1, reason: "browser: moves between pages and tabs", summary: action === "navigate" ? `open ${short(String(input.url ?? "a page"), 60)}` : "change browser tabs", verb: "run", label: "Using the browser" };
  return { tier: 2, reason: "browser: acts in the PC's Chrome, signed in as you", summary: action === "javascript_tool" ? "run a script in the browser" : "click, type or send something in the browser", verb: "run", label: "Using the browser" };
}

// A URL that could be carrying data out: a long token-like run, or simply a very long address.
function suspiciousUrl(url: string) {
  return url.length > 300 || /[A-Za-z0-9+/=_%-]{40,}/.test(url.replace(/^https?:\/\/[^/]+/, ""));
}

export async function decide(tool: string, input: Record<string, any>, ctx: PolicyContext): Promise<Decision> {
  // Desktop control (apps/desktop-control) drives the real mouse and keyboard. Looking is free everywhere. From the
  // phone, acting runs without a prompt (nobody can tap Approve while driving; every step is still audited and the
  // kill switch stops it). From a browser, acting needs approval like any other risky step (the permission mode applies).
  if (DESKTOP_CONTROL.test(tool)) {
    const action = tool.replace(/^.*__/, "");
    if (/^(screen|wait_for|zoom|windows)$/.test(action)) return { tier: 0, reason: "desktop control: look", summary: "", verb: "", label: "Looking at the screen" };
    const summary = action === "focus_window" ? "bring a window to the front" : "use the mouse and keyboard on the PC";
    return { tier: ctx.origin === "browser" ? 2 : 1, reason: "desktop control: uses the mouse and keyboard", summary, verb: "run", label: "Using the PC's mouse and keyboard" };
  }
  const chrome = CHROME.exec(tool);
  if (chrome) return chromeDecision(chrome[1], input);
  const d = await decideTool(tool, input, ctx);
  if (d.tier === "deny" && /credentials|keys|own files|protected file/i.test(d.reason)) d.locked = true;
  return d;
}

async function decideTool(tool: string, input: Record<string, any>, ctx: PolicyContext): Promise<Decision> {
  const desc = typeof input.description === "string" && input.description.trim() ? input.description.trim() : "";

  switch (tool) {
    case "Read":
    case "Glob":
    case "Grep":
    case "LS": {
      const targets = [input.file_path, input.path, input.pattern, input.glob].filter((x) => typeof x === "string") as string[];
      if (targets.some((p) => SENSITIVE_PATH.test(p) || SENSITIVE_PATH.test(absPath(p, ctx.sessionCwd))))
        return { tier: "deny", reason: "credentials or keys are off limits", summary: "", verb: "read", label: "" };
      return { tier: 0, reason: "read", summary: "", verb: "", label: tool === "Read" ? "Reading a file" : "Searching files" };
    }
    case "TodoWrite":
    case "ToolSearch":
    case "Task":
    case "Agent":
      return { tier: 0, reason: "internal", summary: "", verb: "", label: "Planning" };
    case "WebSearch":
      return { tier: 0, reason: "web search", summary: "", verb: "", label: "Searching the web" };
    case "WebFetch": {
      const url = String(input.url ?? "");
      if (suspiciousUrl(url)) return { tier: 2, reason: "web address could carry data off the PC", summary: `open a web address on ${short(url.replace(/^https?:\/\//, "").split("/")[0], 40)}`, verb: "fetch", label: "Reading a web page" };
      return { tier: 1, reason: "fetches a web page", summary: `fetch ${short(url || "a web page", 60)}`, verb: "fetch", label: "Reading a web page" };
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const p = absPath(String(input.file_path ?? input.notebook_path ?? ""), ctx.sessionCwd);
      const name = p.split(/[\\/]/).pop();
      if (isProtectedPath(p) || OWN_FILES.test(p) || SENSITIVE_PATH.test(p)) return { tier: "deny", reason: "protected file", summary: "", verb: "write", label: "" };
      const inWorkspace = normalize(ctx.sessionCwd).toLowerCase() !== normalize(HOME).toLowerCase() && within(p, ctx.sessionCwd);
      // Plan mode writes its plan as Markdown under ~/.claude/plans: plain text, nothing runs it.
      if (isPlanFile(p)) return { tier: 1, reason: "writes the plan", summary: "write the plan", verb: "write", label: "Writing the plan" };
      if (RUNS_LATER.test(p))
        return { tier: 2, reason: "changes a file that runs code later (hooks, settings, scripts)", summary: `${tool === "Write" ? "write" : "edit"} ${name}, which can run code later`, verb: "write", label: `Editing ${name}` };
      const cloud = isCloud(p);
      if (inWorkspace && !cloud) return { tier: 1, reason: "edit inside session folder", summary: `edit ${name}`, verb: "edit", label: `Editing ${name}` };
      // Saving a NEW file into OneDrive/SharePoint (e.g. into a project folder) goes ahead; changing what's there still asks.
      if (tool === "Write" && cloud && !existsSync(p))
        return { tier: 1, reason: "saves a new file in OneDrive/SharePoint", summary: `save ${name} in ${short(p.split(/[\\/]/).slice(-3, -1).join("\\"), 40)}`, verb: "save", label: `Saving ${name}` };
      return { tier: 2, reason: cloud ? "changes a file in OneDrive/SharePoint" : "writes outside the session folder", summary: `${tool === "Write" ? "write" : "edit"} ${name} in ${short(p.split(/[\\/]/).slice(-3, -1).join("\\"), 40)}`, verb: "write", label: `Editing ${name}` };
    }
    case "PowerShell": {
      const cmd = String(input.command ?? "");
      const an = await analysePowerShell(cmd);
      const c = classifyPowerShellAst(an, ctx);
      const label = desc ? desc.charAt(0).toUpperCase() + desc.slice(1) : "Running a command";
      if (c.tier !== "deny" && newFileIntoCloud(cmd, ctx.sessionCwd))
        return { tier: 1, reason: "copies a new file into OneDrive/SharePoint", summary: desc ? desc.charAt(0).toLowerCase() + desc.slice(1) : `copy a new file into ${short(cmd, 50)}`, verb: "copy", label };
      if (c.tier !== "deny" && mentionsCloud(cmd) && c.tier !== 0) c.tier = 2;
      return { tier: c.tier, reason: c.reason, summary: desc ? desc.charAt(0).toLowerCase() + desc.slice(1) : `run ${short(cmd, 60)}`, verb: c.verb, label };
    }
    default: {
      // Connector tools: mcp__<server>__<action>. Look-ups are free; anything that sends or changes needs approval.
      if (tool === "mcp__phone__send_file") {
        const p = absPath(String(input.file_path ?? input.path ?? ""), ctx.sessionCwd);
        if (isSensitivePath(p)) return { tier: "deny", reason: "credentials, keys or the helper's own files can't be sent", summary: "", verb: "send", label: "" };
        return { tier: 1, reason: "sends a file to the phone", summary: `send ${p.split(/[\\/]/).pop()} to your phone`, verb: "send", label: "Sending you a file" };
      }
      // Only puts choices in front of the user; their answer is the approval.
      if (tool === "mcp__phone__ask_user") return { tier: 0, reason: "asks the user to choose", summary: "", verb: "", label: "Asking you" };
      const m = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (m) {
        const server = m[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
        const action = m[2].replace(/_/g, " ");
        if (/^(get|list|search|find|read|query|fetch|lookup|check|describe|show|view|download|export)\b|\b(search|status|scopes|availability|me)$/i.test(action) && !/send|create|update|delete|modify|move|trash|upload|forward|reply|respond|set|copy|rename|batch/i.test(action)) {
          return { tier: 0, reason: `${server} look-up`, summary: "", verb: "", label: `Checking ${server}` };
        }
        const verb = /send|forward|reply|respond/i.test(action) ? "send" : /delete|trash/i.test(action) ? "delete" : "change";
        return { tier: 2, reason: `${server}: ${action}`, summary: desc || `${action} in ${server}`, verb, label: `${server}: ${action}` };
      }
      // Any other built-in tool: allowed, but treated as risky.
      return { tier: 2, reason: `${tool} tool`, summary: desc || `use ${tool}`, verb: "run", label: desc || `Using ${tool}` };
    }
  }
}

export const _test = { gitDecision, pkgDecision, absPath, within, worst };
