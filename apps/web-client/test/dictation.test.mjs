import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTranscript, micError } from "../js/dictation.js";

test("heard words go after what was already typed, with one space between", () => {
  assert.equal(mergeTranscript("", [{ transcript: "check the tender register" }]), "check the tender register");
  assert.equal(mergeTranscript("Please", [{ transcript: "check the register" }]), "Please check the register");
  assert.equal(mergeTranscript("Please ", [{ transcript: "check" }]), "Please check");
  assert.equal(mergeTranscript("Line one\n", [{ transcript: "line two" }]), "Line one\nline two");
});

test("results from a long dictation are joined as the browser gives them", () => {
  const heard = [{ transcript: "check the register" }, { transcript: " for duplicates" }];
  assert.equal(mergeTranscript("", heard), "check the register for duplicates");
});

test("nothing heard leaves the box alone; odd input is ignored", () => {
  assert.equal(mergeTranscript("keep this", []), "keep this");
  assert.equal(mergeTranscript("keep this", [{ transcript: "  " }]), "keep this");
  assert.equal(mergeTranscript(undefined, null), "");
});

test("errors are explained in plain words, and quiet ones aren't shown", () => {
  assert.match(micError("not-allowed"), /blocked/);
  assert.match(micError("audio-capture"), /No microphone/);
  assert.match(micError("network"), /internet/);
  assert.equal(micError("no-speech"), "");
  assert.equal(micError("aborted"), "");
});
