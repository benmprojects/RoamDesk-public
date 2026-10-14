// Serves the newest phone app build to paired phones, so they can update themselves over the same link.
// The build is read from the Android project's output folder; its version comes from AGP's output-metadata.json.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { APP_ROOT } from "./paths.js";

const OUTPUTS = resolve(APP_ROOT, "..", "android", "app", "build", "outputs", "apk");
// The sideload flavour is the one that updates itself; the older unflavoured folder is a fallback for older builds.
const BUILD_DIRS = [join(OUTPUTS, "sideload", "debug"), join(OUTPUTS, "debug")];
// Only phones that authenticated over the websocket learn this; it changes every time the helper starts.
const ACCESS = randomBytes(24).toString("base64url");

export interface AppBuild {
  versionCode: number;
  versionName: string;
  size: number;
  file: string;
}

export function latestBuild(): AppBuild | null {
  let best: AppBuild | null = null;
  for (const dir of BUILD_DIRS) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, "output-metadata.json"), "utf8"));
      const el = meta.elements?.[0];
      if (!el?.outputFile) continue;
      const file = join(dir, el.outputFile);
      if (!existsSync(file)) continue;
      const b = { versionCode: Number(el.versionCode) || 0, versionName: String(el.versionName ?? ""), size: statSync(file).size, file };
      if (!best || b.versionCode > best.versionCode) best = b;
    } catch {
      /* folder not built */
    }
  }
  return best;
}

/** Payload for the app.update frame, or null when there's no build to offer. */
export function updateOffer() {
  const b = latestBuild();
  return b ? { versionCode: b.versionCode, versionName: b.versionName, size: b.size, access: ACCESS } : null;
}

/** GET /app/apk?a=<access> */
export function serveApk(presented: string, res: ServerResponse) {
  const b = latestBuild();
  const a = Buffer.from(presented ?? "");
  const want = Buffer.from(ACCESS);
  if (!b || a.length !== want.length || !timingSafeEqual(a, want)) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end('{"error":"not found"}');
  }
  res.writeHead(200, {
    "content-type": "application/vnd.android.package-archive",
    "content-length": b.size,
    "content-disposition": `attachment; filename="claude-anywhere-${b.versionCode}.apk"`,
    "cache-control": "no-store",
  });
  createReadStream(b.file).on("error", () => res.destroy()).pipe(res);
}
