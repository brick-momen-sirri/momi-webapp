import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
process.env.PROMPT_RUNPOD_ENDPOINT_ID = "prompt-endpoint-test";
process.env.RUNPOD_POLL_INTERVAL_MS = "1";
process.env.RUNPOD_TIMEOUT_MS = "1000";
process.env.KLING_PROMPT_OPENAI_MODEL = "gpt-test";

const service = await import("./klingPromptWorkflowService.js");
const FULL_KLING_SKILL_FOR_TEST = [
  "# Kling 3.0 Image-to-Video Prompt Writer",
  "## Camera Reference",
  "## Common Patterns",
  "## Negative Prompt",
  "## Final Output Rules",
].join("\n");

test("patches the Kling workflow with prompt, camera helper, instructions, and reference images", () => {
  const sourceWorkflow = {
    "3": {
      inputs: {
        prompt: "",
        model: "old-model",
        images: ["9", 0],
        advanced_options: ["4", 0],
      },
      class_type: "OpenAIChatNode",
    },
    "4": {
      inputs: {
        instructions: "old instructions",
      },
      class_type: "OpenAIChatConfig",
    },
    "6": {
      inputs: {
        texts: ["old", 0],
      },
      class_type: "SaveImageTextDataSetToFolder",
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

  const workflow = service.prepareKlingPromptWorkflow(sourceWorkflow, {
    prompt: "make the person blink and breathe",
    cameraPrompt: "slow push-in",
    imageNames: ["kling_prompt_ref_1.jpg", "kling_prompt_ref_2.png"],
    model: "gpt-test",
    skillInstructions: FULL_KLING_SKILL_FOR_TEST,
  });

  assert.match(workflow["3"].inputs.prompt, /make the person blink and breathe/);
  assert.match(workflow["3"].inputs.prompt, /Camera helper is enabled/);
  assert.match(workflow["3"].inputs.prompt, /slow push-in/);
  assert.equal(workflow["3"].inputs.model, "gpt-test");
  assert.deepEqual(workflow["3"].inputs.images, ["9", 0]);
  assert.deepEqual(workflow["3"].inputs.advanced_options, ["4", 0]);
  assert.match(workflow["4"].inputs.instructions, /Kling 3\.0 Image-to-Video Prompt Writer/);
  assert.match(workflow["4"].inputs.instructions, /Camera Reference/);
  assert.match(workflow["4"].inputs.instructions, /Common Patterns/);
  assert.match(workflow["4"].inputs.instructions, /Negative Prompt/);
  assert.equal(workflow["7"].inputs.image, "kling_prompt_ref_1.jpg");
  const secondImageNodeId = workflow["9"].inputs["images.image1"][0];
  assert.equal(workflow[secondImageNodeId].inputs.image, "kling_prompt_ref_2.png");
  assert.deepEqual(workflow["9"].inputs, {
    "images.image0": ["7", 0],
    "images.image1": [secondImageNodeId, 0],
  });
  assert.deepEqual(workflow["6"].inputs.texts, ["3", 0]);
  assert.deepEqual(workflow["6"].inputs.images, ["7", 0]);
  assert.equal(sourceWorkflow["7"].inputs.image, "old.png");
});

test("never overwrites existing nodes when allocating config, batch, and reference image ids", () => {
  const sourceWorkflow = {
    "3": {
      inputs: { prompt: "" },
      class_type: "OpenAIChatNode",
    },
    "4": {
      inputs: { value: "keep me" },
      class_type: "PrimitiveString",
    },
    "7": {
      inputs: { image: "old.png" },
      class_type: "LoadImage",
    },
    "9": {
      inputs: { note: "unrelated" },
      class_type: "PreviewAny",
    },
    "11": {
      inputs: { text: "also keep me" },
      class_type: "PreviewAny",
    },
  };

  const workflow = service.prepareKlingPromptWorkflow(sourceWorkflow, {
    prompt: "make it move",
    imageNames: ["ref_1.jpg", "ref_2.png", "ref_3.png"],
    skillInstructions: FULL_KLING_SKILL_FOR_TEST,
  });

  assert.equal(workflow["4"].inputs.value, "keep me");
  assert.equal(workflow["9"].inputs.note, "unrelated");
  assert.equal(workflow["11"].inputs.text, "also keep me");

  const configNodeId = workflow["3"].inputs.advanced_options[0];
  assert.notEqual(configNodeId, "4");
  assert.match(workflow[configNodeId].inputs.instructions, /Kling 3\.0 Image-to-Video Prompt Writer/);

  const batchNodeId = workflow["3"].inputs.images[0];
  assert.notEqual(batchNodeId, "9");
  const imageNodeIds = [0, 1, 2].map((index) => workflow[batchNodeId].inputs[`images.image${index}`][0]);
  assert.equal(new Set(imageNodeIds).size, 3);
  assert.equal(workflow[imageNodeIds[0]].inputs.image, "ref_1.jpg");
  assert.equal(workflow[imageNodeIds[1]].inputs.image, "ref_2.png");
  assert.equal(workflow[imageNodeIds[2]].inputs.image, "ref_3.png");
});

test("runs the Kling prompt workflow and reads the returned text artifact", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });

    if (String(url) === "https://cdn.example/kling_prompt.txt") {
      return new Response("The subject blinks once while the camera slowly pushes in.", {
        headers: { "content-type": "text/plain" },
      });
    }

    return jsonResponse({
      id: "kling-prompt-job",
      status: "COMPLETED",
      output: {
        images: [{ filename: "reference_preview.png", url: "https://cdn.example/reference_preview.png" }],
        files: [{ filename: "kling_prompt.txt", type: "s3_url", data: "https://cdn.example/kling_prompt.txt" }],
      },
    });
  };

  const result = await service.runKlingPromptWorkflow({
    prompt: "simple image-to-video idea",
    cameraPrompt: "locked-off close-up",
    imagesBase64: ["data:image/png;base64,AAA="],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.text, "The subject blinks once while the camera slowly pushes in.");
  assert.equal(result.runpodJobId, "kling-prompt-job");
  assert.equal(result.textArtifacts[0]?.filename, "kling_prompt.txt");

  const payload = JSON.parse(String(calls[0]?.init?.body));
  assert.match(payload.input.workflow["3"].inputs.prompt, /simple image-to-video idea/);
  assert.match(payload.input.workflow["4"].inputs.instructions, /Kling 3\.0 Image-to-Video Prompt Writer/);
  assert.match(payload.input.workflow["4"].inputs.instructions, /Camera Reference/);
  assert.match(payload.input.workflow["4"].inputs.instructions, /Common Patterns/);
  assert.match(payload.input.workflow["4"].inputs.instructions, /Negative Prompt/);
  assert.equal(payload.input.workflow["3"].inputs.model, "gpt-test");
  assert.deepEqual(payload.input.workflow["6"].inputs.texts, ["3", 0]);
  assert.deepEqual(payload.input.workflow["8"].inputs.images, ["7", 0]);
  assert.equal(payload.input.images[0].name, "kling_prompt_ref_1.png");
  assert.equal(payload.input.images[0].image, "data:image/png;base64,AAA=");
});

test("falls back to the prompt helper when the Kling workflow returns no text artifact", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });

    if (String(url) === "https://api.runpod.ai/v2/endpoint-test/runsync") {
      return jsonResponse({
        id: "kling-comfy-job",
        status: "COMPLETED",
        output: {
          images: [{ filename: "kling_prompt_preview.png", url: "https://cdn.example/kling_prompt_preview.png" }],
        },
      });
    }

    if (String(url) === "https://api.runpod.ai/v2/prompt-endpoint-test/runsync") {
      return jsonResponse({
        id: "kling-helper-job",
        status: "COMPLETED",
        output: {
          text: "The subject in the source image breathes subtly and blinks once while the framing stays steady.",
        },
      });
    }

    return jsonResponse({ error: `Unexpected URL ${String(url)}` }, 500);
  };

  const result = await service.runKlingPromptWorkflow({
    prompt: "make this feel alive but subtle",
    imagesBase64: ["data:image/jpeg;base64,BBB="],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.text, "The subject in the source image breathes subtly and blinks once while the framing stays steady.");
  assert.equal(result.runpodJobId, "kling-comfy-job");
  assert.equal(result.promptHelperRunpodJobId, "kling-helper-job");
  assert.equal(result.textArtifacts[0]?.source, "text");

  const fallbackPayload = JSON.parse(String(calls[1]?.init?.body));
  assert.equal(fallbackPayload.input.images_base64[0], "BBB=");
  assert.match(fallbackPayload.input.prompt, /make this feel alive but subtle/);
  assert.match(fallbackPayload.input.prompt, /Camera helper is disabled/);
  assert.match(fallbackPayload.input.system_prompt, /Kling 3\.0 Image-to-Video Prompt Writer/);
  assert.match(fallbackPayload.input.system_prompt, /Camera Reference/);
  assert.match(fallbackPayload.input.system_prompt, /Common Patterns/);
  assert.match(fallbackPayload.input.system_prompt, /Negative Prompt/);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
