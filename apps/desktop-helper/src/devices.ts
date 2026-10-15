// Paired phones: one-time pairing codes, device secrets in Windows Credential Manager, HMAC auth.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import type { PairQr, PairRequest, PairResponse } from "@claude-anywhere/protocol";
import { CONFIG_DIR } from "./paths.js";

const KEYRING_SERVICE = "ClaudeAnywhere";
const DEVICES_FILE = join(CONFIG_DIR, "devices.json");
const HELPER_FILE = join(CONFIG_DIR, "helper.json");
const PAIR_TTL_S = 300;

export interface Device {
  deviceId: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeen?: string;
}

const b64u = (b: Buffer) => b.toString("base64url");

function loadDevices(): Device[] {
  return existsSync(DEVICES_FILE) ? JSON.parse(readFileSync(DEVICES_FILE, "utf8")) : [];
}
let devices = loadDevices();
const save = () => writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));

export const helperId: string = (() => {
  if (existsSync(HELPER_FILE)) return JSON.parse(readFileSync(HELPER_FILE, "utf8")).helperId;
  const id = `hlp_${b64u(randomBytes(9))}`;
  writeFileSync(HELPER_FILE, JSON.stringify({ helperId: id }, null, 2));
  return id;
})();

const secretEntry = (deviceId: string) => new Entry(KEYRING_SERVICE, `device/${deviceId}`);

// ---- pairing codes (in memory only) ----
const codes = new Map<string, number>(); // code -> expiry (unix s)

export function createPairCode(name: string, hosts: string[], port: number, secure?: { host: string; port: number }): PairQr {
  const now = Math.floor(Date.now() / 1000);
  for (const [c, exp] of codes) if (exp < now) codes.delete(c);
  const code = b64u(randomBytes(16));
  const exp = now + PAIR_TTL_S;
  codes.set(code, exp);
  return { v: 1, kind: "claude-anywhere-pair", name, hosts, port, code, exp, ...(secure ? { secureHost: secure.host, securePort: secure.port } : {}) };
}

export function redeemPairCode(req: PairRequest, helperName: string): PairResponse | null {
  const exp = codes.get(req.code);
  codes.delete(req.code); // one use, success or not
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  const deviceId = `dev_${b64u(randomBytes(9))}`;
  const secret = randomBytes(32);
  secretEntry(deviceId).setPassword(b64u(secret));
  devices.push({
    deviceId,
    name: String(req.deviceName || (req.platform === "browser" ? "Browser" : req.platform === "ios" ? "iPhone" : "Android phone")).slice(0, 60),
    platform: req.platform === "android" || req.platform === "browser" || req.platform === "ios" ? req.platform : "unknown",
    createdAt: new Date().toISOString(),
  });
  save();
  return { deviceId, deviceSecret: b64u(secret), helperId, helperName };
}

export function computeMac(secretB64u: string, nonce: string, deviceId: string) {
  return createHmac("sha256", Buffer.from(secretB64u, "base64url")).update(`${nonce}|${deviceId}`, "utf8").digest("base64url");
}

/** The helper's answer to the phone's own challenge, so the phone knows it reached the PC it paired with. */
export function computeHelperProof(secretB64u: string, phoneNonce: string, nonce: string, deviceId: string) {
  return createHmac("sha256", Buffer.from(secretB64u, "base64url")).update(`helper|${phoneNonce}|${nonce}|${deviceId}|${helperId}`, "utf8").digest("base64url");
}

function deviceSecret(deviceId: string): string | null {
  if (!devices.some((d) => d.deviceId === deviceId)) return null;
  try {
    return secretEntry(deviceId).getPassword() || null;
  } catch {
    return null;
  }
}

/** Checks the phone's MAC. Returns the helper's proof for the phone's nonce (empty if the phone sent none), or null if auth fails. */
export function verifyDevice(deviceId: string, nonce: string, mac: string, phoneNonce = ""): string | null {
  const secret = deviceSecret(deviceId);
  if (!secret) return null;
  const expected = Buffer.from(computeMac(secret, nonce, deviceId));
  const got = Buffer.from(String(mac));
  if (!(expected.length === got.length && timingSafeEqual(expected, got))) return null;
  return phoneNonce ? computeHelperProof(secret, phoneNonce, nonce, deviceId) : "";
}

export function touchDevice(deviceId: string) {
  const d = devices.find((x) => x.deviceId === deviceId);
  if (d) {
    d.lastSeen = new Date().toISOString();
    save();
  }
}

export function listDevices(): Device[] {
  return devices.map((d) => ({ ...d }));
}

export function revokeDevice(deviceId: string): boolean {
  const before = devices.length;
  devices = devices.filter((d) => d.deviceId !== deviceId);
  try {
    secretEntry(deviceId).deletePassword();
  } catch {
    /* already gone */
  }
  save();
  return devices.length !== before;
}
