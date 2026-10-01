import fs from "node:fs/promises";
import { BackendHttpError } from "./httpError.js";
import {
  seedance25PromptSkillPath,
  seedancePromptOpenAIModel,
  seedancePromptRouterMaxTokens,
  seedancePromptRouterModel,
  seedancePromptWorkflowPath,
} from "./config.js";
import { anthropicImageBlock, runClaudeWithComfyRouter, type AnthropicContentBlock } from "./comfyRouterClaudeService.js";
import { beginRunpodBillableOperation } from "./runpodActivityTracker.js";
import { runComfyWorkflowOnRunpod, type RunpodComfyImageInput } from "./runpodComfyService.js";
import { describeImageWithRunpod } from "./runpodService.js";
import type { SeedanceVersionId } from "./seedanceVersions.js";
import type { CreditUsageSummary } from "./types.js";
import type { ComfyGraph, ComfyNode } from "./comfyGraph.js";

export type SeedancePromptWorkflowResult = {
  text: string;
  runpodJobId?: string;
  runpodStatus?: string;
  provider?: "runpod-workflow" | "comfy-router";
  model?: string;
  routerResponseId?: string;
  routerUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  textArtifacts: Array<{
    text: string;
    filename?: string;
    type?: string;
    source: string;
    url?: string;
  }>;
  promptHelperRunpodJobId?: string;
  promptHelperRunpodStatus?: string;
  creditUsage?: CreditUsageSummary;
};

type RunSeedancePromptWorkflowInput = {
  prompt: string;
  imagesBase64: string[];
  seedanceVersion?: SeedanceVersionId;
  fetchImpl?: typeof fetch;
};

export async function runSeedancePromptWorkflow({
  prompt,
  imagesBase64,
  seedanceVersion = "2.0",
  fetchImpl = fetch,
}: RunSeedancePromptWorkflowInput): Promise<SeedancePromptWorkflowResult> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    throw new BackendHttpError("Write the initial Seedance idea first.", { statusCode: 400 });
  }

  const images = imagesBase64.map((image, index) => seedancePromptImageInput(image, index));
  if (seedanceVersion !== "2.0") {
    return runSeedance25Prompt({
      prompt: cleanPrompt,
      imagesBase64,
      fetchImpl,
    });
  }

  if (!images.length) {
    throw new BackendHttpError("Upload at least one reference image before generating a Seedance prompt.", { statusCode: 400 });
  }

  const sourceWorkflow = JSON.parse(await fs.readFile(seedancePromptWorkflowPath, "utf8"));
  const skillInstructions = seedanceSkillInstructions(sourceWorkflow);
  const workflow = prepareSeedancePromptWorkflow(sourceWorkflow, {
    prompt: cleanPrompt,
    imageNames: images.map((image) => image.name),
    model: seedancePromptOpenAIModel,
  });

  const endBillableOperation = beginRunpodBillableOperation();
  try {
    const result = await runComfyWorkflowOnRunpod({
      workflow,
      images,
      fetchImpl,
    });
    const text = result.generatedText?.trim();
    if (!text) {
      const fallback = await describeImageWithRunpod({
        imageBase64: imagesBase64[0],
        imagesBase64,
        prompt: cleanPrompt,
        systemPrompt: skillInstructions,
        maxTokens: 1200,
        temperature: 0.2,
        fetchImpl,
      });

      return {
        text: fallback.text,
        runpodJobId: result.jobId,
        runpodStatus: result.status,
        textArtifacts: fallback.textArtifacts,
        promptHelperRunpodJobId: fallback.runpodJobId,
        promptHelperRunpodStatus: fallback.runpodStatus,
        creditUsage: result.creditUsage,
      };
    }

    return {
      text,
      provider: "runpod-workflow",
      runpodJobId: result.jobId,
      runpodStatus: result.status,
      textArtifacts: result.textArtifacts,
      creditUsage: result.creditUsage,
    };
  } finally {
    endBillableOperation();
  }
}

async function runSeedance25Prompt({
  prompt,
  imagesBase64,
  fetchImpl,
}: {
  prompt: string;
  imagesBase64: string[];
  fetchImpl: typeof fetch;
}): Promise<SeedancePromptWorkflowResult> {
  const skillInstructions = await fs.readFile(seedance25PromptSkillPath, "utf8");
  const assetInventory = imagesBase64.length
    ? [
        `The complete reference inventory contains ${imagesBase64.length} image${imagesBase64.length === 1 ? "" : "s"}, labeled @Image1 through @Image${imagesBase64.length} in upload order.`,
        "Inspect each attached image, assign an explicit role to every image you use, and list every unassigned image under 【Unused Assets】.",
      ]
    : ["No reference assets were provided. Treat this as text-to-video only and do not invent asset references."];
  const content: AnthropicContentBlock[] = [
    {
      type: "text",
      text: ["Create one submission-ready Seedance 2.5 prompt by following the system skill exactly.", ...assetInventory].join(
        "\n",
      ),
    },
  ];

  imagesBase64.forEach((image, index) => {
    content.push({ type: "text", text: `Reference asset @Image${index + 1}:` });
    content.push(anthropicImageBlock(image, index));
  });
  content.push({ type: "text", text: `User request:\n${prompt}` });

  const result = await runClaudeWithComfyRouter({
    model: seedancePromptRouterModel,
    system: skillInstructions,
    content,
    maxTokens: seedancePromptRouterMaxTokens,
    fetchImpl,
  });

  return {
    text: result.text,
    provider: "comfy-router",
    model: result.model,
    routerResponseId: result.responseId,
    routerUsage: result.usage,
    textArtifacts: [
      {
        text: result.text,
        source: "comfy-router",
        type: "text/plain",
      },
    ],
  };
}

export function prepareSeedancePromptWorkflow(
  workflow: unknown,
  options: { prompt: string; imageNames: string[]; model?: string },
) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new BackendHttpError("Seedance prompt workflow JSON must be a ComfyUI API prompt object.", { statusCode: 500 });
  }

  const prompt = cloneJson(workflow as ComfyGraph);
  const chatEntry = Object.entries(prompt).find(([, node]) => nodeClassType(node) === "openaichatnode");
  if (!chatEntry) {
    throw new BackendHttpError("Seedance prompt workflow is missing an OpenAIChatNode.", { statusCode: 500 });
  }

  const [chatNodeId, chatNode] = chatEntry;
  chatNode.inputs ??= {};
  chatNode.inputs.prompt = options.prompt;
  if (options.model?.trim()) {
    chatNode.inputs.model = options.model.trim();
  }

  const batchEntry = Object.entries(prompt).find(([, node]) => nodeClassType(node) === "batchimagesnode");
  const batchNodeId = batchEntry?.[0] ?? nextPromptNodeId(prompt);
  const batchNode = batchEntry?.[1] ?? {
    inputs: {},
    class_type: "BatchImagesNode",
    _meta: { title: "Batch Reference Images" },
  };
  batchNode.inputs = {};
  prompt[batchNodeId] = batchNode;
  chatNode.inputs.images = [batchNodeId, 0];

  const baseLoadImageEntry = Object.entries(prompt).find(([, node]) => nodeClassType(node) === "loadimage");
  const baseLoadImageNode = baseLoadImageEntry?.[1] ?? {
    inputs: { image: "" },
    class_type: "LoadImage",
    _meta: { title: "Load Reference Image" },
  };

  for (const [nodeId, node] of Object.entries(prompt)) {
    if (nodeClassType(node) === "loadimage") {
      delete prompt[nodeId];
    }
  }

  const imageNodeIds: string[] = [];
  options.imageNames.forEach((imageName, index) => {
    // Reuse the freed id of the workflow's original LoadImage for the first
    // image; allocate unused ids for the rest so existing nodes are never
    // overwritten.
    const nodeId = index === 0 && baseLoadImageEntry ? baseLoadImageEntry[0] : nextPromptNodeId(prompt);
    const node = cloneJson(baseLoadImageNode);
    node.inputs ??= {};
    node.inputs.image = imageName;
    node._meta = {
      ...(node._meta ?? {}),
      title: `Load Reference Image ${index + 1}`,
    };
    prompt[nodeId] = node;
    imageNodeIds.push(nodeId);
    batchNode.inputs[`images.image${index}`] = [nodeId, 0];
  });

  const saveEntry = Object.entries(prompt).find(([, node]) => isSeedancePromptSaveNode(node));
  if (saveEntry) {
    const saveNode = saveEntry[1];
    saveNode.inputs ??= {};
    if (nodeClassType(saveNode) === "save text file") {
      saveNode.inputs.text = [chatNodeId, 0];
    } else {
      if (imageNodeIds[0]) saveNode.inputs.images = [imageNodeIds[0], 0];
      saveNode.inputs.texts = [chatNodeId, 0];
    }
  }

  return prompt;
}

function nextPromptNodeId(prompt: ComfyGraph) {
  const maxId = Math.max(
    0,
    ...Object.keys(prompt)
      .map((key) => Number(key))
      .filter((value) => Number.isFinite(value)),
  );
  let next = maxId + 1;
  while (prompt[String(next)]) next += 1;
  return String(next);
}

function seedancePromptImageInput(value: string, index: number): RunpodComfyImageInput {
  const trimmed = value.trim();
  return {
    name: `seedance_prompt_ref_${index + 1}${imageExtensionFromDataUrl(trimmed)}`,
    image: trimmed.startsWith("data:") ? trimmed : `data:image/jpeg;base64,${trimmed}`,
  };
}

function imageExtensionFromDataUrl(value: string) {
  const match = value.match(/^data:image\/([a-zA-Z0-9+.-]+);/);
  const subtype = match?.[1]?.toLowerCase();
  if (!subtype) return ".jpg";
  if (subtype === "jpeg") return ".jpg";
  return `.${subtype.replace(/[^a-z0-9]/g, "") || "jpg"}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nodeClassType(node: ComfyNode) {
  return String(node?.class_type ?? "")
    .trim()
    .toLowerCase();
}

function isSeedancePromptSaveNode(node: ComfyNode) {
  const classType = nodeClassType(node);
  return classType === "save text file" || classType === "saveimagetextdatasettofolder";
}

function seedanceSkillInstructions(workflow: unknown) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new BackendHttpError("Seedance prompt workflow JSON must be a ComfyUI API prompt object.", { statusCode: 500 });
  }

  const configEntry = Object.values(workflow as ComfyGraph).find((node) => nodeClassType(node) === "openaichatconfig");
  const instructions = typeof configEntry?.inputs?.instructions === "string" ? configEntry.inputs.instructions.trim() : "";
  if (!instructions) {
    throw new BackendHttpError("Seedance prompt workflow is missing its prompt-writing instructions.", { statusCode: 500 });
  }
  return instructions;
}
