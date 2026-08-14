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
