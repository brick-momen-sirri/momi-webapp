import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
process.env.RUNPOD_POLL_INTERVAL_MS = "1";
process.env.RUNPOD_TIMEOUT_MS = "1000";
process.env.SEEDANCE_PROMPT_OPENAI_MODEL = "gpt-test";
process.env.PROMPT_RUNPOD_ENDPOINT_ID = "prompt-endpoint-test";

const service = await import("./seedancePromptWorkflowService.js");

test("patches the Seedance workflow with the user prompt and reference images", () => {
  const sourceWorkflow = {
    "3": {
      inputs: {
        prompt: "",
        model: "old-model",
        images: ["9", 0],
      },
      class_type: "OpenAIChatNode",
    },
    "6": {
      inputs: {
        text: ["old", 0],
      },
      class_type: "Save Text File",
    },
    "7": {
      inputs: {
        image: "old.png",
      },
      class_type: "LoadImage",
    },
    "9": {
      inputs: {
        "images.image0": ["7", 0],
      },
      class_type: "BatchImagesNode",
    },
  };

  const workflow = service.prepareSeedancePromptWorkflow(sourceWorkflow, {
    prompt: "two shots, start from the reference then push into her face",
    imageNames: ["seedance_prompt_ref_1.jpg", "seedance_prompt_ref_2.png"],
    model: "gpt-test",
  });

  assert.equal(workflow["3"].inputs.prompt, "two shots, start from the reference then push into her face");
  assert.equal(workflow["3"].inputs.model, "gpt-test");
  assert.deepEqual(workflow["3"].inputs.images, ["9", 0]);
  assert.equal(workflow["7"].inputs.image, "seedance_prompt_ref_1.jpg");
  const secondImageNodeId = workflow["9"].inputs["images.image1"][0];
  assert.equal(workflow[secondImageNodeId].inputs.image, "seedance_prompt_ref_2.png");
  assert.deepEqual(workflow["9"].inputs, {
    "images.image0": ["7", 0],
    "images.image1": [secondImageNodeId, 0],
  });
  assert.deepEqual(workflow["6"].inputs.text, ["3", 0]);
  assert.equal(sourceWorkflow["7"].inputs.image, "old.png");
});

test("never overwrites existing nodes when allocating batch and reference image ids", () => {
  const sourceWorkflow = {
    "3": {
      inputs: { prompt: "" },
      class_type: "OpenAIChatNode",
    },
    "7": {
      inputs: { image: "old.png" },
      class_type: "LoadImage",
    },
    "10": {
      inputs: { note: "keep me" },
      class_type: "PreviewAny",
    },
    "11": {
      inputs: { text: "also keep me" },
      class_type: "PreviewAny",
    },
  };

  const workflow = service.prepareSeedancePromptWorkflow(sourceWorkflow, {
    prompt: "two shots",
    imageNames: ["ref_1.jpg", "ref_2.png"],
  });

  assert.equal(workflow["10"].inputs.note, "keep me");
  assert.equal(workflow["11"].inputs.text, "also keep me");

  const batchNodeId = workflow["3"].inputs.images[0];
  const imageNodeIds = [0, 1].map((index) => workflow[batchNodeId].inputs[`images.image${index}`][0]);
  assert.equal(new Set([batchNodeId, ...imageNodeIds]).size, 3);
  assert.equal(workflow[imageNodeIds[0]].inputs.image, "ref_1.jpg");
  assert.equal(workflow[imageNodeIds[1]].inputs.image, "ref_2.png");
});

test("runs the Seedance prompt workflow and reads the returned text artifact", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });

    if (String(url) === "https://cdn.example/seedance_prompt.txt") {
      return new Response("SCENE CONTEXT\nA generated Seedance prompt from the text file.", {
        headers: { "content-type": "text/plain" },
      });
    }

    return jsonResponse({
      id: "seedance-prompt-job",
      status: "COMPLETED",
      output: {
        images: [{ filename: "reference_preview.png", url: "https://cdn.example/reference_preview.png" }],
        files: [{ filename: "seedance_prompt.txt", type: "s3_url", data: "https://cdn.example/seedance_prompt.txt" }],
      },
    });
  };

  const result = await service.runSeedancePromptWorkflow({
    prompt: "simple idea",
    imagesBase64: ["data:image/png;base64,AAA="],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.text, "SCENE CONTEXT\nA generated Seedance prompt from the text file.");
  assert.equal(result.runpodJobId, "seedance-prompt-job");
  assert.equal(result.textArtifacts[0]?.filename, "seedance_prompt.txt");

  const payload = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(payload.input.workflow["3"].inputs.prompt, "simple idea");
  assert.equal(payload.input.workflow["3"].inputs.model, "gpt-test");
  assert.deepEqual(payload.input.workflow["6"].inputs.texts, ["3", 0]);
  assert.deepEqual(payload.input.workflow["8"].inputs.images, ["7", 0]);
  assert.equal(payload.input.images[0].name, "seedance_prompt_ref_1.png");
  assert.equal(payload.input.images[0].image, "data:image/png;base64,AAA=");
});

test("uses the pinned Seedance 2.5 skill with Claude Opus 5.5 through Comfy Router", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      id: "msg_seedance_25",
      model: "claude-opus-5-5",
      role: "assistant",
      type: "message",
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "【Generation Goal】\nGenerate a continuous architectural reveal using @Image1 and @Image2.",
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 42 },
    });
  };

  const result = await service.runSeedancePromptWorkflow({
    prompt: "Reveal the entrance, then orbit toward the garden.",
    imagesBase64: ["data:image/png;base64,AAA=", "data:image/jpeg;base64,BBB="],
    seedanceVersion: "2.5",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.comfy.org/v2/models/anthropic/claude-opus-5-5");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("X-API-Key"), "comfy-key-test");
  assert.ok(headers.get("Idempotency-Key"));

  const payload = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(payload.max_tokens, 4096);
  assert.match(payload.system[0].text, /Seedance 2\.5 Prompt Optimizer/);
  assert.doesNotMatch(payload.system[0].text, /Self-update before triggering/);
  assert.deepEqual(payload.system[0].cache_control, { type: "ephemeral" });
  assert.equal(payload.messages[0].role, "user");
  assert.match(payload.messages[0].content[0].text, /complete reference inventory contains 2 images/i);
  assert.equal(payload.messages[0].content[2].source.media_type, "image/png");
  assert.equal(payload.messages[0].content[2].source.data, "AAA=");
  assert.equal(payload.messages[0].content[4].source.media_type, "image/jpeg");
  assert.equal(payload.messages[0].content[4].source.data, "BBB=");
  assert.match(payload.messages[0].content[5].text, /Reveal the entrance/);

  assert.match(result.text, /architectural reveal/);
  assert.equal(result.provider, "comfy-router");
  assert.equal(result.model, "claude-opus-5-5");
  assert.equal(result.routerResponseId, "msg_seedance_25");
  assert.equal(result.routerUsage?.output_tokens, 42);
  assert.equal(result.textArtifacts[0]?.source, "comfy-router");
});

test("supports text-only Seedance 2.5 prompting without inventing asset references", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return jsonResponse({
      id: "msg_seedance_text_only",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "A pavilion emerges through morning mist." }],
    });
  };

  const result = await service.runSeedancePromptWorkflow({
    prompt: "A pavilion emerges through morning mist.",
    imagesBase64: [],
    seedanceVersion: "2.5",
    fetchImpl: fetchImpl as typeof fetch,
  });

  const messages = requestBody?.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  assert.match(messages[0]?.content[0]?.text ?? "", /text-to-video only/i);
  assert.equal(
    messages[0]?.content.some((block) => block.type === "image"),
    false,
  );
  assert.equal(result.text, "A pavilion emerges through morning mist.");
});

test("falls back to the prompt helper when the Seedance workflow returns no text artifact", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });

    if (String(url) === "https://api.runpod.ai/v2/endpoint-test/runsync") {
      return jsonResponse({
        id: "seedance-comfy-job",
        status: "COMPLETED",
        output: { success: true },
      });
    }

    if (String(url) === "https://api.runpod.ai/v2/prompt-endpoint-test/runsync") {
      return jsonResponse({
        id: "seedance-helper-job",
        status: "COMPLETED",
        output: {
          text: "SCENE CONTEXT\nThe tennis player swings, then smiles toward camera-right while the crowd crosses the background.",
        },
      });
    }

    return jsonResponse({ error: `Unexpected URL ${String(url)}` }, 500);
  };

  const result = await service.runSeedancePromptWorkflow({
    prompt: "The tennis player swings, hits the ball, smiles, and waits for the response.",
    imagesBase64: ["data:image/jpeg;base64,BBB="],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.match(result.text, /^SCENE CONTEXT/);
  assert.equal(result.runpodJobId, "seedance-comfy-job");
  assert.equal(result.promptHelperRunpodJobId, "seedance-helper-job");

  const fallbackPayload = JSON.parse(String(calls[1]?.init?.body));
  assert.equal(fallbackPayload.input.images_base64[0], "BBB=");
  assert.match(fallbackPayload.input.prompt, /tennis player swings/);
  assert.match(fallbackPayload.input.system_prompt, /Seedance 2\.0 Prompt Writer/);
  assert.match(fallbackPayload.input.system_prompt, /single standalone prompt in a code block/);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
