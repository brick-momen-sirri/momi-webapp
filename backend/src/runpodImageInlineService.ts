import path from "node:path";
import sharp from "sharp";
import {
  runpodInlineImageAutoCompress,
  runpodInlineImageMaxDimension,
  runpodInlineImageMinQuality,
  runpodInlineMediaMaxBytes,
  runpodInputBaseUrl,
  runpodRequestBodyMaxBytes,
} from "./config.js";

const requestBodyReserveBytes = 2 * 1024 * 1024;
const minInlineImageBudgetBytes = 256 * 1024;

export type RunpodInlineImageInput = {
  name: string;
  image: string;
  byteLength: number;
  compressed: boolean;
};

export function runpodInlineImageByteBudget(inputCount: number) {
  const count = Math.max(1, Math.floor(inputCount) || 1);
  const reserve = Math.min(requestBodyReserveBytes, Math.floor(runpodRequestBodyMaxBytes * 0.25));
  const availableBodyBytes = Math.max(minInlineImageBudgetBytes, runpodRequestBodyMaxBytes - reserve);
  const perInputRawBytes = Math.floor((availableBodyBytes * 3) / 4 / count);
  return Math.min(runpodInlineMediaMaxBytes, Math.max(1, perInputRawBytes));
}

export async function prepareRunpodInlineImageInput(options: {
  buffer: Buffer;
  mimeType: string;
  name: string;
  source: string;
  maxBytes: number;
}): Promise<RunpodInlineImageInput> {
  const normalizedMimeType = normalizeImageMimeType(options.mimeType);
  if (options.buffer.byteLength <= options.maxBytes) {
    return {
      name: options.name,
      image: dataUrl(normalizedMimeType, options.buffer),
      byteLength: options.buffer.byteLength,
      compressed: false,
    };
  }

  if (!runpodInlineImageAutoCompress) {
    throwRunpodInlineImageTooLarge(options.buffer.byteLength, options.maxBytes, options.source);
  }

  const compressed = await compressImageForInlineJson(options.buffer, options.maxBytes, options.source);
  return {
    name: replaceImageExtension(options.name, compressed.extension),
    image: dataUrl(compressed.mimeType, compressed.buffer),
    byteLength: compressed.buffer.byteLength,
    compressed: true,
  };
}

export function parseImageDataUrl(value: string) {
  const match = value.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/);
  if (!match) return undefined;
  const subtype = match[1].toLowerCase();
  return {
    mimeType: `image/${subtype}`,
    buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

async function compressImageForInlineJson(buffer: Buffer, maxBytes: number, source: string) {
  const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
  const format = metadata.hasAlpha ? "webp" : "jpeg";
  const mimeType = format === "webp" ? "image/webp" : "image/jpeg";
  const extension = format === "webp" ? ".webp" : ".jpg";
  const originalLongestSide = Math.max(metadata.width ?? runpodInlineImageMaxDimension, metadata.height ?? runpodInlineImageMaxDimension, 1);
  let longestSide = Math.min(originalLongestSide, runpodInlineImageMaxDimension);
  let best: Buffer | undefined;

  while (longestSide >= 256) {
    for (const quality of qualitySteps()) {
      const encoded = await encodeImage(buffer, format, Math.floor(longestSide), quality);
      if (!best || encoded.byteLength < best.byteLength) best = encoded;
      if (encoded.byteLength <= maxBytes) {
        return { buffer: encoded, mimeType, extension };
      }
    }

    longestSide *= 0.72;
  }

  // Every candidate that fit maxBytes returned inside the loop, so `best` can
  // only be over budget here; it is kept for the error's compressed-size hint.
  throwRunpodInlineImageTooLarge(buffer.byteLength, maxBytes, source, best?.byteLength);
}

async function encodeImage(buffer: Buffer, format: "jpeg" | "webp", longestSide: number, quality: number) {
  const pipeline = sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({
      width: longestSide,
      height: longestSide,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (format === "webp") {
    return pipeline.webp({ quality, effort: 4 }).toBuffer();
  }

  return pipeline
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

function qualitySteps() {
  const preferred = [92, 86, 80, 74, 68, 62, 56, 50, 44, 38, 32, 26, 20];
  return preferred.filter((quality) => quality >= runpodInlineImageMinQuality);
}

function normalizeImageMimeType(value: string) {
  const lower = value.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower.startsWith("image/")) return lower;
  return "image/png";
}

function replaceImageExtension(name: string, extension: string) {
  const current = path.extname(name);
  const base = current ? name.slice(0, -current.length) : name;
  return `${base || "input"}${extension}`;
}

function dataUrl(mimeType: string, buffer: Buffer) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function throwRunpodInlineImageTooLarge(originalBytes: number, maxBytes: number, source: string, compressedBytes?: number): never {
  const sourceName = path.basename(source) || "image input";
  const compressedHint = compressedBytes
    ? ` The smallest compressed fallback was ${formatBytes(compressedBytes)}.`
    : "";
  const baseUrlHint = runpodInputBaseUrl
    ? "The input could not be sent as a signed file URL, and image compression was not enough."
    : "Set RUNPOD_INPUT_BASE_URL to a public URL for this backend so RunPod can download the original file bytes without inline JSON.";

  throw new Error(
    `RunPod image input "${sourceName}" is ${formatBytes(originalBytes)}, above the inline ${formatBytes(maxBytes)} budget.${compressedHint} ${baseUrlHint}`,
  );
}

function formatBytes(value: number) {
  const mib = value / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`;
}
