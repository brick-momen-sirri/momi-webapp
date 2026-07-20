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

test("prompt helper reads generated prompt from a RunPod text file artifact", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url) === "https://cdn.example/seedance_prompt.txt") {
      return new Response("SCENE CONTEXT\nA close portrait shot from the reference image.", {
        headers: {
          "content-type": "text/plain",
          "content-length": "56",
        },
      });
    }

    return jsonFetchResponse({
      id: "rp-text-file",
      status: "COMPLETED",
      output: {
        images: [{ filename: "preview.png", url: "https://cdn.example/preview.png" }],
        files: [{ filename: "seedance_prompt.txt", type: "s3_url", data: "https://cdn.example/seedance_prompt.txt" }],
      },
    });
  };

  const result = await service.describeImageWithRunpod({
    imageBase64: "AAA=",
    prompt: "Generate a Seedance prompt.",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.text, "SCENE CONTEXT\nA close portrait shot from the reference image.");
  assert.equal(result.textArtifacts[0]?.filename, "seedance_prompt.txt");
});

function jsonFetch(body: unknown) {
  return async () => jsonFetchResponse(body);
}

function jsonFetchResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
