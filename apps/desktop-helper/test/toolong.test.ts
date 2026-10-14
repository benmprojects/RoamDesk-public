import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ca-toolong-"));
process.env.CA_CONFIG_DIR = join(tmp, "config");
process.env.CA_DATA_DIR = join(tmp, "data");

const { ClaudeSession } = await import("../src/session.js");

test("a request that's too long is offered for compact-and-retry once, not again after compacting", () => {
  const deps = { claudePath: "claude", hookUrl: "", hookToken: "", progressAfterS: 99, progressEveryS: 99, plainUpdates: true, chromeTools: false, instructions: () => "" };
  const s = new ClaudeSession({ id: "s1", name: "Test", cwd: tmp, model: "m", effort: "low", surface: "desktop", permissionMode: "default" } as any, deps);
  const events: any[] = [];
  s.on("event", (e: any) => events.push(e));
  // A stand-in for the Claude process: requests are written to it, replies are fed in by hand.
  const sent: any[] = [];
  (s as any).ensureProcess = () => ({ stdin: { write: (line: string) => sent.push(JSON.parse(line)) } });
  (s as any).syncWithDesktop = () => {};
  const tooLong = () => (s as any).onMessage({ type: "result", subtype: "success", is_error: true, result: "Prompt is too long" });

  s.send("Reference the Planning Regulation 2017", "browser");
  tooLong();
  const offers = () => events.filter((e) => e.kind === "too-long");
  assert.equal(offers().length, 1);
  assert.equal(offers()[0].text, "Reference the Planning Regulation 2017");
  assert.equal(offers()[0].origin, "browser");
  assert.ok(events.some((e) => e.kind === "turn.failed"), "the failure still shows");

  // The retry after compacting: a second "too long" is just a failure.
  s.send("Reference the Planning Regulation 2017", "browser", { afterCompact: true });
  tooLong();
  assert.equal(offers().length, 1);

  // Other failures are unaffected.
  s.send("hello", "phone");
  (s as any).onMessage({ type: "result", subtype: "error_during_execution", is_error: true, result: "Something else broke" });
  assert.equal(offers().length, 1);
  assert.ok(events.some((e) => e.kind === "speak" && /Something else broke/.test(e.text)));
  s.dispose();
});
