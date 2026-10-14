import { test } from "node:test";
import assert from "node:assert/strict";
import { announcesRoutineSteps, stillWorkingText } from "../src/voice.js";

test("plain updates silences routine step announcements", () => {
  assert.equal(announcesRoutineSteps(true), false);
  assert.equal(announcesRoutineSteps(undefined), false); // the default is on
  assert.equal(announcesRoutineSteps(false), true);
});

test("'still working' only names the step with plain updates off", () => {
  assert.equal(stillWorkingText("Editing hub.ts", true), "Still working.");
  assert.equal(stillWorkingText("Editing hub.ts", false), "Still working: editing hub.ts.");
  assert.equal(stillWorkingText("", false), "Still working.");
});
