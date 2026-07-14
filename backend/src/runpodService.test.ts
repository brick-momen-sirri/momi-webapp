import assert from "node:assert/strict";
import test from "node:test";

process.env.PROMPT_RUNPOD_ENDPOINT_ID = "prompt-endpoint-test";
process.env.RUNPOD_API_KEY = "runpod-key-test";

const service = await import("./runpodService.js");

test("prompt helper accepts output.text", async () => {
  const result = await service.describeImageWithRunpod({
    imageBase64: "AAA=",
    prompt: "Improve this prompt.",
    fetchImpl: jsonFetch({ id: "rp-text", status: "COMPLETED", output: { text: "Improved prompt.", model: "qwen3-vl" } }),
  });

  assert.equal(result.text, "Improved prompt.");
  assert.equal(result.model, "qwen3-vl");
  assert.equal(result.runpodJobId, "rp-text");
});

test("prompt helper accepts OpenAI-style choices output", async () => {
  const result = await service.describeImageWithRunpod({
    imageBase64: "AAA=",
    prompt: "Improve this prompt.",
    fetchImpl: jsonFetch({
      id: "rp-choice",
      status: "COMPLETED",
      output: {
        choices: [
          {
            message: {
              content: "Choice prompt.",
            },
          },
        ],
      },
    }),
  });

  assert.equal(result.text, "Choice prompt.");
});

function jsonFetch(body: unknown) {
  return async () => new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  }) as Promise<Response>;
}
