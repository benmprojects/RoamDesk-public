// Files a browser attaches to a message. The browser asks for a one-time upload slot over its authenticated
// WebSocket, then sends the bytes over HTTPS with the slot's token (the WebSocket only carries small frames).
// Uploads are kept outside the helper's own data folder, so Claude may read them, and deleted after a week.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AttachmentInfo } from "@claude-anywhere/protocol";

export const UPLOAD_DIR = process.env.CA_UPLOAD_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ClaudeAnywhereUploads");
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Claude takes images up to 5 MB once base64 encoded. Bigger images are attached as files instead. */
const MAX_INLINE_IMAGE_BYTES = 3_700_000;
const MAX_PENDING_PER_DEVICE = 20;
const SLOT_TTL_MS = 10 * 60_000;
const KEEP_DAYS = 7;

interface Slot {
  id: string;
  token: string;
  deviceId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  path?: string;
  used?: boolean;
}
const slots = new Map<string, Slot>();

/** A file name that's safe on Windows and still recognisable. */
export function safeName(name: string) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) || !clean ? `file${clean ? `_${clean}` : ""}` : clean;
}

/** The real image type from the first bytes (the browser's MIME type isn't trusted). */
export function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function expire() {
  const now = Date.now();
  for (const [id, s] of slots) if (!s.path && now - s.createdAt > SLOT_TTL_MS) slots.delete(id);
}

export function beginUpload(deviceId: string, f: { name: unknown; size: unknown; mime: unknown }): { ok: true; id: string; token: string } | { ok: false; error: string } {
  expire();
  const size = Number(f.size);
  if (!Number.isInteger(size) || size < 1) return { ok: false, error: "That file is empty." };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, error: `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };
  const pending = [...slots.values()].filter((s) => s.deviceId === deviceId && !s.used).length;
  if (pending >= MAX_PENDING_PER_DEVICE) return { ok: false, error: "Too many attachments waiting. Send or remove some first." };
  const id = `up_${randomBytes(9).toString("base64url")}`;
  const token = randomBytes(24).toString("base64url");
  slots.set(id, { id, token, deviceId, name: safeName(String(f.name ?? "")), mime: String(f.mime ?? "").slice(0, 100), size, createdAt: Date.now() });
  return { ok: true, id, token };
}

/** Stream the request body into the slot's file. The token must match and the size must be exactly as announced. */
export function receiveUpload(id: string, token: string, req: IncomingMessage): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  const slot = slots.get(id);
  const a = Buffer.from(String(token));
  const b = Buffer.from(slot?.token ?? "");
  if (!slot || slot.path || a.length !== b.length || !timingSafeEqual(a, b)) return Promise.resolve({ ok: false, code: 404, error: "Unknown or used upload." });
  const dir = join(UPLOAD_DIR, slot.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, slot.name);
  return new Promise((resolve) => {
    let got = 0;
    let failed = false;
    const out = createWriteStream(file, { flags: "wx" });
    const fail = (code: number, error: string) => {
      if (failed) return;
      failed = true;
      out.destroy();
      req.destroy();
      rmSync(dir, { recursive: true, force: true });
      slots.delete(id);
      resolve({ ok: false, code, error });
    };
    req.on("data", (chunk: Buffer) => {
      got += chunk.length;
      if (got > slot.size) fail(413, "The file is bigger than announced.");
    });
    req.on("error", () => fail(400, "The upload was interrupted."));
    out.on("error", () => fail(500, "Couldn't save the file on the PC."));
    out.on("finish", () => {
      if (failed) return;
      if (got !== slot.size) return fail(400, "The upload was incomplete.");
      slot.path = file;
      resolve({ ok: true });
    });
    req.pipe(out);
  });
}

/**
 * The finished uploads a device attached to a message, as Claude content: images inline (checked by their bytes),
 * everything else as saved files named in the text. Each upload can be used once, by the device that made it.
 */
export function takeAttachments(deviceId: string, ids: unknown): { infos: AttachmentInfo[]; images: object[]; filesNote: string; missing: number } {
  const infos: AttachmentInfo[] = [];
  const images: object[] = [];
  const files: string[] = [];
  let missing = 0;
  for (const raw of Array.isArray(ids) ? ids.slice(0, 20) : []) {
    const s = slots.get(String(raw));
    if (!s || s.deviceId !== deviceId || !s.path || s.used) {
      missing++;
      continue;
    }
    s.used = true;
    let image: string | null = null;
    if (s.size <= MAX_INLINE_IMAGE_BYTES) {
      const data = readFileSync(s.path);
      image = sniffImage(data.subarray(0, 16));
      if (image) images.push({ type: "image", source: { type: "base64", media_type: image, data: data.toString("base64") } });
    }
    if (image) infos.push({ name: s.name, mime: image, size: s.size, kind: "image" });
    else {
      infos.push({ name: s.name, mime: s.mime, size: s.size, kind: "file", path: s.path });
      files.push(`- ${s.name}: ${s.path}`);
    }
  }
  const filesNote = files.length ? `\n\nAttached files (saved on this PC; read them as needed):\n${files.join("\n")}` : "";
  return { infos, images, filesNote, missing };
}

/** Delete uploads older than a week. */
export function cleanUploads() {
  if (!existsSync(UPLOAD_DIR)) return;
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const d of readdirSync(UPLOAD_DIR)) {
    const p = join(UPLOAD_DIR, d);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch {
      /* in use or already gone */
    }
  }
}
