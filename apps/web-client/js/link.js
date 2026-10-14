// The WebSocket to the helper, on the same HTTPS address this page came from. Mutual authentication: the browser
// signs the helper's challenge with its device key, and checks the helper's proof that it knows the same key.
import { hmac, loadPairing, randomToken } from "./keystore.js";

export class Link {
  /**
   * @param {{ onFrame: (env: any) => void, onState: (kind: string, message?: string) => void }} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.authed = false;
    this.lastSeq = 0; // 0 on page load: the helper replays its recent buffer, which rebuilds the conversation
    this.retryMs = 1000;
    this.timer = null;
    this.pingTimer = null;
    this.stopped = false;
  }

  async connect() {
    clearTimeout(this.timer);
    const pairing = await loadPairing();
    if (!pairing) return this.h.onState("unpaired");
    this.h.onState("connecting");
    // Always wss on the PC's HTTPS address; ws only for the local mock helper used in development.
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    this.authed = false;
    let nonce = "";
    let ownNonce = "";

    ws.onmessage = async (ev) => {
      let env;
      try {
        env = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!this.authed) {
        if (env.type === "auth.challenge") {
          if (env.payload.helperId !== pairing.helperId) {
            this.h.onState("error", "This address now belongs to a different PC helper. Pair this browser again.");
            return ws.close();
          }
          nonce = String(env.payload.nonce);
          ownNonce = randomToken();
          const mac = await hmac(pairing.key, `${nonce}|${pairing.deviceId}`);
          ws.send(JSON.stringify(envelope("auth.response", { deviceId: pairing.deviceId, mac, lastSeq: this.lastSeq, phoneNonce: ownNonce })));
          return;
        }
        if (env.type === "auth.ok") {
          const want = await hmac(pairing.key, `helper|${ownNonce}|${nonce}|${pairing.deviceId}|${pairing.helperId}`);
          if (env.payload.proof !== want) {
            this.h.onState("error", "The PC couldn't prove it's the one this browser was paired with, so the connection was closed.");
            this.stopped = true;
            return ws.close();
          }
          this.authed = true;
          this.retryMs = 1000;
          this.h.onState("connected");
          this.h.onFrame(env);
          this.pingTimer = setInterval(() => this.send("ping", {}), 25_000);
          return;
        }
        if (env.type === "auth.fail") {
          this.stopped = true;
          this.h.onState("revoked", "The PC no longer recognises this browser. Pair it again from the helper dashboard.");
          return ws.close();
        }
        return;
      }
      if (typeof env.seq === "number" && env.seq > this.lastSeq) this.lastSeq = env.seq;
      this.h.onFrame(env);
    };

    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      if (ev.code === 4001) {
        this.stopped = true;
        return this.h.onState("revoked", "This browser was unpaired on the PC.");
      }
      if (this.stopped) return;
      this.h.onState("offline", "Can't reach the PC. Retrying…");
      this.timer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(15_000, this.retryMs * 2);
    };
    ws.onerror = () => ws.close();
  }

  /** Reconnect now (after the network comes back or the tab becomes visible). */
  nudge() {
    if (this.stopped || this.ws) return;
    this.retryMs = 1000;
    this.connect();
  }

  send(type, payload) {
    if (!this.ws || !this.authed || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(envelope(type, payload)));
    return true;
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}

function envelope(type, payload) {
  return { v: 1, type, id: crypto.randomUUID(), ts: Date.now(), payload };
}
