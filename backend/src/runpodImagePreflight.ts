import sharp from "sharp";

import { resolveAllowedExistingMediaPath } from "./mediaPathPolicy.js";
import { parseImageDataUrl } from "./runpodImageInlineService.js";
import { localMediaFilePathFromUrl } from "./jobQueue/providerInputs.js";

const KLING_MIN_FRAME_DIMENSION = 300;
const KLING_MIN_ASPECT_RATIO = 0.4;
const KLING_MAX_ASPECT_RATIO = 2.5;

export async function validateRunpodImageRequirements(workflow: unknown, imageInputs: string[]) {
  if (!hasNodeType(workflow, "KlingFirstLastFrameNode")) return;

  const frames = imageInputs.slice(0, 2);
  if (frames.length < 2) {
    throw new Error("Kling first-last-frame generation requires both a first frame and a last frame.");
  }

  for (let index = 0; index < frames.length; index += 1) {
    const source = await inspectableImageSource(frames[index], index);
    const metadata = await sharp(source, { limitInputPixels: false }).metadata().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "unknown image decoding error";
      throw new Error(`Could not inspect the Kling ${frameLabel(index)} before RunPod submission: ${reason}`);
    });
    const dimensions = displayDimensions(metadata);
    if (!dimensions) {
      throw new Error(`Could not determine the Kling ${frameLabel(index)} dimensions before RunPod submission.`);
    }
    const { width, height } = dimensions;
    if (width < KLING_MIN_FRAME_DIMENSION || height < KLING_MIN_FRAME_DIMENSION) {
      throw new Error(
        `Kling ${frameLabel(index)} must be at least ${KLING_MIN_FRAME_DIMENSION}px wide and high; received ${width}x${height}px. Resize or upscale the image and try again. The task was not sent to RunPod.`,
      );
    }

    const aspectRatio = width / height;
    if (aspectRatio < KLING_MIN_ASPECT_RATIO || aspectRatio > KLING_MAX_ASPECT_RATIO) {
      throw new Error(
        `Kling ${frameLabel(index)} aspect ratio must be between 0.40 and 2.50 (width divided by height); received ${formatAspectRatio(aspectRatio)} from ${width}x${height}px. Crop or extend the image and try again. The task was not sent to RunPod.`,
      );
    }
  }
}

function hasNodeType(workflow: unknown, classType: string) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return false;
  return Object.values(workflow).some((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    return (node as { class_type?: unknown }).class_type === classType;
  });
}

async function inspectableImageSource(value: string, index: number): Promise<string | Buffer> {
  const parsed = parseImageDataUrl(value);
  if (parsed) return parsed.buffer;

  const localPath = localMediaFilePathFromUrl(value);
  if (localPath) {
    const safePath = await resolveAllowedExistingMediaPath(localPath);
    if (safePath) return safePath;
  }

  if (/^https?:\/\//i.test(value)) {
    throw new Error(
      `The Kling ${frameLabel(index)} uses a remote URL, so its dimensions cannot be verified safely before submission. Upload or save the image in the project and try again. The task was not sent to RunPod.`,
    );
  }

  throw new Error(`The Kling ${frameLabel(index)} could not be inspected before RunPod submission.`);
}

function displayDimensions(metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>) {
  if (!metadata.width || !metadata.height) return undefined;
  const swapsAxes = metadata.orientation != null && metadata.orientation >= 5 && metadata.orientation <= 8;
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function formatAspectRatio(value: number) {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function frameLabel(index: number) {
  return index === 0 ? "first frame" : "last frame";
}
