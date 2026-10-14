// Attachments in the composer: each file is uploaded straight away into a one-time slot the helper hands out over
// the authenticated WebSocket (POST /upload/<id> with the slot's token), and sent with the message by id.
import { clear, h } from "./dom.js";
import { formatSize } from "./composer.js";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 10;

export class Attachments {
  /**
   * @param {{ link: { send: (type: string, payload: object) => boolean }, tray: HTMLElement, toast: (text: string) => void, onChange: () => void }} o
   */
  constructor(o) {
    this.o = o;
    this.items = [];
    this.waiting = []; // asked for a slot, no answer yet (oldest first)
  }

  add(fileList) {
    for (const file of [...fileList]) {
      if (this.items.length >= MAX_ITEMS) {
        this.o.toast(`Up to ${MAX_ITEMS} attachments per message.`);
        break;
      }
      if (file.size > MAX_BYTES) {
        this.o.toast(`${file.name} is too big (${formatSize(file.size)}). Files can be up to 25 MB.`);
        continue;
      }
      if (file.size === 0) {
        this.o.toast(`${file.name} is empty.`);
        continue;
      }
      const name = file.name || `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${(file.type.split("/")[1] || "bin").replace("jpeg", "jpg")}`;
      const item = { id: crypto.randomUUID(), file, name, size: file.size, mime: file.type, status: "uploading", url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, uploadId: null };
      this.items.push(item);
      if (this.o.link.send("upload.begin", { ref: item.id, name, size: file.size, mime: file.type || "application/octet-stream" })) this.waiting.push(item);
      else this.fail(item, "Not connected to the PC.");
    }
    this.render();
  }

  /** Frames from the helper that belong to uploads. */
  onFrame(env) {
    if (env.type === "upload.ready") {
      const item = this.items.find((i) => i.id === env.payload.ref);
      this.waiting = this.waiting.filter((i) => i !== item);
      if (item) this.upload(item, env.payload);
    } else if (env.type === "error" && env.payload?.code === "upload_refused") {
      const item = this.waiting.shift();
      if (item) this.fail(item, env.payload.message);
    }
  }

  async upload(item, slot) {
    try {
      const res = await fetch(`/upload/${encodeURIComponent(slot.uploadId)}`, {
        method: "POST",
        headers: { "x-ca-upload": slot.token, "content-type": "application/octet-stream" },
        body: item.file,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The PC answered ${res.status}.`);
      item.status = "ready";
      item.uploadId = slot.uploadId;
    } catch (e) {
      this.fail(item, e.message);
      return;
    }
    this.render();
  }

  fail(item, message) {
    item.status = "failed";
    item.error = message;
    this.o.toast(`${item.name}: ${message}`);
    this.render();
  }

  remove(id) {
    const item = this.items.find((i) => i.id === id);
    if (item?.url) URL.revokeObjectURL(item.url);
    this.items = this.items.filter((i) => i.id !== id);
    this.waiting = this.waiting.filter((i) => i.id !== id);
    this.render();
  }

  get busy() {
    return this.items.some((i) => i.status === "uploading");
  }

  get count() {
    return this.items.filter((i) => i.status === "ready").length;
  }

  /** The uploaded ones for a message (ids for the helper, previews for the conversation). Clears the tray. */
  take() {
    const ready = this.items.filter((i) => i.status === "ready");
    const out = {
      ids: ready.map((i) => i.uploadId),
      previews: ready.map((i) => ({ name: i.name, kind: i.mime.startsWith("image/") ? "image" : "file", size: i.size, url: i.url })),
    };
    for (const i of this.items) if (i.status !== "ready" && i.url) URL.revokeObjectURL(i.url);
    this.items = [];
    this.waiting = [];
    this.render();
    return out;
  }

  render() {
    const tray = clear(this.o.tray);
    tray.hidden = this.items.length === 0;
    for (const i of this.items) {
      const x = h("button", { type: "button", title: "Remove", "aria-label": `Remove ${i.name}` }, "✕");
      x.addEventListener("click", () => this.remove(i.id));
      const meta = i.status === "uploading" ? "Uploading…" : i.status === "failed" ? "Failed" : formatSize(i.size);
      tray.append(
        h(
          "span",
          { class: `chip-att${i.status === "failed" ? " failed" : ""}`, title: i.error ?? i.name },
          i.url ? h("img", { src: i.url, alt: "" }) : h("span", { class: "a-icon", "aria-hidden": "true" }, "📄"),
          h("span", { style: "min-width:0" }, h("div", { class: "a-name" }, i.name), h("div", { class: "a-meta" }, meta)),
          x,
        ),
      );
    }
    this.o.onChange();
  }
}
