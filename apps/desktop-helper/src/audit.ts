// Append-only, hash-chained audit log: %LOCALAPPDATA%\ClaudeAnywhere\audit\YYYY-MM-DD.jsonl
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_DIR } from "./paths.js";

export interface AuditEntry {
  event: string;
  sessionId?: string;
  turnId?: string;
  tool?: string;
  input?: unknown;
  tier?: number | "deny";
  decision?: string;
  approver?: "auto" | "voice" | "phone-button" | "browser" | "server" | "policy";
  reason?: string;
  heard?: string;
  [k: string]: unknown;
}

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /(password|passwd|secret|token|apikey|api_key)(["'\s:=]+)([^\s"',;]{6,})/gi,
  /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/g,
  /(-Password|ConvertTo-SecureString(?:\s+-String)?|\bpwd)(["'\s:=]+)([^\s"',;]{4,})/gi,
];

export function maskSecrets(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (m, a, b) => (b !== undefined && typeof a === "string" && /password|secret|token|api/i.test(a) ? `${a}${b}***` : "***"));
  }
  return out;
}

/** Mask each string value on its own: masking the serialised JSON can eat an escape and corrupt it. */
function maskDeep(v: unknown): unknown {
  if (typeof v === "string") return maskSecrets(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

let lastHash = "";
let currentFile = "";

function fileFor(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(AUDIT_DIR, `${y}-${m}-${day}.jsonl`);
}

function loadLastHash(file: string) {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").trim().split("\n");
  try {
    return JSON.parse(lines[lines.length - 1]).hash ?? "";
  } catch {
    return "";
  }
}

export function audit(entry: AuditEntry) {
  const file = fileFor();
  if (file !== currentFile) {
    currentFile = file;
    lastHash = loadLastHash(file);
  }
  const body = maskDeep({ ts: new Date().toISOString(), ...entry, prevHash: lastHash }) as Record<string, unknown>;
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  appendFileSync(file, JSON.stringify({ ...body, hash }) + "\n");
  lastHash = hash;
}

/** Verify a day's chain; returns the index of the first bad line or -1. */
export function verifyChain(file: string): number {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    const { hash, ...body } = JSON.parse(lines[i]);
    if (body.prevHash !== prev) return i;
    if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== hash) return i;
    prev = hash;
  }
  return -1;
}

export function recentAudit(limit = 50): AuditEntry[] {
  const files = readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const out: AuditEntry[] = [];
  for (const f of files) {
    const lines = readFileSync(join(AUDIT_DIR, f), "utf8").trim().split("\n").reverse();
    for (const l of lines) {
      if (!l) continue;
      out.push(JSON.parse(l));
      if (out.length >= limit) return out;
    }
  }
  return out;
}
