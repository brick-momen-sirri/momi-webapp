import fs from "node:fs/promises";
import path from "node:path";
import { serverlessWorkflowRoot, workflowMappingsPath, workflowRoots } from "./config.js";
import { getObjectInfo } from "./comfyClient.js";
import { estimateWorkflowCredits } from "./creditEstimator.js";
import { assertNoEmbeddedMedia, readJsonFile } from "./storageService.js";
import type { ArchVizGridOptions, CreateJobRequest, ModelCategory, WorkflowInputMapping, WorkflowModel, WorkflowRequiredInput } from "./types.js";

let modelsCache: WorkflowModel[] = [];
let mappingsCache: Record<string, WorkflowInputMapping> = {};

const gptImageSizeOptions = [
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840",
];

const nanoBananaAspectRatioOptions = new Set(["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
export async function loadWorkflowModels() {
  const files = (await Promise.all(workflowRoots.map((root) => listJsonFiles(root)))).flat();
  modelsCache = await Promise.all(files.map(inferWorkflowModel));
  mappingsCache = await readMappings();
  return modelsCache;
}

export function getWorkflowModels() {
  return modelsCache;
}

export function getWorkflowModel(id: string) {
  return modelsCache.find((model) => model.id === id);
}

export async function loadWorkflowPrompt(model: WorkflowModel, request: CreateJobRequest, projectName: string, serverUrl: string) {
  const workflow = JSON.parse(await fs.readFile(model.workflowPath, "utf8"));
  const objectInfo = await getObjectInfo(serverUrl).catch(() => ({}));
  const prompt = toApiPrompt(workflow, objectInfo);
  pruneUnavailableNodes(prompt, objectInfo);
  if (model.outputType === "video") {
    pruneSaveBrickSequenceNodes(prompt);
  }
  const mapping = mappingsCache[model.id] ?? {};
  injectInputs(prompt, model, request, projectName, mapping, objectInfo);
  applyTextOnlyImageWorkflowMode(prompt, model, request);
  applyImageOutputCountOptions(prompt, model, request);
  return prompt;
}

export async function loadWorkflowForRunpod(
  model: WorkflowModel,
  request: CreateJobRequest,
  projectName: string,
  imageNames: string[],
) {
  const workflow = JSON.parse(await fs.readFile(model.workflowPath, "utf8"));
  const requestWithImageNames = {
    ...request,
    inputImages: imageNames,
    startFrame: model.requiresStartEndFrames ? imageNames[0] : request.startFrame,
    endFrame: model.requiresStartEndFrames ? imageNames[1] : request.endFrame,
  };

  assertUiWorkflowWidgetsSupported(workflow, model.workflowPath);
  const prompt = toApiPrompt(workflow, {});
  const mapping = mappingsCache[model.id] ?? {};
  if (model.outputType === "video") {
    pruneSaveBrickSequenceNodes(prompt);
  }
  injectInputs(prompt, model, requestWithImageNames, projectName, mapping, {});
  applyTextOnlyImageWorkflowMode(prompt, model, requestWithImageNames);
  applyImageOutputCountOptions(prompt, model, requestWithImageNames);
  return prompt;
}

export async function detectWorkflowLoadImageNames(model: WorkflowModel) {
  const workflow = JSON.parse(await fs.readFile(model.workflowPath, "utf8"));
  const names = collectLoadImageNames(workflow);
  return names.length ? names : undefined;
}

export async function detectWorkflowLoadVideoNames(model: WorkflowModel) {
  const workflow = JSON.parse(await fs.readFile(model.workflowPath, "utf8"));
  const names = collectLoadVideoNames(workflow);
  return names.length ? names : undefined;
}

export async function saveWorkflowSnapshot(filePath: string, workflow: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  assertNoEmbeddedMedia(workflow, "workflow snapshot");
  await fs.writeFile(filePath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
}

async function listJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return listJsonFiles(full);
        }
        return entry.isFile() && entry.name.toLowerCase().endsWith(".json") ? [full] : [];
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

async function inferWorkflowModel(workflowPath: string): Promise<WorkflowModel> {
  const file = path.basename(workflowPath, ".json");
  const lower = workflowPath.toLowerCase();
  const jsonText = await fs.readFile(workflowPath, "utf8").catch(() => "");
  const workflow = parseWorkflowJson(jsonText);
  const category = inferCategory(lower, file);
  const requiredInputs = inferRequiredInputs(category, jsonText.toLowerCase(), `${lower} ${file}`);
  const outputType = category.includes("video") ? "video" : "image";
  const imageSlotCount = inferImageSlotCount(file, workflow, category, requiredInputs, workflowPath);
  const durationConfig = inferDurationConfig(`${lower} ${file}`, workflow, outputType);
  const supportedDurations = durationConfig.supportedDurations;
  const defaultDurationSeconds = durationConfig.defaultDurationSeconds;
  const supportedResolutions = inferSupportedResolutions(`${lower} ${file}`);
  const defaultResolution = defaultResolutionForModel(`${lower} ${file}`, supportedResolutions);
  const name = file
    .replace(/^brc?ik_api_/i, "")
    .replace(/^brick_/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  const model: WorkflowModel = {
    id: slug(file),
    name,
    category,
    workflowPath,
    description: `Loaded from ${path.basename(path.dirname(workflowPath))}.`,
    requiredInputs,
    supportedResolutions,
    defaultResolution,
    supportedDurations,
    defaultDurationSeconds,
    requiresPrompt: requiredInputs.includes("prompt"),
    requiresImage: requiredInputs.includes("single_image") || requiredInputs.includes("start_frame"),
    requiresStartEndFrames: requiredInputs.includes("start_frame") && requiredInputs.includes("end_frame"),
    imageSlotCount,
    outputType,
    estimatedCredits: outputType === "video" ? 18 : category === "image_upscaling" ? 8 : 4,
    estimatedTime: outputType === "video" ? "2-5 min" : "35-90 sec",
  };
  model.estimatedCredits = estimateWorkflowCredits(
    model,
    defaultDurationSeconds,
    resolutionFromLabel(model.defaultResolution ?? defaultResolution),
  );
  return model;
}

function resolutionFromLabel(label: string) {
  const normalized = label.toLowerCase().replace(/\s+/g, "");
  const gptSize = gptImageSizeLabel(normalized);
  if (gptSize !== "auto" || normalized === "auto") {
    const match = gptSize.match(/^(\d+)x(\d+)$/);
    return {
      width: match ? Number(match[1]) : 1024,
      height: match ? Number(match[2]) : 1024,
      label: gptSize,
    };
  }
  if (normalized === "1k") return { width: 1024, height: 1024, label: "1K" };
  if (normalized === "2k") return { width: 2048, height: 2048, label: "2K" };
  if (normalized === "720p") return { width: 1280, height: 720, label: "720p" };
  if (normalized === "4k") return { width: 3840, height: 2160, label: "4K" };
  return { width: 1920, height: 1080, label: "1080p" };
}

function parseWorkflowJson(jsonText: string) {
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return undefined;
  }
}

function isApiPromptLike(workflow: unknown) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return false;
  const record = workflow as Record<string, any>;
  if (record.output && typeof record.output === "object") return true;
  if (record.prompt && typeof record.prompt === "object") return true;
  return Object.keys(record).some((key) => /^\d+$/.test(key));
}

function collectLoadImageNames(workflow: unknown) {
  const names: string[] = [];

  for (const { node } of orderedLoadImageNodeEntries(workflow)) {
    const classType = String(node?.class_type ?? node?.type ?? "").toLowerCase();
    if (!classType.includes("loadimage")) continue;

    const apiImage = node?.inputs && !Array.isArray(node.inputs) ? node.inputs.image : undefined;
    if (typeof apiImage === "string" && apiImage.trim()) {
      names.push(apiImage.trim());
      continue;
    }

    const widgetImage = Array.isArray(node?.widgets_values) ? node.widgets_values[0] : undefined;
    if (typeof widgetImage === "string" && widgetImage.trim()) {
      names.push(widgetImage.trim());
    }
  }

  return names;
}

function collectLoadVideoNames(workflow: unknown) {
  const names: string[] = [];

  for (const node of workflowNodesDeep(workflow)) {
    const classType = String(node?.class_type ?? node?.type ?? "").toLowerCase();
    if (!classType.includes("loadvideo")) continue;

    const inputs = node?.inputs && !Array.isArray(node.inputs) ? node.inputs : undefined;
    const apiVideo = inputs?.file ?? inputs?.video;
    if (typeof apiVideo === "string" && apiVideo.trim()) {
      names.push(apiVideo.trim());
      continue;
    }

    const widgetVideo = Array.isArray(node?.widgets_values) ? node.widgets_values[0] : undefined;
    if (typeof widgetVideo === "string" && widgetVideo.trim()) {
      names.push(widgetVideo.trim());
    }
  }

  return names;
}

function workflowNodesDeep(workflow: unknown): Array<Record<string, any>> {
  return workflowNodeEntriesDeep(workflow).map((entry) => entry.node);
}

function workflowNodeEntriesDeep(workflow: unknown): Array<{ id?: string; node: Record<string, any> }> {
  if (!workflow || typeof workflow !== "object") return [];
  const record = workflow as Record<string, any>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map((node: Record<string, any>) => ({ id: node?.id == null ? undefined : String(node.id), node }))
    : Object.entries(record.output ?? record.prompt ?? record).map(([id, node]) => ({
      id,
      node: node as Record<string, any>,
    }));
  const subgraphNodes = Array.isArray(record.definitions?.subgraphs)
    ? record.definitions.subgraphs.flatMap((subgraph: Record<string, any>) => workflowNodeEntriesDeep(subgraph))
    : [];
  return [
    ...(nodes.filter((entry) => Boolean(entry.node && typeof entry.node === "object")) as Array<{ id?: string; node: Record<string, any> }>),
    ...subgraphNodes,
  ];
}

function orderedLoadImageNodeEntries(workflow: unknown) {
  const entries = workflowNodeEntriesDeep(workflow);
  const loadImageEntries = entries.filter(({ node }) => isLoadImageClass(node?.class_type ?? node?.type));
  const loadImageById = new Map(loadImageEntries.filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
  const ordered: Array<{ id?: string; node: Record<string, any> }> = [];
  const seen = new Set<string>();

  for (const id of referencedLoadImageIds(entries, loadImageById)) {
    const entry = loadImageById.get(id);
    if (!entry || seen.has(id)) continue;
    ordered.push(entry);
    seen.add(id);
  }

  for (const entry of loadImageEntries) {
    const key = entry.id ?? JSON.stringify(entry.node);
    if (seen.has(key)) continue;
    ordered.push(entry);
    seen.add(key);
  }

  return ordered;
}

function referencedLoadImageIds(
  entries: Array<{ id?: string; node: Record<string, any> }>,
  loadImageById: Map<string, { id?: string; node: Record<string, any> }>,
) {
  const references: string[] = [];

  for (const { node } of entries) {
    const inputs = node?.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs)
      ? node.inputs as Record<string, unknown>
      : {};
    const orderedInputs = Object.entries(inputs)
      .map(([key, value], index) => ({ key, value, index, priority: imageReferencePriority(key) }))
      .filter((entry) => entry.priority != null)
      .sort((a, b) => (a.priority as number) - (b.priority as number) || a.index - b.index);

    for (const { value } of orderedInputs) {
      const nodeId = Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
      if (nodeId && loadImageById.has(nodeId)) references.push(nodeId);
    }
  }

  return references;
}

function imageReferencePriority(key: string) {
  const lowerKey = key.toLowerCase();
  const referenceMatch = lowerKey.match(/(?:^|\.)reference_images\.image_(\d+)$/);
  if (referenceMatch) return Number(referenceMatch[1]);

  const batchMatch = lowerKey.match(/^images\.image(\d+)$/);
  if (batchMatch) return 100 + Number(batchMatch[1]);

  const imageMatch = lowerKey.match(/^image_(\d+)$/);
  if (imageMatch) return 200 + Number(imageMatch[1]);

  if (lowerKey === "reference_images") return 300;
  if (lowerKey === "image") return 400;
  return undefined;
}

function inferImageSlotCount(
  file: string,
  workflow: unknown,
  category: ModelCategory,
  requiredInputs: WorkflowRequiredInput[],
  workflowPath: string,
) {
  if (isServerlessWorkflowPath(workflowPath)) {
    const loadImageCount = serverlessImageSlotCount(workflow);
    if (loadImageCount > 0) return loadImageCount;
  }

  const key = file.toLowerCase();
  if (category === "first_last_frame_to_video") return 2;
  if (key.includes("openai_gpt_image_2_i2i")) return 5;
  if (key.includes("nano") && key.includes("banana")) return 3;
  if (key.includes("ref_transfer")) return 2;
  if (key.includes("exteriorgrid")) return 1;

  const batchCount = imageBatchInputCount(workflow);
  if (batchCount > 0) return batchCount;
  if (requiredInputs.includes("single_image")) return 1;
  return 0;
}

function isServerlessWorkflowPath(workflowPath: string) {
  const root = path.resolve(serverlessWorkflowRoot).toLowerCase();
  return path.resolve(workflowPath).toLowerCase().startsWith(root);
}

function serverlessImageSlotCount(workflow: unknown) {
  const loadImageCount = loadImageNodeCount(workflow);
  return Math.max(loadImageCount, imageBatchInputCount(workflow), referenceImageInputCount(workflow));
}

function loadImageNodeCount(workflow: unknown) {
  return loadImageNodes(workflow).length;
}

function loadImageNodes(workflow: unknown) {
  return orderedLoadImageNodeEntries(workflow).map((entry) => entry.node);
}

function imageBatchInputCount(workflow: unknown) {
  if (!workflow || typeof workflow !== "object") return 0;

  let maxCount = 0;
  for (const node of workflowNodesDeep(workflow)) {
    const classType = String(node?.type ?? node?.class_type ?? "").toLowerCase();
    if (!classType.includes("imagebatchmulti") && !classType.includes("batchimagesnode")) continue;
    const inputs = Array.isArray(node?.inputs)
      ? node.inputs.map((input: any) => String(input?.name ?? ""))
      : Object.keys(node?.inputs ?? {});
    const count = inputs.filter((name: string) => /^image_\d+$/i.test(name)).length;
    const dottedCount = inputs.filter((name: string) => /^images\.image\d+$/i.test(name)).length;
    const inputCount = typeof node?.inputs?.inputcount === "number" ? node.inputs.inputcount : 0;
    maxCount = Math.max(maxCount, count, dottedCount, inputCount);
  }
  return maxCount;
}

function referenceImageInputCount(workflow: unknown) {
  let maxCount = 0;
  for (const node of workflowNodesDeep(workflow)) {
    const inputs = node?.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs)
      ? node.inputs as Record<string, unknown>
      : {};
    const numberedReferenceImages = Object.keys(inputs)
      .filter((name) => /(?:^|\.)reference_images\.image_\d+$/i.test(name))
      .length;
    if (numberedReferenceImages) maxCount = Math.max(maxCount, numberedReferenceImages);
  }
  return maxCount;
}

function inferSupportedResolutions(source: string) {
  const key = source.toLowerCase();
  if (key.includes("nano") && key.includes("banana")) {
    return ["1K", "2K", "4K"];
  }
  if (isGptImageKey(key)) {
    return gptImageSizeOptions;
  }
  if (key.includes("kling") && key.includes("video_edit")) {
    return ["720p", "1080p"];
  }
  return ["720p", "1080p", "4K"];
}

function defaultResolutionForModel(source: string, supportedResolutions: string[]) {
  const key = source.toLowerCase();
  if (key.includes("nano") && key.includes("banana")) return "1K";
  if (isGptImageKey(key)) return "auto";
  return supportedResolutions.includes("1080p") ? "1080p" : supportedResolutions[0] ?? "1080p";
}

function inferDurationConfig(source: string, workflow: unknown, outputType: "image" | "video" | "sequence") {
  if (outputType !== "video") {
    return { supportedDurations: [], defaultDurationSeconds: undefined };
  }

  const key = source.toLowerCase();
  if (key.includes("veo3") && key.includes("flf2v")) {
    return { supportedDurations: [4, 6, 8], defaultDurationSeconds: 6 };
  }
  if (key.includes("veo3") && key.includes("i2v")) {
    return { supportedDurations: [4, 6, 8], defaultDurationSeconds: 4 };
  }
  if (key.includes("kling_v3_flf2v")) {
    return { supportedDurations: range(3, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("seedance") && key.includes("flf2v")) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("kling_v2.6_video") || key.includes("kling_v2_6_video")) {
    return { supportedDurations: [5, 10], defaultDurationSeconds: 5 };
  }
  if (key.includes("kling_v3_video")) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }
  if (key.includes("seedance") && (key.includes("i2v") || key.includes("r2v"))) {
    return { supportedDurations: range(4, 15), defaultDurationSeconds: 5 };
  }

  const supportedDurations = inferSupportedDurations(workflow, outputType);
  return {
    supportedDurations,
    defaultDurationSeconds: inferDefaultDurationSeconds(workflow, supportedDurations),
  };
}

function inferSupportedDurations(workflow: unknown, outputType: "image" | "video" | "sequence") {
  if (outputType !== "video") return [];
  const classTypes = workflowClassTypes(workflow);

  if (classTypes.some((classType) => classType.includes("veo3"))) {
    return [4, 6, 8];
  }
  if (classTypes.some((classType) => classType.includes("bytedance2"))) {
    return range(4, 15);
  }
  if (classTypes.some((classType) => classType.includes("klingimagetovideowithaudio"))) {
    return [5, 10];
  }
  if (classTypes.some((classType) => classType.includes("klingfirstlastframenode"))) {
    return range(3, 15);
  }
  if (classTypes.some((classType) => classType.includes("klingvideonode"))) {
    return [5];
  }

  return [];
}

function inferDefaultDurationSeconds(workflow: unknown, supportedDurations: number[]) {
  if (!supportedDurations.length || !workflow || typeof workflow !== "object") return undefined;
  const record = workflow as Record<string, any>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes
    : Object.values(record.output ?? record.prompt ?? record);

  for (const node of nodes) {
    const classType = String(node?.type ?? node?.class_type ?? "").toLowerCase();
    if (!isDurationProviderNode(classType)) continue;
    const widgets = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
    const match = widgets.find((value: unknown) => typeof value === "number" && Number.isInteger(value) && supportedDurations.includes(value));
    if (typeof match === "number") return match;
  }

  return supportedDurations[0];
}

function isDurationProviderNode(classType: string) {
  return classType.includes("veo3")
    || classType.includes("bytedance2")
    || classType.includes("klingfirstlastframenode")
    || classType.includes("klingimagetovideowithaudio")
    || classType.includes("klingvideonode");
}

function workflowClassTypes(workflow: unknown) {
  if (!workflow || typeof workflow !== "object") return [];
  const record = workflow as Record<string, any>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes
    : Object.values(record.output ?? record.prompt ?? record);
  return nodes
    .map((node) => String(node?.type ?? node?.class_type ?? "").toLowerCase())
    .filter(Boolean);
}

function range(min: number, max: number) {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function inferCategory(lowerPath: string, file: string): ModelCategory {
  const lowerFile = file.toLowerCase();
  if (lowerPath.includes("flf2v")) return "first_last_frame_to_video";
  if (lowerPath.includes("i2v")) return "image_to_video";
  if (lowerPath.includes("video_editing") || lowerPath.includes("video_edit") || lowerFile.includes("video edit") || lowerFile.includes("video_edit") || lowerFile.includes("r2v")) return "video_editing";
  if (lowerFile.includes("upscale") || lowerFile.includes("enhance")) return "image_upscaling";
  if (lowerPath.includes("image_editing") || lowerFile.includes("i2i") || lowerFile.includes("banana") || lowerFile.includes("transfer")) return "image_editing";
  return "image_generation";
}

function inferRequiredInputs(category: ModelCategory, workflowText: string, source: string): WorkflowRequiredInput[] {
  const inputs = new Set<WorkflowRequiredInput>(["resolution", "seed"]);
  if (!isPromptOptionalWorkflow(source)) {
    inputs.add("prompt");
  }
  if (category === "image_to_video" || category === "image_editing" || category === "image_upscaling") {
    inputs.add("single_image");
  }
  if (category === "video_editing") {
    inputs.add("single_image");
  }
  if (category === "first_last_frame_to_video") {
    inputs.add("start_frame");
    inputs.add("end_frame");
  }
  if (category === "video_editing" || category === "video_upscaling") {
    inputs.add("video");
  }
  if (workflowText.includes("mask")) {
    inputs.add("mask");
  }
  return Array.from(inputs);
}

function isPromptOptionalWorkflow(source: string) {
  const key = source.toLowerCase();
  return key.includes("ref_transfer_gpt2")
    || key.includes("ref transfer gpt2")
    || key.includes("exteriorgrid")
    || key.includes("exterior grid");
}

function toApiPrompt(workflow: unknown, objectInfo: Record<string, any> = {}): Record<string, any> {
  if (workflow && typeof workflow === "object" && !Array.isArray(workflow)) {
    const record = workflow as Record<string, any>;
    if (record.output && typeof record.output === "object") return record.output;
    if (record.prompt && typeof record.prompt === "object") return record.prompt;
    const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (numericKeys.length) return record;
    if (Array.isArray(record.nodes)) {
      const prompt: Record<string, any> = {};
      const links = new Map<number, { fromNode: string; fromSlot: number }>();

      for (const link of Array.isArray(record.links) ? record.links : []) {
        if (Array.isArray(link) && link.length >= 5) {
          links.set(Number(link[0]), { fromNode: String(link[1]), fromSlot: Number(link[2]) });
        }
      }

      const subgraphs = subgraphDefinitions(record);
      for (const node of record.nodes) {
        if (node?.id != null) {
          const subgraph = subgraphs.get(String(node.type ?? ""));
          if (subgraph) {
            expandSubgraphNode(prompt, links, node, subgraph, objectInfo);
            continue;
          }

          prompt[String(node.id)] = {
            class_type: nodeClassType(node),
            inputs: uiNodeInputs(node, links, objectInfo),
          };
        }
      }
      return prompt;
    }
  }
  throw new Error("Unsupported ComfyUI workflow JSON shape.");
}

function subgraphDefinitions(record: Record<string, any>) {
  const subgraphs = Array.isArray(record.definitions?.subgraphs) ? record.definitions.subgraphs : [];
  return new Map<string, Record<string, any>>(
    subgraphs
      .filter((subgraph: any) => subgraph?.id && Array.isArray(subgraph.nodes))
      .map((subgraph: any) => [String(subgraph.id), subgraph]),
  );
}

function expandSubgraphNode(
  prompt: Record<string, any>,
  parentLinks: Map<number, { fromNode: string; fromSlot: number }>,
  parentNode: Record<string, any>,
  subgraph: Record<string, any>,
  objectInfo: Record<string, any>,
) {
  const parentNodeId = String(parentNode.id);
  const internalLinks = new Map<number, { fromNode: string; fromSlot: number }>();
  const outputOrigins = new Map<number, { fromNode: string; fromSlot: number }>();

  const parentInputLinks = Array.isArray(parentNode.inputs)
    ? parentNode.inputs.map((input: any) => input?.link == null ? undefined : parentLinks.get(Number(input.link)))
    : [];

  for (const link of Array.isArray(subgraph.links) ? subgraph.links : []) {
    const linkId = Number(link?.id);
    const originId = Number(link?.origin_id);
    const originSlot = Number(link?.origin_slot ?? 0);
    const targetId = Number(link?.target_id);
    const targetSlot = Number(link?.target_slot ?? 0);

    if (!Number.isFinite(linkId)) continue;

    if (originId === -10) {
      const parentOrigin = parentInputLinks[originSlot];
      if (parentOrigin) {
        internalLinks.set(linkId, parentOrigin);
      }
      continue;
    }

    const origin = { fromNode: expandedSubgraphNodeId(parentNodeId, originId), fromSlot: originSlot };
    if (targetId === -20) {
      outputOrigins.set(targetSlot, origin);
    } else {
      internalLinks.set(linkId, origin);
    }
  }

  for (const node of subgraph.nodes) {
    if (node?.id == null) continue;
    prompt[expandedSubgraphNodeId(parentNodeId, node.id)] = {
      class_type: nodeClassType(node),
      inputs: uiNodeInputs(node, internalLinks, objectInfo),
    };
  }

  if (Array.isArray(parentNode.outputs)) {
    parentNode.outputs.forEach((output: any, outputIndex: number) => {
      const origin = outputOrigins.get(outputIndex);
      if (!origin || !Array.isArray(output?.links)) return;
      for (const linkId of output.links) {
        parentLinks.set(Number(linkId), origin);
      }
    });
  }
}

function expandedSubgraphNodeId(parentNodeId: string, nodeId: string | number) {
  return `${parentNodeId}_${nodeId}`;
}

function nodeClassType(node: Record<string, any>) {
  return node.class_type ?? node.type ?? node.properties?.["Node name for S&R"] ?? node.name;
}

function pruneUnavailableNodes(prompt: Record<string, any>, objectInfo: Record<string, any>) {
  const availableClassTypes = new Set(Object.keys(objectInfo));
  if (!availableClassTypes.size) return;

  const removedNodeIds = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const [nodeId, node] of Object.entries(prompt)) {
      if (removedNodeIds.has(nodeId)) continue;

      const classType = String(node?.class_type ?? "");
      const classIsMissing = Boolean(classType) && !availableClassTypes.has(classType);
      const dependsOnRemovedNode = Object.values(node?.inputs ?? {}).some((value) => referencesRemovedNode(value, removedNodeIds));

      if (classIsMissing || dependsOnRemovedNode) {
        delete prompt[nodeId];
        removedNodeIds.add(nodeId);
        changed = true;
      }
    }
  }
}

function pruneSaveBrickSequenceNodes(prompt: Record<string, any>) {
  for (const [nodeId, node] of Object.entries(prompt)) {
    const classType = String(node?.class_type ?? "").toLowerCase();
    if (classType === "savearchvizsequence") {
      delete prompt[nodeId];
    }
  }
}

function referencesRemovedNode(value: unknown, removedNodeIds: Set<string>): boolean {
  return Array.isArray(value) && typeof value[0] === "string" && removedNodeIds.has(value[0]);
}

function uiNodeInputs(
  node: Record<string, any>,
  links: Map<number, { fromNode: string; fromSlot: number }>,
  objectInfo: Record<string, any>,
) {
  const inputs: Record<string, any> = {};

  if (Array.isArray(node.inputs)) {
    for (const input of node.inputs) {
      const link = input?.link == null ? undefined : links.get(Number(input.link));
      if (input?.name && link) {
        inputs[input.name] = [link.fromNode, link.fromSlot];
      }
    }
  } else if (node.inputs && typeof node.inputs === "object") {
    Object.assign(inputs, node.inputs);
  }

  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const widgetSpecs = widgetInputSpecs(String(node.type ?? node.class_type ?? ""), objectInfo);
  let widgetIndex = 0;
  for (const spec of widgetSpecs) {
    if (widgetIndex >= widgets.length) break;
    if (spec.name in inputs) {
      widgetIndex += spec.widgetSpan;
      continue;
    }
    if (spec.inputType === "COMFY_DYNAMICCOMBO_V3") {
      const dynamicValue = dynamicComboWidgetValues(widgets, widgetIndex, spec.options);
      inputs[spec.name] = dynamicValue.key;
      for (const [nestedName, nestedValue] of Object.entries(dynamicValue.nestedValues)) {
        inputs[`${spec.name}.${nestedName}`] = nestedValue;
      }
      widgetIndex += dynamicValue.span;
      continue;
    }
    const value = coerceWidgetValue(widgets[widgetIndex], spec);
    inputs[spec.name] = value;
    widgetIndex += spec.widgetSpan;
  }
  return inputs;
}

type WidgetInputSpec = {
  name: string;
  inputType: unknown;
  defaultValue?: unknown;
  hasControlAfterGenerate: boolean;
  options?: Record<string, unknown>;
  widgetSpan: number;
  isWidget: boolean;
};

function widgetInputSpecs(classType: string, objectInfo: Record<string, any>): WidgetInputSpec[] {
  const info = objectInfo[classType]?.input;
  const sections = [info?.required, info?.optional].filter(Boolean) as Array<Record<string, unknown>>;
  const specs = sections.flatMap((section) =>
    Object.entries(section)
      .map(([name, value]) => {
        const inputType = Array.isArray(value) ? value[0] : undefined;
        const options = Array.isArray(value) ? (value[1] as Record<string, unknown> | undefined) : undefined;
        return {
          name,
          inputType,
          defaultValue: options?.default,
          hasControlAfterGenerate: Boolean(options?.control_after_generate),
          options,
          widgetSpan: widgetSpan(inputType, options),
          isWidget: isWidgetInput(inputType),
        };
      })
      .filter((spec) => spec.isWidget),
  );
  return specs.length ? specs : fallbackWidgetInputSpecs(classType);
}

function fallbackWidgetInputSpecs(classType: string): WidgetInputSpec[] {
  const definitions: Record<string, Array<[string, unknown, Record<string, unknown>?]>> = {
    LoadImage: [["image", "STRING"]],
    LoadVideo: [["file", "STRING"]],
    SaveVideo: [
      ["filename_prefix", "STRING", { default: "video/ComfyUI" }],
      ["format", "COMBO", { default: "auto" }],
      ["codec", "COMBO", { default: "auto" }],
    ],
    KlingOmniProEditVideoNode: [
      ["model_name", "COMBO", { default: "kling-v3-omni" }],
      ["prompt", "STRING", { default: "" }],
      ["keep_original_sound", "BOOLEAN", { default: true }],
      ["resolution", "COMBO", { default: "1080p" }],
      ["seed", "INT", { default: 0, control_after_generate: true }],
    ],
    ByteDance2ReferenceNode: [
      ["model", "COMBO", { default: "Seedance 2.0" }],
      ["model.prompt", "STRING", { default: "" }],
      ["model.resolution", "COMBO", { default: "1080p" }],
      ["model.ratio", "COMBO", { default: "16:9" }],
      ["model.duration", "INT", { default: 5 }],
      ["model.generate_audio", "BOOLEAN", { default: true }],
      ["model.auto_downscale", "BOOLEAN", { default: true }],
      ["model.auto_upscale", "BOOLEAN", { default: false }],
      ["seed", "INT", { default: 0, control_after_generate: true }],
      ["watermark", "BOOLEAN", { default: false }],
    ],
  };

  return (definitions[classType] ?? []).map(([name, inputType, options]) => ({
    name,
    inputType,
    defaultValue: options?.default,
    hasControlAfterGenerate: Boolean(options?.control_after_generate),
    options,
    widgetSpan: widgetSpan(inputType, options),
    isWidget: true,
  }));
}

// UI-only node types whose widget values never become executable inputs.
const inertUiNodeTypes = new Set(["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]);

// The RunPod path converts UI-format workflows without a live ComfyUI server,
// so widget values can only be mapped through fallbackWidgetInputSpecs. A node
// type missing from that table would silently lose all of its widget values
// (prompt, resolution, seed, ...) and generate with defaults. Fail loudly
// instead so the gap is caught when the workflow is added, not in its output.
function assertUiWorkflowWidgetsSupported(workflow: unknown, workflowPath: string) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return;
  const record = workflow as Record<string, any>;
  // API-prompt shapes carry named inputs already and need no widget mapping.
  if (record.output && typeof record.output === "object") return;
  if (record.prompt && typeof record.prompt === "object") return;
  if (Object.keys(record).some((key) => /^\d+$/.test(key))) return;
  if (!Array.isArray(record.nodes)) return;

  const subgraphs = subgraphDefinitions(record);
  const unsupported = new Set<string>();
  const collectUnsupported = (nodes: any[]) => {
    for (const node of nodes) {
      if (!node || node.id == null) continue;
      const classType = String(nodeClassType(node) ?? "");
      if (!classType || inertUiNodeTypes.has(classType) || subgraphs.has(classType)) continue;
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      if (!widgets.length) continue;
      if (!widgetInputSpecs(classType, {}).length) unsupported.add(classType);
    }
  };

  collectUnsupported(record.nodes);
  for (const subgraph of subgraphs.values()) {
    collectUnsupported(subgraph.nodes);
  }

  if (unsupported.size) {
    throw new Error(
      `Workflow ${path.basename(workflowPath)} uses node type(s) with widget values that have no RunPod input mapping: `
      + `${[...unsupported].sort().join(", ")}. Add them to fallbackWidgetInputSpecs in workflowService.ts `
      + "so their widget values are not silently dropped.",
    );
  }
}

function isWidgetInput(inputType: unknown) {
  if (Array.isArray(inputType)) return true;
  return ["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"].includes(String(inputType));
}

function coerceWidgetValue(
  value: unknown,
  spec: { inputType: unknown; defaultValue?: unknown; options?: Record<string, unknown> },
) {
  if (value !== "" && value != null) return value;
  if (spec.defaultValue !== undefined) return spec.defaultValue;
  if (spec.inputType === "INT") return 0;
  if (spec.inputType === "FLOAT") return 0;
  if (spec.inputType === "BOOLEAN") return false;
  return value;
}

function dynamicComboWidgetValues(widgets: unknown[], widgetIndex: number, options: Record<string, unknown> | undefined) {
  const keyValue = widgets[widgetIndex];
  const key = typeof keyValue === "string" && keyValue.trim()
    ? keyValue
    : firstDynamicComboOptionKey(options) ?? "";
  const nestedNames = dynamicComboNestedInputNames(options, key);
  const nestedValues = Object.fromEntries(
    nestedNames.map((name, index) => {
      const value = widgets[widgetIndex + index + 1];
      return [name, value !== "" && value != null ? value : dynamicComboNestedDefault(options, key, name)];
    }),
  );
  return {
    key,
    nestedValues,
    span: 1 + nestedNames.length,
  };
}

function widgetSpan(inputType: unknown, options: Record<string, unknown> | undefined) {
  const controlOffset = Boolean(options?.control_after_generate) ? 1 : 0;
  if (inputType === "COMFY_DYNAMICCOMBO_V3") {
    return 1 + dynamicComboNestedWidgetCount(options);
  }
  return 1 + controlOffset;
}

function firstDynamicComboOptionKey(options: Record<string, unknown> | undefined) {
  const option = Array.isArray(options?.options) ? options.options[0] as Record<string, unknown> | undefined : undefined;
  return typeof option?.key === "string" ? option.key : undefined;
}

function dynamicComboNestedWidgetCount(options: Record<string, unknown> | undefined) {
  const option = Array.isArray(options?.options) ? options.options[0] as Record<string, unknown> | undefined : undefined;
  const required = nestedRequiredInputs(option);
  return Object.keys(required).length;
}

function dynamicComboNestedInputNames(options: Record<string, unknown> | undefined, key: string) {
  return Object.keys(dynamicComboNestedRequiredInputs(options, key));
}

function dynamicComboNestedDefault(options: Record<string, unknown> | undefined, key: string, name: string) {
  const config = dynamicComboNestedRequiredInputs(options, key)[name];
  return Array.isArray(config) && typeof config[1] === "object" && config[1]
    ? (config[1] as Record<string, unknown>).default ?? ""
    : "";
}

function dynamicComboNestedRequiredInputs(options: Record<string, unknown> | undefined, key: string) {
  const option = Array.isArray(options?.options)
    ? options.options.find((item) => typeof item === "object" && item && (item as Record<string, unknown>).key === key) as Record<string, unknown> | undefined
    : undefined;
  return nestedRequiredInputs(option);
}

function nestedRequiredInputs(option: Record<string, unknown> | undefined) {
  const inputs = option?.inputs;
  if (!inputs || typeof inputs !== "object") return {};
  const required = (inputs as Record<string, unknown>).required;
  if (!required || typeof required !== "object") return {};
  return Object.fromEntries(
    Object.entries(required as Record<string, unknown>).filter(([, value]) => {
      const inputType = Array.isArray(value) ? value[0] : undefined;
      return isWidgetInput(inputType);
    }),
  );
}

function injectInputs(
  prompt: Record<string, any>,
  model: WorkflowModel,
  request: CreateJobRequest,
  projectName: string,
  mapping: WorkflowInputMapping,
  objectInfo: Record<string, any>,
) {
  const resolution = request.resolution;
  const durationSeconds = normalizeDurationSeconds(request.durationSeconds, model);
  const images = request.inputImages ?? [];
  const startFrame = request.startFrame ?? images[0];
  const endFrame = request.endFrame ?? images[1];
  const loadImageNodeIds = orderedLoadImageNodeEntries(prompt)
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id));
  const imageBatchNodeId = Object.entries(prompt)
    .find(([, node]) => isImageBatchClass(node?.class_type))?.[0];

  for (const [nodeId, node] of Object.entries(prompt)) {
    const inputs = (node.inputs ??= {});
    const classType = String(node.class_type ?? "").toLowerCase();
    if (isImageBatchClass(classType)) {
      wireImageBatchInputs(inputs, classType, loadImageNodeIds, images.length);
    }
    for (const key of Object.keys(inputs)) {
      const lowerKey = key.toLowerCase();
      const referenceImageIndex = numberedReferenceImageInputIndex(lowerKey);
      if (referenceImageIndex != null && referenceImageIndex >= images.length && Array.isArray(inputs[key])) {
        delete inputs[key];
        continue;
      }
      if (request.prompt && model.requiresPrompt && isEditablePromptInput(lowerKey) && typeof inputs[key] === "string") {
        inputs[key] = request.prompt;
      }
      if (resolution && lowerKey === "width") inputs[key] = resolution.width;
      if (resolution && lowerKey === "height") inputs[key] = resolution.height;
      if (resolution && lowerKey === "resolution") inputs[key] = directResolutionLabel(resolution.label ?? "1080p");
      if (resolution && lowerKey === "model.resolution") inputs[key] = resolutionWidgetLabel(resolution.label ?? "1080p");
      if (resolution && isGptImageNode(node) && lowerKey === "size") inputs[key] = gptImageSizeLabel(resolution.label ?? "auto");
      if (durationSeconds && isDurationInput(lowerKey) && isScalarInputValue(inputs[key])) inputs[key] = durationSeconds;
      if (lowerKey.includes("project_name")) inputs[key] = coerceProjectName(projectName, String(node.class_type ?? ""), objectInfo);
      if (isNumberedImageInput(lowerKey) && typeof inputs[key] === "string") {
        const imageIndex = Number(lowerKey.match(/image_(\d+)/)?.[1] ?? 1) - 1;
        if (images[imageIndex]) inputs[key] = images[imageIndex];
      } else if (lowerKey === "image" && images[0] && typeof inputs[key] === "string") {
        inputs[key] = images[0];
      }
      if (lowerKey.includes("start") && startFrame && typeof inputs[key] === "string") inputs[key] = startFrame;
      if (lowerKey.includes("end") && endFrame && typeof inputs[key] === "string") inputs[key] = endFrame;
      if (lowerKey.includes("video") && request.inputVideo && typeof inputs[key] === "string") inputs[key] = request.inputVideo;
      if (classType.includes("loadvideo") && lowerKey === "file" && request.inputVideo && typeof inputs[key] === "string") {
        inputs[key] = request.inputVideo;
      }
      if (
        imageBatchNodeId &&
        images.length > 1 &&
        lowerKey.includes("reference_images") &&
        Array.isArray(inputs[key]) &&
        loadImageNodeIds.includes(String(inputs[key][0]))
      ) {
        inputs[key] = [imageBatchNodeId, 0];
      }
    }
    if (isLoadImageClass(classType)) {
      const key = Object.keys(inputs).find((item) => item.toLowerCase() === "image" && typeof inputs[item] === "string")
        ?? Object.keys(inputs).find((item) => item.toLowerCase().includes("image") && typeof inputs[item] === "string");
      const imageIndex = loadImageNodeIds.indexOf(nodeId);
      if (key && imageIndex >= 0 && images[imageIndex]) {
        inputs[key] = images[imageIndex];
      }
    }
    if (classType.includes("archvizgridpromptbuilder")) {
      applyArchVizGridOptions(inputs, request.workflowOptions?.archVizGrid);
    }
    if (isNanoBananaClassType(classType)) {
      applyNanoBananaAspectRatioInput(inputs, request.workflowOptions);
    }
    applySaveNumberOptions(inputs, classType, request.workflowOptions?.save);
    if (request.prompt && model.requiresPrompt && (classType.includes("text") || classType.includes("prompt"))) {
      const key = Object.keys(inputs).find((item) => isEditablePromptInput(item.toLowerCase()) && typeof inputs[item] === "string");
      if (key) {
        inputs[key] = request.prompt;
      }
    }
    injectDurationInput(inputs, String(node.class_type ?? ""), durationSeconds, objectInfo);
    applyMappedInputs(nodeId, inputs, mapping, request, projectName, startFrame, endFrame);
    randomizeApiVideoSeed(model, classType, inputs);
    sanitizeInputs(inputs, String(node.class_type ?? ""), projectName, objectInfo);
  }

  void model;
}

function applyTextOnlyImageWorkflowMode(
  prompt: Record<string, any>,
  model: WorkflowModel,
  request: CreateJobRequest,
) {
  if (!supportsTextOnlyImageWorkflow(model) || (request.inputImages?.length ?? 0) > 0) return;

  for (const node of Object.values(prompt)) {
    if (!isTextOnlyCapableGenerationNode(node)) continue;
    const inputs = node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs)
      ? node.inputs as Record<string, any>
      : undefined;
    if (!inputs) continue;
    delete inputs.image;
    delete inputs.images;
    delete inputs.reference_images;
  }

  for (const [nodeId, node] of Object.entries(prompt)) {
    const classType = String(node?.class_type ?? node?.type ?? "").toLowerCase();
    if (isLoadImageClass(classType) || isImageBatchClass(classType)) {
      delete prompt[nodeId];
    }
  }
}

function supportsTextOnlyImageWorkflow(model: WorkflowModel) {
  return isNanoBananaModel(model) || isGptImageModel(model);
}

function isTextOnlyCapableGenerationNode(node: any) {
  return isNanoBananaNode(node) || isGptImageNode(node);
}

function applyImageOutputCountOptions(
  prompt: Record<string, any>,
  model: WorkflowModel,
  request: CreateJobRequest,
) {
  const isNano = isNanoBananaModel(model);
  const isGpt = isGptImageModel(model);
  if (!isNano && !isGpt) return;

  const generationEntry = Object.entries(prompt).find(([, node]) => isNano ? isNanoBananaNode(node) : isGptImageNode(node));
  if (!generationEntry) return;

  const [generationNodeId, generationNode] = generationEntry;
  const firstSeed = randomSeed();
  setSeedInput(generationNode.inputs ??= {}, firstSeed);
  if (isGpt) normalizeGptImageInputs(generationNode.inputs);

  const outputCount = isNano ? request.workflowOptions?.nanoBanana?.outputCount : request.workflowOptions?.gptImage?.outputCount;
  if (outputCount !== 2) return;

  const saveEntry = Object.entries(prompt).find(([, node]) => isSaveImageNode(node) && nodeSavesFrom(node, generationNodeId));
  const secondGenerationNodeId = nextPromptNodeId(prompt);
  const secondSaveNodeId = nextPromptNodeId(prompt, new Set([secondGenerationNodeId]));
  const secondGenerationNode = cloneJson(generationNode);
  const secondSeed = offsetSeed(firstSeed);

  setSeedInput(secondGenerationNode.inputs ??= {}, secondSeed);
  if (isGpt) normalizeGptImageInputs(secondGenerationNode.inputs);
  if (secondGenerationNode._meta && typeof secondGenerationNode._meta === "object") {
    secondGenerationNode._meta.title = `${String(secondGenerationNode._meta.title ?? (isNano ? "Nano Banana 2" : "GPT Image"))} Variation 2`;
  }
  prompt[secondGenerationNodeId] = secondGenerationNode;

  const secondSaveNode = saveEntry ? cloneJson(saveEntry[1]) : defaultSaveImageNode();
  secondSaveNode.inputs ??= {};
  secondSaveNode.inputs.images = [secondGenerationNodeId, 0];
  if (typeof secondSaveNode.inputs.filename_prefix === "string") {
    secondSaveNode.inputs.filename_prefix = `${secondSaveNode.inputs.filename_prefix}_variation_2`;
  }
  if (secondSaveNode._meta && typeof secondSaveNode._meta === "object") {
    secondSaveNode._meta.title = `${String(secondSaveNode._meta.title ?? "Save Image")} Variation 2`;
  }
  prompt[secondSaveNodeId] = secondSaveNode;
}

function isNanoBananaModel(model: WorkflowModel) {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  return key.includes("nano") && key.includes("banana");
}

function isGptImageModel(model: WorkflowModel) {
  const key = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  return isGptImageKey(key);
}

function isGptImageKey(key: string) {
  return (key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid");
}

function isNanoBananaNode(node: any) {
  const classType = String(node?.class_type ?? node?.type ?? "").toLowerCase();
  return isNanoBananaClassType(classType);
}

function isNanoBananaClassType(classType: string) {
  return classType.includes("gemininanobanana") || (classType.includes("nano") && classType.includes("banana"));
}

function normalizeNanoBananaAspectRatio(value: unknown) {
  return typeof value === "string" && nanoBananaAspectRatioOptions.has(value) ? value : undefined;
}

function applyNanoBananaAspectRatioInput(
  inputs: Record<string, any>,
  workflowOptions: CreateJobRequest["workflowOptions"],
) {
  const aspectRatio = normalizeNanoBananaAspectRatio(workflowOptions?.nanoBanana?.aspectRatio);
  if (!aspectRatio) return;
  const key = Object.keys(inputs).find((item) => {
    const lower = item.toLowerCase();
    return lower === "aspect_ratio" || lower === "aspect.ratio" || lower === "aspect ratio";
  }) ?? "aspect_ratio";
  inputs[key] = aspectRatio;
}

function isGptImageNode(node: any) {
  const classType = String(node?.class_type ?? node?.type ?? "").toLowerCase();
  return classType.includes("openaigptimage") || (classType.includes("gpt") && classType.includes("image"));
}

function isSaveImageNode(node: any) {
  const classType = String(node?.class_type ?? node?.type ?? "").toLowerCase();
  return classType.includes("saveimage");
}

function nodeSavesFrom(node: any, nodeId: string) {
  const imagesInput = node?.inputs?.images;
  return Array.isArray(imagesInput) && String(imagesInput[0]) === nodeId;
}

function setSeedInput(inputs: Record<string, any>, seed: number) {
  const seedKey = Object.keys(inputs).find((key) => key.toLowerCase() === "seed")
    ?? Object.keys(inputs).find((key) => key.toLowerCase().includes("seed"))
    ?? "seed";
  inputs[seedKey] = seed;
}

function randomizeApiVideoSeed(model: WorkflowModel, classType: string, inputs: Record<string, any>) {
  const modelKey = `${model.id} ${model.name} ${model.category} ${model.workflowPath}`.toLowerCase();
  const nodeKey = classType.toLowerCase();
  if (model.outputType !== "video") return;
  if (!modelKey.includes("kling") && !nodeKey.includes("kling")) return;

  const seedKey = Object.keys(inputs).find((key) => key.toLowerCase() === "seed")
    ?? Object.keys(inputs).find((key) => key.toLowerCase().includes("seed"));
  if (!seedKey) return;
  inputs[seedKey] = randomSeed();
}

function normalizeGptImageInputs(inputs: Record<string, any>) {
  if (String(inputs.size ?? "").toLowerCase() === "custom") {
    inputs.size = "Custom";
  }
  inputs.size = gptImageSizeLabel(String(inputs.size ?? "auto"));
}

function gptImageSizeLabel(label: string) {
  const normalized = label.toLowerCase().replace(/\s+/g, "");
  if (normalized === "custom") return "Custom";
  return gptImageSizeOptions.find((option) => option.toLowerCase() === normalized) ?? "auto";
}

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

function offsetSeed(seed: number) {
  return (seed + 9_973) % 2_147_483_647;
}

function nextPromptNodeId(prompt: Record<string, any>, reserved = new Set<string>()) {
  const maxId = Math.max(0, ...Object.keys(prompt).map((key) => Number(key)).filter((value) => Number.isFinite(value)));
  let next = maxId + 1;
  while (prompt[String(next)] || reserved.has(String(next))) next += 1;
  return String(next);
}

function defaultSaveImageNode() {
  return {
    inputs: {
      filename_prefix: "ComfyUI_variation_2",
      images: ["", 0],
    },
    class_type: "SaveImage",
    _meta: {
      title: "Save Image Variation 2",
    },
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const archVizSlotCounts = new Set(["1", "2", "4", "6", "8", "9"]);
const defaultSaveNumber = "0000";

function applyArchVizGridOptions(inputs: Record<string, any>, options: ArchVizGridOptions | undefined) {
  const slotCount = String(options?.slotCount ?? inputs.slot_count ?? "4");
  inputs.slot_count = archVizSlotCounts.has(slotCount) ? slotCount : "4";
  inputs.use_smart_defaults = options?.useSmartDefaults !== false;

  const cameraSlots = Array.isArray(options?.cameraSlots) ? options.cameraSlots : [];
  for (let index = 1; index <= 9; index += 1) {
    const key = `camera_slot_${index}`;
    const value = cameraSlots[index - 1];
    if (typeof value === "string" && value.trim()) {
      inputs[key] = value;
    }
  }
}

function applySaveNumberOptions(
  inputs: Record<string, any>,
  classType: string,
  options: { cameraNumber?: string; shotNumber?: string } | undefined,
) {
  if (classType.includes("savearchvizimage")) {
    inputs.camera_mode = "camera_number";
    setNumberedSaveInput(inputs, "camera_number", options?.cameraNumber ?? options?.shotNumber);
  }
  if (classType.includes("savearchvizvideo") || classType.includes("savearchvizsequence")) {
    setNumberedSaveInput(inputs, "shot_number", options?.shotNumber ?? options?.cameraNumber);
  }
}

function setNumberedSaveInput(inputs: Record<string, any>, name: "camera_number" | "shot_number", value: string | undefined) {
  const key = Object.keys(inputs).find((item) => item.toLowerCase() === name) ?? name;
  const normalized = normalizeSaveNumber(value);
  inputs[key] = typeof inputs[key] === "number" ? Number(normalized) : normalized;
}

function normalizeSaveNumber(value: string | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 4);
  return (digits || defaultSaveNumber).padStart(4, "0");
}

function wireImageBatchInputs(inputs: Record<string, any>, classType: string, loadImageNodeIds: string[], imageCount: number) {
  const activeCount = Math.min(loadImageNodeIds.length, Math.max(0, imageCount));
  if (!activeCount) return;

  if (classType.includes("imagebatchmulti")) {
    inputs.inputcount = activeCount;
    for (let index = 0; index < activeCount; index += 1) {
      inputs[`image_${index + 1}`] = [loadImageNodeIds[index], 0];
    }
    pruneNumberedInputs(inputs, /^image_(\d+)$/i, activeCount);
    return;
  }

  if (classType.includes("batchimagesnode")) {
    for (let index = 0; index < activeCount; index += 1) {
      inputs[`images.image${index}`] = [loadImageNodeIds[index], 0];
    }
    pruneNumberedInputs(inputs, /^images\.image(\d+)$/i, activeCount - 1);
  }
}

function pruneNumberedInputs(inputs: Record<string, any>, pattern: RegExp, maxIndex: number) {
  for (const key of Object.keys(inputs)) {
    const match = key.match(pattern);
    if (match && Number(match[1]) > maxIndex) {
      delete inputs[key];
    }
  }
}

function isLoadImageClass(classType: unknown) {
  return String(classType ?? "").toLowerCase().includes("loadimage");
}

function isImageBatchClass(classType: unknown) {
  const normalized = String(classType ?? "").toLowerCase();
  return normalized.includes("imagebatchmulti") || normalized.includes("batchimagesnode");
}

function isNumberedImageInput(lowerKey: string) {
  return /^image_\d+$/.test(lowerKey) || /^model\.images\.image_\d+$/.test(lowerKey);
}

function numberedReferenceImageInputIndex(lowerKey: string) {
  const match = lowerKey.match(/(?:^|\.)reference_images\.image_(\d+)$/);
  return match ? Number(match[1]) - 1 : undefined;
}

function isEditablePromptInput(lowerKey: string) {
  if (lowerKey.includes("negative")) return false;
  const leafKey = lowerKey.split(".").at(-1) ?? lowerKey;
  return ["prompt", "text", "positive", "positive_prompt", "prompt_text", "user_prompt"].includes(leafKey)
    || /^storyboard_\d+_prompt$/.test(leafKey);
}

function isDurationInput(lowerKey: string) {
  const leafKey = lowerKey.split(".").at(-1) ?? lowerKey;
  return ["duration", "duration_seconds", "video_duration", "length_seconds"].includes(leafKey)
    || /^storyboard_\d+_duration$/.test(leafKey)
    || (lowerKey.includes("duration") && lowerKey.includes("second"));
}

function isScalarInputValue(value: unknown) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function normalizeDurationSeconds(value: number | undefined, model: WorkflowModel) {
  const options = model.supportedDurations ?? [];
  if (!options.length) return undefined;
  if (typeof value === "number" && options.includes(value)) return value;

  const fallback = model.defaultDurationSeconds && options.includes(model.defaultDurationSeconds)
    ? model.defaultDurationSeconds
    : options[0];

  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return options.reduce((closest, option) => (
    Math.abs(option - value) < Math.abs(closest - value) ? option : closest
  ), fallback);
}

function injectDurationInput(
  inputs: Record<string, any>,
  classType: string,
  durationSeconds: number | undefined,
  objectInfo: Record<string, any>,
) {
  if (!durationSeconds) return;
  const durationKey = firstInputName(classType, objectInfo, ["duration", "duration_seconds", "video_duration", "length_seconds"]);
  if (durationKey) {
    inputs[durationKey] = durationSeconds;
  }

  if (inputs.model && typeof inputs.model === "object" && !Array.isArray(inputs.model)) {
    const required = ((inputs.model.inputs ??= {}).required ??= {});
    if ("duration" in required || classType.toLowerCase().includes("bytedance2")) {
      required.duration = durationSeconds;
    }
  }
}

function setNestedModelResolution(modelInput: Record<string, any>, label: string | undefined) {
  if (!label) return;
  const required = ((modelInput.inputs ??= {}).required ??= {});
  if ("resolution" in required) {
    required.resolution = resolutionWidgetLabel(label);
  }
}

function resolutionWidgetLabel(label: string) {
  const normalized = label.toLowerCase().replace(/\s+/g, "");
  if (normalized === "1k") return "1K";
  if (normalized === "2k") return "2K";
  if (normalized === "4k") return "4k";
  if (normalized === "720p") return "720p";
  return "1080p";
}

function directResolutionLabel(label: string) {
  const normalized = label.toLowerCase().replace(/\s+/g, "");
  if (normalized === "1k") return "1K";
  if (normalized === "2k") return "2K";
  if (normalized === "4k") return "4K";
  if (normalized === "720p") return "720p";
  return "1080p";
}

function firstInputName(classType: string, objectInfo: Record<string, any>, names: string[]) {
  const info = objectInfo[classType]?.input;
  const sections = [info?.required, info?.optional].filter(Boolean) as Array<Record<string, unknown>>;
  const available = new Set(sections.flatMap((section) => Object.keys(section)));
  return names.find((name) => available.has(name));
}

function sanitizeInputs(
  inputs: Record<string, any>,
  classType: string,
  projectName: string,
  objectInfo: Record<string, any>,
) {
  const specs = allInputSpecs(classType, objectInfo);
  for (const [name, spec] of Object.entries(specs)) {
    if (!(name in inputs)) {
      const defaultValue = defaultScalarInputValue(spec);
      if (spec.required && defaultValue !== undefined) {
        inputs[name] = defaultValue;
      }
      continue;
    }

    const lowerName = name.toLowerCase();
    if (lowerName.includes("project_name") && typeof inputs[name] === "string") {
      inputs[name] = coerceProjectName(projectName, classType, objectInfo);
      continue;
    }

    if (spec.inputType === "INT" || spec.inputType === "FLOAT") {
      const numericValue = typeof inputs[name] === "number" ? inputs[name] : Number(inputs[name]);
      inputs[name] = Number.isFinite(numericValue) ? numericValue : spec.defaultValue ?? 0;
      if (spec.inputType === "INT") inputs[name] = Math.trunc(inputs[name]);
      continue;
    }

    if (spec.inputType === "BOOLEAN") {
      if (inputs[name] === "" || inputs[name] == null) {
        inputs[name] = spec.defaultValue ?? false;
      } else if (typeof inputs[name] !== "boolean") {
        inputs[name] = inputs[name] === "true" || inputs[name] === true;
      }
    }
  }
}

function allInputSpecs(classType: string, objectInfo: Record<string, any>) {
  const info = objectInfo[classType]?.input;
  const sections = [
    { required: true, entries: info?.required },
    { required: false, entries: info?.optional },
  ].filter((section) => section.entries) as Array<{ required: boolean; entries: Record<string, unknown> }>;
  return Object.fromEntries(
    sections.flatMap((section) =>
      Object.entries(section.entries).map(([name, value]) => {
        const inputType = Array.isArray(value) ? value[0] : undefined;
        const options = Array.isArray(value) ? (value[1] as Record<string, unknown> | undefined) : undefined;
        return [name, { inputType, defaultValue: options?.default, options, required: section.required }];
      }),
    ),
  ) as Record<string, { inputType: unknown; defaultValue?: unknown; options?: Record<string, unknown>; required: boolean }>;
}

function defaultScalarInputValue(spec: { inputType: unknown; defaultValue?: unknown; options?: Record<string, unknown> }) {
  if (spec.defaultValue !== undefined) return spec.defaultValue;
  if (spec.inputType === "INT" || spec.inputType === "FLOAT") return 0;
  if (spec.inputType === "BOOLEAN") return false;
  if (spec.inputType === "COMBO" && Array.isArray(spec.options?.options)) return spec.options.options[0];
  return undefined;
}

function coerceProjectName(projectName: string, classType: string, objectInfo: Record<string, any>) {
  const config = objectInfo[classType]?.input?.required?.project_name?.[0];
  if (Array.isArray(config) && !config.includes(projectName)) {
    return config.includes("0000_base") ? "0000_base" : config[0];
  }
  return projectName;
}

function applyMappedInputs(
  nodeId: string,
  inputs: Record<string, any>,
  mapping: WorkflowInputMapping,
  request: CreateJobRequest,
  projectName: string,
  startFrame?: string,
  endFrame?: string,
) {
  if (mapping.promptNodeIds?.includes(nodeId) && request.prompt) setFirstStringInput(inputs, request.prompt, "text");
  if (mapping.imageInputNodeIds?.includes(nodeId) && request.inputImages?.[0]) setFirstStringInput(inputs, request.inputImages[0], "image");
  if (mapping.startFrameNodeIds?.includes(nodeId) && startFrame) setFirstStringInput(inputs, startFrame, "image");
  if (mapping.endFrameNodeIds?.includes(nodeId) && endFrame) setFirstStringInput(inputs, endFrame, "image");
  if (mapping.videoInputNodeIds?.includes(nodeId) && request.inputVideo) setFirstStringInput(inputs, request.inputVideo, "video");
  if (mapping.widthNodeIds?.includes(nodeId) && request.resolution) setNumberInput(inputs, request.resolution.width, "width");
  if (mapping.heightNodeIds?.includes(nodeId) && request.resolution) setNumberInput(inputs, request.resolution.height, "height");
  if (mapping.durationNodeIds?.includes(nodeId) && request.durationSeconds) setNumberInput(inputs, request.durationSeconds, "duration");
  if (mapping.seedNodeIds?.includes(nodeId)) setNumberInput(inputs, Math.floor(Math.random() * 1_000_000_000), "seed");
  if (mapping.projectNameNodeIds?.includes(nodeId)) setFirstStringInput(inputs, projectName, "project_name");
}

function setFirstStringInput(inputs: Record<string, any>, value: string, preferred: string) {
  const key = Object.keys(inputs).find((item) => item.toLowerCase().includes(preferred) && typeof inputs[item] === "string")
    ?? Object.keys(inputs).find((item) => typeof inputs[item] === "string")
    ?? preferred;
  inputs[key] = value;
}

function setNumberInput(inputs: Record<string, any>, value: number, preferred: string) {
  const key = Object.keys(inputs).find((item) => item.toLowerCase().includes(preferred) && typeof inputs[item] === "number") ?? preferred;
  inputs[key] = value;
}

async function readMappings() {
  const raw = await readJsonFile<Record<string, WorkflowInputMapping | unknown>>(workflowMappingsPath, {});
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith("_"))) as Record<string, WorkflowInputMapping>;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
