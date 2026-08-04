import test from "node:test";
import assert from "node:assert/strict";

import { improveTextPromptLocally } from "./promptFallback.js";

// Used when no prompt-helper endpoint is configured, so this is what an artist
// actually gets from "improve prompt" on a host with no PROMPT_RUNPOD_ENDPOINT_ID.
// It has to return something usable for any input, including input that is
// already a full templated instruction block.

const SUFFIX = /with clear subject preservation/;

test("a bare prompt is returned with the improvement suffix appended", () => {
  const result = improveTextPromptLocally("a glass tower at dusk");
  assert.match(result, /^a glass tower at dusk, /);
  assert.match(result, SUFFIX);
});

test("the current prompt is extracted out of a templated instruction block", () => {
  const templated = [
    "You are a prompt engineer.",
    "Current prompt: a glass tower at dusk",
    "Return only the improved prompt.",
  ].join("\n");

  const result = improveTextPromptLocally(templated);
  assert.match(result, /^a glass tower at dusk, /);
  // The surrounding instructions must not leak into what the artist sees.
  assert.ok(!result.includes("You are a prompt engineer"));
  assert.ok(!result.includes("Return only"));
});

test("the marker is matched case-insensitively", () => {
  const result = improveTextPromptLocally("CURRENT PROMPT: a timber cabin\nReturn only the improved prompt.");
  assert.match(result, /^a timber cabin, /);
});

test("surrounding quotes and collapsed whitespace are cleaned up", () => {
  const result = improveTextPromptLocally('Current prompt: "a   glass    tower"\nReturn only the improved prompt.');
  assert.match(result, /^a glass tower, /);
  assert.ok(!result.startsWith('"'));
});

test("trailing punctuation is dropped before the suffix is joined on", () => {
  // Otherwise the result reads "...at dusk., with clear subject preservation".
  assert.match(improveTextPromptLocally("a glass tower at dusk."), /^a glass tower at dusk, with/);
  assert.match(improveTextPromptLocally("a glass tower at dusk..."), /^a glass tower at dusk, with/);
  // Including the full-width stop, which arrives from pasted CJK text.
  assert.match(improveTextPromptLocally("a glass tower at dusk。"), /^a glass tower at dusk, with/);
});

test("an empty or whitespace-only prompt is returned as-is rather than decorated", () => {
  // Appending the suffix to nothing would produce a prompt that describes no
  // subject at all, which is worse than returning the empty input.
  assert.equal(improveTextPromptLocally(""), "");
  assert.equal(improveTextPromptLocally("   \n  "), "");
  assert.doesNotMatch(improveTextPromptLocally(""), SUFFIX);
});

test("a prompt already carrying the suffix is not mangled", () => {
  const once = improveTextPromptLocally("a glass tower");
  const twice = improveTextPromptLocally(once);
  // Idempotence is not claimed, but the result must stay a single sentence with
  // no stray punctuation from being processed twice.
  assert.ok(!twice.includes(",,"));
  assert.ok(!twice.includes(". ,"));
});

test("a multi-line prompt with no marker is still usable", () => {
  const result = improveTextPromptLocally("a glass tower\nat dusk\nwith fog");
  assert.match(result, SUFFIX);
  // Newlines collapse to spaces, so the result is one line the model can take.
  assert.ok(!result.includes("\n"));
});
