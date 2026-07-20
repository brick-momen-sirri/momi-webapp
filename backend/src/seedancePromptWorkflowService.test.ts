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
