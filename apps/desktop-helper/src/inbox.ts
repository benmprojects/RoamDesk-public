// The inbox: things the PC wants you to see later (a connector dropped, a routine finished, the helper updated).
// The last 50 are kept on disk and sent to every browser on connect and on each change.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxItem } from "@claude-anywhere/protocol";
import { broadcast } from "./hub.js";
import { DATA_DIR } from "./paths.js";

const FILE = join(DATA_DIR, "inbox.json");
const MAX = 50;

let items: InboxItem[] = [];
try {
  if (existsSync(FILE)) items = (JSON.parse(readFileSync(FILE, "utf8")) as InboxItem[]).slice(0, MAX);
} catch {
  items = [];
}

function save() {
  try {
    writeFileSync(FILE, JSON.stringify(items));
  } catch {
    /* an unwritable inbox must not stop the helper */
  }
}

export function inboxView(): { items: InboxItem[]; unread: number } {
  return { items, unread: items.filter((i) => !i.read).length };
}

/** Add an item (newest first) and tell every device. */
export function notifyInbox(kind: InboxItem["kind"], title: string, text: string) {
  items.unshift({ id: `i_${randomBytes(5).toString("base64url")}`, ts: Date.now(), kind, title: title.slice(0, 120), text: text.slice(0, 2000), read: false });
  items = items.slice(0, MAX);
  save();
  broadcast("inbox", inboxView());
}

export function markInboxRead() {
  for (const i of items) i.read = true;
  save();
  broadcast("inbox", inboxView());
}

export function clearInbox() {
  items = [];
  save();
  broadcast("inbox", inboxView());
}
