// Files Claude hands to the phone. Each is copied into an outbox so it survives the original moving, offered to the
// phone over the websocket, and downloaded by the phone over HTTP with an unguessable per-file access key.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { broadcast } from "./hub.js";
import { DATA_DIR } from "./paths.js";

const OUTBOX = join(DATA_DIR, "outbox");
const INDEX = join(OUTBOX, "index.json");
const MAX_BYTES = 200 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;

interface Entry {
  id: string;
  access: string;
  file: string;
  name: string;
  size: number;
  mime: string;
  expiresAt: number;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".xml": "application/xml", ".zip": "application/zip", ".log": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".apk": "application/vnd.android.package-archive",
  ".dwg": "application/acad", ".kml": "application/vnd.google-earth.kml+xml", ".gpx": "application/gpx+xml",
};

let entries = new Map<string, Entry>();

function load() {
  try {
    entries = new Map((JSON.parse(readFileSync(INDEX, "utf8")) as Entry[]).map((e) => [e.id, e]));
  } catch {
    entries = new Map();
  }
  sweep();
}
function save() {
  mkdirSync(OUTBOX, { recursive: true });
  writeFileSync(INDEX, JSON.stringify([...entries.values()]));
}
function sweep() {
  const now = Date.now();
  let changed = false;
  for (const e of entries.values()) {
    if (e.expiresAt > now && existsSync(e.file)) continue;
    rmSync(join(OUTBOX, e.id), { recursive: true, force: true });
    entries.delete(e.id);
    changed = true;
  }
  if (changed) save();
}
load();
setInterval(sweep, 60 * 60 * 1000).unref();

export type OfferResult = { ok: true; name: string; size: number } | { ok: false; error: string };

export function offerFile(rawPath: string, caption: string, turnId?: string): OfferResult {
  const given = String(rawPath ?? "").trim().replace(/^["']|["']$/g, "");
  if (!given) return { ok: false, error: "No file path was given." };
  const p = resolve(given);
  if (!existsSync(p)) return { ok: false, error: `No such file: ${p}` };
  const st = statSync(p);
  if (!st.isFile()) return { ok: false, error: "That's a folder. Zip it first, or send the files one at a time." };
  if (st.size === 0) return { ok: false, error: "That file is empty." };
  if (st.size > MAX_BYTES) return { ok: false, error: `That file is ${(st.size / 1048576).toFixed(0)} MB; the limit is ${MAX_BYTES / 1048576} MB.` };

  const id = randomBytes(9).toString("base64url");
  const access = randomBytes(24).toString("base64url");
  const name = basename(p).replace(/[\x00-\x1f"\\/:*?<>|]/g, "_").slice(0, 120) || "file";
  const dir = join(OUTBOX, id);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, name);
  try {
    copyFileSync(p, copy);
  } catch (e: any) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `Couldn't read the file (${e?.code ?? e?.message}). Is it open in another program?` };
  }
  const entry: Entry = { id, access, file: copy, name, size: st.size, mime: MIME[extname(name).toLowerCase()] ?? "application/octet-stream", expiresAt: Date.now() + TTL_MS };
  entries.set(id, entry);
  save();
  broadcast("file", { fileId: id, ...(turnId ? { turnId } : {}), name, size: st.size, mime: entry.mime, caption: String(caption ?? "").slice(0, 300), access, expiresAt: entry.expiresAt });
  return { ok: true, name, size: st.size };
}

/** GET /file/<id>?a=<access>. Constant-time check; 404 for anything wrong so ids can't be probed. */
export function serveFile(id: string, presented: string, res: ServerResponse) {
  const e = entries.get(id);
  const a = Buffer.from(presented ?? "");
  const b = Buffer.from(e?.access ?? "");
  if (!e || a.length !== b.length || !timingSafeEqual(a, b) || e.expiresAt < Date.now() || !existsSync(e.file)) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end('{"error":"not found"}');
  }
  res.writeHead(200, {
    "content-type": e.mime,
    "content-length": e.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(e.name)}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // The web client is served from this same address: a file must never run as a page here, even if opened directly.
    "content-security-policy": "sandbox; default-src 'none'",
  });
  createReadStream(e.file).on("error", () => res.destroy()).pipe(res);
}
