// This browser's pairing with the PC. The device secret is turned straight into a WebCrypto HMAC key that can't be
// exported, and only that key is stored (IndexedDB). Page scripts can use it to sign, but nothing can read it out.

const DB_NAME = "claude-anywhere";
const STORE = "pairing";
const KEY = "device";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export function b64uDecode(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function b64uEncode(bytes) {
  let s = "";
  new Uint8Array(bytes).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(n = 32) {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(n)));
}

/** Store a new pairing. The raw secret is wiped from memory once imported. */
export async function savePairing({ deviceId, deviceSecret, helperId, helperName }) {
  const raw = b64uDecode(deviceSecret);
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  raw.fill(0);
  await tx("readwrite", (s) => s.put({ deviceId, helperId, helperName, key, pairedAt: Date.now() }, KEY));
}

/** @returns {Promise<{ deviceId: string, helperId: string, helperName: string, key: CryptoKey } | null>} */
export async function loadPairing() {
  try {
    return (await tx("readonly", (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function forgetPairing() {
  await tx("readwrite", (s) => s.delete(KEY));
}

export async function hmac(key, text) {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return b64uEncode(sig);
}
