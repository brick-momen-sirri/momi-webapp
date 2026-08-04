import assert from "node:assert/strict";
import test from "node:test";

import { comfyHistoryErrorMessage, extractComfyResultUrls } from "./localComfyExecution.js";

test("extracts image, video, and gif outputs once in stable output order", () => {
  const repeated = { filename: "same.png", subfolder: "out", type: "output" };
  const history = {
    prompt_1: {
      outputs: {
        node_2: { images: [repeated], videos: [{ filename: "clip.mp4", type: "output" }] },
        node_1: { images: [repeated], gifs: [{ filename: "loop.gif", type: "output" }] },
      },
    },
  };

  assert.deepEqual(extractComfyResultUrls("http://comfy", history, "prompt_1"), [
    "http://comfy/view?filename=same.png&subfolder=out&type=output",
    "http://comfy/view?filename=clip.mp4&type=output",
    "http://comfy/view?filename=loop.gif&type=output",
  ]);
});

test("rejects a completed history record that has no output media", () => {
  assert.throws(
    () => extractComfyResultUrls("http://comfy", { prompt_1: { outputs: { node_1: { text: ["done"] } } } }, "prompt_1"),
    /without returning any output media/i,
  );
});

test("surfaces the failing Comfy node type and exception message", () => {
  assert.equal(
    comfyHistoryErrorMessage({
      status: { messages: [["execution_error", { node_type: "KSampler", exception_message: " CUDA OOM " }]] },
    }),
    "KSampler: CUDA OOM",
  );
  assert.equal(comfyHistoryErrorMessage({ status: { messages: [] } }), undefined);
});
