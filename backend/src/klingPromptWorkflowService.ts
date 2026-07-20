import fs from "node:fs/promises";
import { klingPromptOpenAIModel, klingPromptSkillPath, klingPromptWorkflowPath } from "./config.js";
import { beginRunpodBillableOperation } from "./runpodActivityTracker.js";
import { runComfyWorkflowOnRunpod, type RunpodComfyImageInput } from "./runpodComfyService.js";
import { describeImageWithRunpod } from "./runpodService.js";
import type { CreditUsageSummary } from "./types.js";

export type KlingPromptWorkflowResult = {
  text: string;
  runpodJobId?: string;
  runpodStatus: string;
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

type RunKlingPromptWorkflowInput = {
  prompt: string;
  imagesBase64: string[];
  cameraPrompt?: string;
  fetchImpl?: typeof fetch;
};

let cachedKlingSkillInstructions: string | undefined;

export async function runKlingPromptWorkflow({
  prompt,
  imagesBase64,
  cameraPrompt,
  fetchImpl = fetch,
}: RunKlingPromptWorkflowInput): Promise<KlingPromptWorkflowResult> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    throw new Error("Write the initial Kling image-to-video idea first.");
  }

  const images = imagesBase64.map((image, index) => klingPromptImageInput(image, index));
  if (!images.length) {
    throw new Error("Upload at least one reference image before generating a Kling prompt.");
  }

  const skillInstructions = await loadKlingSkillInstructions();
  const workflow = prepareKlingPromptWorkflow(
    JSON.parse(await fs.readFile(klingPromptWorkflowPath, "utf8")),
    {
      prompt: cleanPrompt,
      cameraPrompt,
      imageNames: images.map((image) => image.name),
      model: klingPromptOpenAIModel,
      skillInstructions,
    },
  );

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
        prompt: buildKlingChatPrompt(cleanPrompt, cameraPrompt),
        systemPrompt: skillInstructions,
        maxTokens: 1024,
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
      runpodJobId: result.jobId,
      runpodStatus: result.status,
      textArtifacts: result.textArtifacts,
      creditUsage: result.creditUsage,
    };
  } finally {
    endBillableOperation();
  }
}

export function prepareKlingPromptWorkflow(
  workflow: unknown,
  options: { prompt: string; imageNames: string[]; cameraPrompt?: string; model?: string; skillInstructions: string },
) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("Kling prompt workflow JSON must be a ComfyUI API prompt object.");
  }

  const prompt = cloneJson(workflow as Record<string, any>);
  const chatEntry = Object.entries(prompt).find(([, node]) => nodeClassType(node) === "openaichatnode");
  if (!chatEntry) {
    throw new Error("Kling prompt workflow is missing an OpenAIChatNode.");
  }

  const [chatNodeId, chatNode] = chatEntry;
  chatNode.inputs ??= {};
  chatNode.inputs.prompt = buildKlingChatPrompt(options.prompt, options.cameraPrompt);
  if (options.model?.trim()) {
    chatNode.inputs.model = options.model.trim();
  }

  const configEntry = Object.entries(prompt).find(([, node]) => nodeClassType(node) === "openaichatconfig");
  const configNodeId = configEntry?.[0] ?? nextPromptNodeId(prompt);
  const configNode = configEntry?.[1] ?? {
    inputs: {},
    class_type: "OpenAIChatConfig",
    _meta: { title: "OpenAI ChatGPT Advanced Options" },
  };
  configNode.inputs ??= {};
  configNode.inputs.truncation ??= "auto";
  configNode.inputs.max_output_tokens ??= 1024;
  configNode.inputs.instructions = options.skillInstructions.trim();
  configNode._meta = {
    ...(configNode._meta ?? {}),
    title: "OpenAI ChatGPT Advanced Options",
  };
  prompt[configNodeId] = configNode;
  chatNode.inputs.advanced_options = [configNodeId, 0];

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

  const saveEntry = Object.entries(prompt).find(([, node]) => isKlingPromptSaveNode(node));
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

function nextPromptNodeId(prompt: Record<string, any>) {
  const maxId = Math.max(0, ...Object.keys(prompt).map((key) => Number(key)).filter((value) => Number.isFinite(value)));
  let next = maxId + 1;
  while (prompt[String(next)]) next += 1;
  return String(next);
}

function buildKlingChatPrompt(prompt: string, cameraPrompt?: string) {
  return [
    "User prompt from the prompt area:",
    prompt.trim(),
    cameraPrompt?.trim()
      ? `Camera helper is enabled. Blend this camera instruction naturally: ${cameraPrompt.trim()}`
      : "Camera helper is disabled. Do not add a separate camera move unless the user prompt itself asks for one.",
    "Use the uploaded reference image as the source image for Kling image-to-video.",
    "Return only the final Kling prompt text.",
  ].join("\n\n");
}

async function loadKlingSkillInstructions() {
  if (cachedKlingSkillInstructions) return cachedKlingSkillInstructions;

  const raw = await fs.readFile(klingPromptSkillPath, "utf8");
  const instructions = stripSkillFrontmatter(raw).trim();
  if (!instructions) {
    throw new Error("Kling prompt skill file is empty.");
  }

  cachedKlingSkillInstructions = instructions;
  return instructions;
}

function stripSkillFrontmatter(value: string) {
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;

  const endIndex = normalized.indexOf("\n---", 4);
  return endIndex >= 0 ? normalized.slice(endIndex + 4) : normalized;
}

function klingPromptImageInput(value: string, index: number): RunpodComfyImageInput {
  const trimmed = value.trim();
  return {
    name: `kling_prompt_ref_${index + 1}${imageExtensionFromDataUrl(trimmed)}`,
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

function nodeClassType(node: any) {
  return String(node?.class_type ?? "").trim().toLowerCase();
}

function isKlingPromptSaveNode(node: any) {
  const classType = nodeClassType(node);
  return classType === "save text file" || classType === "saveimagetextdatasettofolder";
}
