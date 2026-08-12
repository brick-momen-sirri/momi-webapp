// Turning a Still Images job's input media into what its graph actually needs.
//
// Deliberately separate from materializeRunpodInputImages rather than another
// branch inside it. The Animation materializer is correct for Animation and three
// of its behaviours are wrong here:
//
//   1. It derives destination filenames from the graph's own LoadImage values via
//      detectWorkflowLoadImageNames. qwen-edit.json was exported with nodes 121 and
//      165 both holding "0001 (1).png", so two slots would resolve to one name and
//      one image would be silently dropped.
//   2. It finds image nodes by class-name substring. That matches
//      ETN_LoadImageBase64, and it picks up general-enhancement.json's node 81,
//      which is in the disconnected drawn-mask branch.
//   3. It prefers a signed URL for anything large enough. A URL cannot be written
//      into a base64 node -- the graph would receive a string that is not image
//      data and fail deep inside ComfyUI.
//
// So slots come from the preset's explicit bindings, and base64 presets are never
// allowed to degrade to a URL.

import fs from "node:fs/promises";

import { runpodRequestBodyMaxBytes } from "../config.js";
import { resolveAllowedExistingMediaPath } from "../mediaPathPolicy.js";
import type { RunpodComfyImageInput } from "../runpodComfyService.js";
import { parseImageDataUrl, prepareRunpodInlineImageInput, runpodInlineImageByteBudget } from "../runpodImageInlineService.js";
import { createRunpodInputUrl } from "../runpodInputUrlService.js";
import { stillImageInputBindings, type StillImageInputBinding } from "../stillImageWorkflow.js";
import type { StillImageCategoryId } from "../stillImageCategories.js";
import { localMediaFilePathFromUrl, mimeTypeFromMediaPath } from "./providerInputs.js";

export const STILL_IMAGE_INLINE_TOO_LARGE_MESSAGE =
  "This Still Images workflow requires inline image data, but the image is too large for the RunPod request limit. Please use a smaller image.";

export type StillImageMaterializedInputs = {
  /**
   * One value per slot, in slot order, ready to be written into the bound node:
   * raw base64 for base64 slots, the deterministic filename for load-image slots.
   */
  graphValues: string[];
  /**
   * RunPod payload `images[]`. Empty for base64 presets, whose bytes travel inside
   * the graph instead.
   */
  payloadImages: RunpodComfyImageInput[];
};

/**
 * Reserved for the graph itself and the JSON envelope around the base64 blobs.
 *
 * runpodInlineImageByteBudget already reserves a share of the request body, but it
 * reserves it for a payload where images sit in `images[]` next to a small graph.
 * A base64 preset inverts that: the blobs are inside a graph that is itself tens of
 * kilobytes. This is the second, whole-request check the size policy calls for.
 */
const stillImageGraphReserveBytes = 512 * 1024;

export async function materializeStillImageInputs(options: {
  categoryId: StillImageCategoryId;
  imageCount: number;
  inputImages: string[];
}): Promise<StillImageMaterializedInputs> {
  const bindings = stillImageInputBindings(options.categoryId, options.imageCount);
  if (options.inputImages.length !== bindings.length) {
    throw new Error(
      `Still image preset ${options.categoryId} needs ${bindings.length} input image(s); the job carries ${options.inputImages.length}.`,
    );
  }

  const perSlotBudget = runpodInlineImageByteBudget(bindings.length);
  const graphValues: string[] = [];
  const payloadImages: RunpodComfyImageInput[] = [];
  const inlineValues: string[] = [];

  for (const binding of bindings) {
    const source = options.inputImages[binding.slot - 1];
    if (!source) {
      throw new Error(`Still image preset ${options.categoryId} has no media for slot ${binding.slot}.`);
    }

    if (binding.mode === "base64") {
      const base64 = await inlineBase64Slot(source, binding, perSlotBudget);
      graphValues.push(base64);
      inlineValues.push(base64);
      continue;
    }

    const materialized = await loadImageSlot(source, binding, perSlotBudget);
    graphValues.push(materialized.name);
    payloadImages.push(materialized);
  }

  assertPayloadNamesUnique(payloadImages, options.categoryId);
  assertInlineGraphBudget(inlineValues, options.categoryId);
  return { graphValues, payloadImages };
}

/**
 * Read a slot's bytes, compress if the existing pipeline can get it under budget,
 * and hand back raw base64.
 *
 * No URL branch exists here by design. The order is the one the size policy
 * requires: resolve safely, compress with the validated helper, then check the
 * encoded result against the request budget.
 */
async function inlineBase64Slot(source: string, binding: StillImageInputBinding, maxBytes: number) {
  const resolved = await readSlotBytes(source, binding);

  let prepared;
  try {
    prepared = await prepareRunpodInlineImageInput({
      buffer: resolved.buffer,
      mimeType: resolved.mimeType,
      name: `slot_${binding.slot}`,
      source: resolved.source,
      maxBytes,
    });
  } catch (error) {
    // prepareRunpodInlineImageInput ends its message by advising that
    // RUNPOD_INPUT_BASE_URL be configured so the bytes can travel as a signed URL.
    // That is sound advice for Animation and useless here -- a base64 node cannot
    // take a URL -- so the message is rebuilt from numbers known at this call site
    // rather than forwarded. The compressed-size hint is genuinely useful for
    // support, so it is lifted across if present.
    const detail = error instanceof Error ? error.message : "";
    const compressedHint = detail.match(/The smallest compressed fallback was [^.]+\./)?.[0];
    throw new Error(
      `${STILL_IMAGE_INLINE_TOO_LARGE_MESSAGE} Slot ${binding.slot} is ${formatBytes(resolved.buffer.byteLength)}, ` +
        `above the ${formatBytes(maxBytes)} inline budget for this preset.${compressedHint ? ` ${compressedHint}` : ""}`,
    );
  }

  const base64 = stripDataUrlPrefix(prepared.image);
  if (!base64) {
    throw new Error(`Still image slot ${binding.slot} produced no inline image data.`);
  }
  return base64;
}

async function loadImageSlot(
  source: string,
  binding: Extract<StillImageInputBinding, { mode: "load-image" }>,
  maxBytes: number,
): Promise<RunpodComfyImageInput> {
  // A signed URL is fine for these: the worker downloads it and saves it under the
  // name the graph expects, so the deterministic name still governs routing.
  const filePath = localMediaFilePathFromUrl(source);
  if (filePath) {
    const safePath = await requireAllowedMediaPath(filePath);
    const signedUrl = createRunpodInputUrl(safePath, "image");
    if (signedUrl) return { name: binding.filename, url: signedUrl };
  }

  const resolved = await readSlotBytes(source, binding);
  const prepared = await prepareRunpodInlineImageInput({
    buffer: resolved.buffer,
    mimeType: resolved.mimeType,
    name: binding.filename,
    source: resolved.source,
    maxBytes,
  });

  // Compression can change the extension, and the payload name and the graph value
  // have to agree or the worker saves a file the graph never looks for.
  return { name: prepared.name, image: prepared.image };
}

async function readSlotBytes(source: string, binding: StillImageInputBinding) {
  if (source.startsWith("data:image/")) {
    const parsed = parseImageDataUrl(source);
    if (!parsed) throw new Error(`Still image slot ${binding.slot} has an unsupported image data URL.`);
    return { buffer: parsed.buffer, mimeType: parsed.mimeType, source: `slot_${binding.slot}` };
  }

  const filePath = localMediaFilePathFromUrl(source);
  if (filePath) {
    const safePath = await requireAllowedMediaPath(filePath);
    return {
      buffer: await fs.readFile(safePath),
      mimeType: mimeTypeFromMediaPath(safePath, "image"),
      source: safePath,
    };
  }

  // Remote URLs are refused rather than fetched. A base64 node needs the bytes, and
  // silently reaching out to an arbitrary host during dispatch is not something to
  // add here.
  throw new Error(
    `Still image slot ${binding.slot} must be saved project media or an uploaded image; remote URLs cannot be inlined.`,
  );
}

async function requireAllowedMediaPath(filePath: string) {
  const resolved = await resolveAllowedExistingMediaPath(filePath);
  if (!resolved) {
    throw new Error("Local media path is missing or outside allowed media roots.");
  }
  return resolved;
}

function stripDataUrlPrefix(value: string) {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}

/**
 * Two slots resolving to one filename means the worker writes one file and a slot
 * reads an image it was never given. Cheap to assert, and the exported graph's
 * duplicate values are exactly this bug.
 */
function assertPayloadNamesUnique(payloadImages: RunpodComfyImageInput[], categoryId: string) {
  const names = payloadImages.map((image) => image.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error(`Still image preset ${categoryId} resolved two input slots to the same filename: ${names.join(", ")}.`);
  }
}

function assertInlineGraphBudget(graphValues: string[], categoryId: string) {
  const inlineBytes = graphValues.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  const ceiling = runpodRequestBodyMaxBytes - stillImageGraphReserveBytes;
  if (inlineBytes > ceiling) {
    throw new Error(
      `${STILL_IMAGE_INLINE_TOO_LARGE_MESSAGE} (${categoryId} inline data is ${formatBytes(inlineBytes)}, above the ${formatBytes(ceiling)} request budget)`,
    );
  }
}

function formatBytes(value: number) {
  // KiB below a megabyte: these budgets are configurable down to a few hundred
  // bytes, and "0.00MiB" tells an operator nothing.
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))}KiB`;
  const mib = value / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`;
}
