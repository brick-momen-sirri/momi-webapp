import assert from "node:assert/strict";
import test from "node:test";

import { createStreamProgressReader } from "./runpodStreamProgress.js";

// RunPod's /stream is drain-on-read, but it can still re-deliver a chunk, and it
// is polled every couple of seconds for the life of a render. Getting the dedup
// or the node parsing wrong shows up as a status line that either flickers
// between steps or sticks on the first one forever.

test("reads chunks and pulls the node id out of each", () => {
  const reader = createStreamProgressReader();
  const chunks = reader.read({
    status: "IN_PROGRESS",
    stream: [{ output: "32 sampling tiles" }, { output: "64 decoding tiles" }],
  });

  assert.deepEqual(
    chunks.map((chunk) => chunk.nodeId),
    ["32", "64"],
  );
  assert.equal(chunks[0].text, "32 sampling tiles");
});

test("a chunk already seen is not reported twice", () => {
  const reader = createStreamProgressReader();
  const payload = { stream: [{ output: "32 sampling tiles" }] };

  assert.equal(reader.read(payload).length, 1);
  // The same poll response arriving again must produce nothing, or the status
  // line would restart on every tick.
  assert.equal(reader.read(payload).length, 0);
});

test("only the new chunks of a growing response are reported", () => {
  const reader = createStreamProgressReader();
  reader.read({ stream: [{ output: "32 sampling tiles" }] });
  const next = reader.read({ stream: [{ output: "32 sampling tiles" }, { output: "83 saving final image" }] });

  assert.deepEqual(
    next.map((chunk) => chunk.nodeId),
    ["83"],
  );
});

test("subgraph node ids survive intact", () => {
  const reader = createStreamProgressReader();
  const [chunk] = reader.read({ stream: ["80:29 running upscale sampler"] });
  assert.equal(chunk.nodeId, "80:29");
});

// The forms these workers really emit. The first port of this handled only the
// bare leading id, which matches none of the first four -- so a fully working
// stream would still have produced no labels at all.
test("every progress line shape the workers emit yields its node", () => {
  const cases: Array<[string, string]> = [
    ["Running node 32: KSampler", "32"],
    ["[comfy-log][exec] Running node 32: KSampler", "32"],
    ["[comfy-log][progress] node=22 5/20", "22"],
    ["node=52 done=3 total=8", "52"],
    ["node=80:12 item=1/3 step=5/20", "80:12"],
    ["Running node 80:29: SeedVR", "80:29"],
    ["32 sampling tiles", "32"],
  ];

  for (const [text, expected] of cases) {
    const [chunk] = createStreamProgressReader().read({ stream: [text] });
    assert.equal(chunk?.nodeId, expected, `failed to read a node id from ${JSON.stringify(text)}`);
  }
});

test("lines that name no node are still kept, just unattributed", () => {
  for (const text of ["[comfy-log][exec] Prompt executed", "Queue remaining: 0"]) {
    const [chunk] = createStreamProgressReader().read({ stream: [text] });
    assert.equal(chunk?.nodeId, undefined, `unexpectedly read a node id from ${JSON.stringify(text)}`);
    assert.equal(chunk?.text, text);
  }
});

test("text with no node prefix is still reported, just unattributed", () => {
  const reader = createStreamProgressReader();
  const [chunk] = reader.read({ stream: ["warming up"] });
  assert.equal(chunk.nodeId, undefined);
  assert.equal(chunk.text, "warming up");
});

test("payload shapes other than a stream array are tolerated", () => {
  // These payloads come from the worker, not from us, and a shape we did not
  // expect must not throw inside a poll.
  assert.deepEqual(createStreamProgressReader().read(undefined), []);
  assert.deepEqual(createStreamProgressReader().read({ status: "IN_PROGRESS" }), []);
  assert.deepEqual(createStreamProgressReader().read({ stream: [] }), []);

  // A single object rather than a list, and a top-level payload with no
  // `stream` key at all -- both seen in the wild.
  assert.equal(createStreamProgressReader().read({ stream: { output: "32 sampling" } })[0]?.nodeId, "32");
  assert.equal(createStreamProgressReader().read({ message: "83 saving" })[0]?.nodeId, "83");
  assert.equal(createStreamProgressReader().read([{ output: "12 base sampler" }])[0]?.nodeId, "12");
});

test("nested payloads are walked, but not indefinitely", () => {
  const reader = createStreamProgressReader();
  assert.equal(reader.read({ stream: [{ output: { message: ["22 sampling"] } }] })[0]?.nodeId, "22");

  // Past the depth limit nothing is reported rather than the walk continuing.
  const deep = { stream: [{ output: { output: { output: { output: { output: "32 too deep" } } } } }] };
  assert.deepEqual(createStreamProgressReader().read(deep), []);
});

test("the seen-set does not grow without bound", () => {
  // A long render emits thousands of chunks; remembering every one for the life
  // of the job would be a slow leak in the dispatcher.
  const reader = createStreamProgressReader();
  for (let index = 0; index < 700; index += 1) {
    reader.read({ stream: [`32 step ${index}`] });
  }
  // The earliest chunk has been forgotten, so it reads as new again. That is the
  // intended trade: a bounded set, at the cost of a repeat after 512 chunks.
  assert.equal(reader.read({ stream: ["32 step 0"] }).length, 1);
});

// The notes exist because every failure in this path is swallowed, so without
// them "the worker reports nothing" and "our request is broken" look the same
// from the outside.

test("a note is logged once, however many times it is raised", () => {
  const reader = createStreamProgressReader("test-endpoint");
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => void lines.push(String(message));
  try {
    reader.note("stream request returned HTTP 404");
    reader.note("stream request returned HTTP 404");
    reader.note("stream request failed: timeout");
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 2, "a repeated note must not log on every poll");
  assert.match(lines[0], /test-endpoint/);
  assert.match(lines[0], /HTTP 404/);
});

test("the first real chunk is reported, with its parsed node ids", () => {
  const reader = createStreamProgressReader("ge");
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => void lines.push(String(message));
  try {
    reader.read({ stream: ["32 sampling tiles"] });
    reader.read({ stream: ["64 decoding tiles"] });
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1, "only the first batch is worth a line");
  assert.match(lines[0], /emitting progress/);
  assert.match(lines[0], /"32"/);
});

test("an empty stream is reported when polling ends, however short the job", () => {
  // A poll-count threshold missed exactly the jobs that finish fastest, which is
  // how a 23-second run against a warm worker produced no diagnosis at all.
  const reader = createStreamProgressReader("ge");
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => void lines.push(String(message));
  try {
    reader.read({ status: "IN_PROGRESS", stream: [] });
    reader.read({ status: "IN_PROGRESS", stream: [] });
    reader.summarize();
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /does not stream/);
  assert.match(lines[0], /2 poll/);
});

test("a stream that produced chunks is not reported as silent", () => {
  const reader = createStreamProgressReader("ge");
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => void lines.push(String(message));
  try {
    reader.read({ stream: ["32 sampling tiles"] });
    reader.summarize();
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1, "the chunk line only; no contradicting silence claim");
  assert.match(lines[0], /emitting progress/);
});

test("summarize says nothing when the stream was never read", () => {
  // A job cancelled before its first poll has nothing to report either way.
  const reader = createStreamProgressReader("ge");
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => void lines.push(String(message));
  try {
    reader.summarize();
  } finally {
    console.log = original;
  }

  assert.deepEqual(lines, []);
});

// Every line shape captured from a live General Enhancement run, verbatim.
test("the real progress lines from a live run all parse", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["Still running... waiting for next ComfyUI update.", undefined, undefined],
    ["[comfy-log][ws] receive timeout, waiting for updates", undefined, undefined],
    ["[comfy-log][progress] node=32 4/30", "32", "4/30"],
    ["[comfy-log][enhance-step] node=32 item=6 step=11/30", "32", "11/30"],
    ["[comfy-log][enhance-state] node=32 done=8", "32", undefined],
    ["[comfy-log][node] 12 Image List To Image Batch (easy imageListToImageBatch)", "12", undefined],
    ["[comfy-log][node] 82 ✂️ Inpaint Stitch (InpaintStitchImproved)", "82", undefined],
    ["[comfy-log][enhance-state] node=83 done=0", "83", undefined],
    ["Running node 63: Load Image (Base64) (ETN_LoadImageBase64)", "63", undefined],
  ];

  for (const [text, expectedNode, expectedStep] of cases) {
    const [chunk] = createStreamProgressReader().read({ progress: text });
    assert.equal(chunk?.nodeId, expectedNode, `node id from ${JSON.stringify(text)}`);
    const step = chunk?.step ? `${chunk.step.done}/${chunk.step.total}` : undefined;
    assert.equal(step, expectedStep, `step from ${JSON.stringify(text)}`);
  }
});
