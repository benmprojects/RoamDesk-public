import test from "node:test";
import assert from "node:assert/strict";
import { newRelinkState, relinkDue } from "../src/relink.js";

const MIN = 60_000;

test("re-link waits for the connector to stay down, then tries once, then backs off", () => {
  const s = newRelinkState();
  assert.equal(relinkDue(s, true, 0), false); // just noticed
  assert.equal(relinkDue(s, true, 1 * MIN), false); // a blip may fix itself
  assert.equal(relinkDue(s, true, 2 * MIN), true);
  s.attempts.push(2 * MIN);
  assert.equal(relinkDue(s, true, 10 * MIN), false); // too soon after an attempt
  assert.equal(relinkDue(s, true, 33 * MIN), true);
});

test("a connector that comes back resets the wait; never while one is running; at most 3 a day", () => {
  const s = newRelinkState();
  relinkDue(s, true, 0);
  assert.equal(relinkDue(s, false, 1 * MIN), false);
  assert.equal(s.downSince, null);
  assert.equal(relinkDue(s, true, 10 * MIN), false); // the clock starts again
  s.running = true;
  assert.equal(relinkDue(s, true, 20 * MIN), false);
  s.running = false;
  s.attempts = [0, 40 * MIN, 80 * MIN];
  assert.equal(relinkDue(s, true, 200 * MIN), false); // three already today
});
