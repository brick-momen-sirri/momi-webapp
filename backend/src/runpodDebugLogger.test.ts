import assert from "node:assert/strict";
import test from "node:test";

const logger = await import("./runpodDebugLogger.js");

test("RunPod URL info includes endpoint id and operation", () => {
  assert.deepEqual(logger.runpodUrlInfo("https://api.runpod.ai/v2/endpoint-test/status/job-123"), {
    endpointId: "endpoint-test",
    operation: "/status",
    operationPath: "/status/job-123",
    jobId: "job-123",
  });
});

test("sanitized request body redacts secrets and omits inline media", () => {
  const sanitized = logger.sanitizeRunpodRequestBody(JSON.stringify({
    input: {
      workflow: {
        "3": {
          class_type: "OpenAIChatNode",
          _meta: { title: "OpenAI ChatGPT" },
          inputs: { prompt: "hello" },
        },
      },
      images: [
        {
          name: "reference.png",
          image: `data:image/png;base64,${"A".repeat(1200)}`,
          url: "https://backend.example/api/runpod-input?token=secret-token",
        },
      ],
      comfy_org_api_key: "secret-key",
    },
  })) as Record<string, any>;

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("A".repeat(200)), false);
  assert.deepEqual(sanitized.input_keys, ["workflow", "images", "comfy_org_api_key"]);
  assert.equal(sanitized.input.workflow.type, "comfy_api_prompt");
  assert.equal(sanitized.input.workflow.node_count, 1);
  assert.equal(sanitized.input.images.length, 1);
  assert.equal(sanitized.input.images.items[0].has_inline_data, true);
  assert.equal(sanitized.input.images.items[0].url, "https://backend.example/api/runpod-input?[redacted-query]");
});

test("debug logging prints sanitized body only when RUNPOD_DEBUG is true", () => {
  const originalDebug = process.env.RUNPOD_DEBUG;
  const logs: string[] = [];
  const originalInfo = console.info;
  try {
    console.info = (message?: unknown) => {
      logs.push(String(message));
    };
    process.env.RUNPOD_DEBUG = "false";
    logger.logRunpodRequest("https://api.runpod.ai/v2/endpoint-test/runsync", {
      method: "POST",
      body: JSON.stringify({ input: { image_base64: "AAA=", api_key: "secret" } }),
    });
    assert.equal(logs.some((line) => line.includes("sanitized request body")), false);

    process.env.RUNPOD_DEBUG = "true";
    logger.logRunpodRequest("https://api.runpod.ai/v2/endpoint-test/runsync", {
      method: "POST",
      body: JSON.stringify({ input: { image_base64: "AAA=", api_key: "secret" } }),
    });
    assert.equal(logs.some((line) => line.includes("sanitized request body")), true);
    assert.equal(logs.join("\n").includes("secret"), false);
  } finally {
    console.info = originalInfo;
    process.env.RUNPOD_DEBUG = originalDebug;
  }
});
