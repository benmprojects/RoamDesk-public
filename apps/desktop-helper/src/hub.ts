// Fan-out to paired phones with per-device sequence numbers and a replay buffer (memory + disk).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { HelperMessages } from "@claude-anywhere/protocol";
import { listDevices } from "./devices.js";
import { REPLAY_DIR } from "./paths.js";

const MAX_FRAMES = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Frames that are only useful live — not buffered or replayed.
const EPHEMERAL = new Set<keyof HelperMessages>(["reply.delta", "pong", "auth.challenge", "auth.ok", "auth.fail", "catalog", "app.update", "history", "commands", "prompt.suggestion", "files", "upload.ready", "history.page", "folders", "changes", "file.content", "inbox", "routines", "doctor"]);

interface Buffered {
  seq: number;
  ts: number;
  frame: string; // serialised envelope
}
interface DeviceState {
  seq: number;
  frames: Buffered[];
  dirty: boolean;
}

const state = new Map<string, DeviceState>();
const sockets = new Map<string, Set<WebSocket>>();
const listeners = new Set<(connected: number) => void>();

function deviceState(deviceId: string): DeviceState {
  let s = state.get(deviceId);
  if (!s) {
    const file = join(REPLAY_DIR, `${deviceId}.json`);
    s = existsSync(file) ? { ...JSON.parse(readFileSync(file, "utf8")), dirty: false } : { seq: 0, frames: [], dirty: false };
    state.set(deviceId, s!);
  }
  return s!;
}

setInterval(() => {
  for (const [id, s] of state) {
    if (!s.dirty) continue;
    s.dirty = false;
    writeFileSync(join(REPLAY_DIR, `${id}.json`), JSON.stringify({ seq: s.seq, frames: s.frames }));
  }
}, 2000).unref();

export function envelope<K extends keyof HelperMessages>(type: K, payload: HelperMessages[K], seq?: number) {
  return { v: 1 as const, type, id: randomUUID(), ts: Date.now(), ...(seq !== undefined ? { seq } : {}), payload };
}

/** Send to one socket without buffering (handshake, pong). */
export function sendDirect<K extends keyof HelperMessages>(ws: WebSocket, type: K, payload: HelperMessages[K]) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(envelope(type, payload)));
}

/** Who a message is for. Browsers are the web client; every other paired device is a phone. */
export type Audience = "all" | "browser" | "phone";
const isBrowser = (platform: string) => platform === "browser";
// Full turn detail is only for the web client; the phone app has no use for it.
const BROWSER_ONLY = new Set<keyof HelperMessages>(["turn.item", "turn.usage", "ask.request", "ask.resolved", "commands", "prompt.suggestion"]);

export function audienceOf(deviceId: string): Exclude<Audience, "all"> | null {
  const d = listDevices().find((x) => x.deviceId === deviceId);
  return d ? (isBrowser(d.platform) ? "browser" : "phone") : null;
}

/** Connected devices of one kind (approvals and questions need someone there to answer). */
export function connectedCountFor(to: Audience) {
  let n = 0;
  for (const d of listDevices()) if (to === "all" || (to === "browser") === isBrowser(d.platform)) n += sockets.get(d.deviceId)?.size ?? 0;
  return n;
}

/** Broadcast to paired devices (all, or one kind); buffered for replay unless ephemeral. */
export function broadcast<K extends keyof HelperMessages>(type: K, payload: HelperMessages[K], to: Audience = "all") {
  if (BROWSER_ONLY.has(type)) to = "browser";
  for (const d of listDevices()) {
    if (to !== "all" && (to === "browser") !== isBrowser(d.platform)) continue;
    const conns = sockets.get(d.deviceId);
    if (EPHEMERAL.has(type)) {
      const text = JSON.stringify(envelope(type, payload));
      conns?.forEach((ws) => ws.readyState === ws.OPEN && ws.send(text));
      continue;
    }
    const s = deviceState(d.deviceId);
    s.seq += 1;
    const text = JSON.stringify(envelope(type, payload, s.seq));
    s.frames.push({ seq: s.seq, ts: Date.now(), frame: text });
    const cutoff = Date.now() - MAX_AGE_MS;
    while (s.frames.length > MAX_FRAMES || (s.frames[0] && s.frames[0].ts < cutoff)) s.frames.shift();
    s.dirty = true;
    conns?.forEach((ws) => ws.readyState === ws.OPEN && ws.send(text));
  }
}

export function attach(deviceId: string, ws: WebSocket, lastSeq: number): number {
  const s = deviceState(deviceId);
  // If the phone's lastSeq is ahead of ours (e.g. helper data reset), replay nothing.
  const from = lastSeq > s.seq ? s.seq : lastSeq;
  if (!sockets.has(deviceId)) sockets.set(deviceId, new Set());
  sockets.get(deviceId)!.add(ws);
  notify();
  return from;
}

export function replay(deviceId: string, ws: WebSocket, fromSeq: number) {
  const s = deviceState(deviceId);
  for (const f of s.frames) {
    if (f.seq <= fromSeq) continue;
    const env = JSON.parse(f.frame);
    env.payload = { ...env.payload, replay: true };
    ws.send(JSON.stringify(env));
  }
}

export function detach(deviceId: string, ws: WebSocket) {
  sockets.get(deviceId)?.delete(ws);
  if (sockets.get(deviceId)?.size === 0) sockets.delete(deviceId);
  notify();
}

export function disconnectDevice(deviceId: string) {
  sockets.get(deviceId)?.forEach((ws) => ws.close(4001, "revoked"));
  sockets.delete(deviceId);
  state.delete(deviceId);
  // The buffered frames include file access keys: a revoked phone's copy goes too.
  if (/^[\w-]{1,64}$/.test(deviceId)) rmSync(join(REPLAY_DIR, `${deviceId}.json`), { force: true });
  notify();
}

export function connectedCount() {
  let n = 0;
  for (const s of sockets.values()) n += s.size;
  return n;
}
export function connectedDevices() {
  return [...sockets.keys()];
}

export function onConnectionChange(fn: (connected: number) => void) {
  listeners.add(fn);
}
function notify() {
  const n = connectedCount();
  listeners.forEach((fn) => fn(n));
}
