import type { UploadedImage } from "../types";
import { getStoredAuthToken } from "./backendApi";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const PROMPT_IMAGE_MAX_DIMENSION = 1536;
const PROMPT_IMAGE_TARGET_BYTES = 850 * 1024;
const PROMPT_IMAGE_MIN_DIMENSION = 960;
const PROMPT_IMAGE_INITIAL_QUALITY = 0.82;

type DescribeImageResponse = {
  text: string;
  model?: string;
  runpodJobId?: string;
  runpodStatus?: string;
  textArtifacts?: Array<{
    text: string;
    filename?: string;
    type?: string;
    source: string;
    url?: string;
  }>;
};

const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image clearly for an image editing workflow. Mention the main subject, environment, composition, lighting, colors, materials, style, visible text, and anything important to preserve.";

const VIDEO_ARCHVIZ_PROMPT =
  "Analyze the reference image and write a video-generation prompt using Momi ArchViz logic. Preserve building or subject identity, massing, proportions, facade/window rhythm, roof shape, materials, scale, site relationship, and color mood. Add realistic daylight, clean professional archviz style, natural camera motion, accurate perspective, and avoid redesign, distortion, fantasy details, or extra floors. Output only one clear paragraph.";

const KLING_VIDEO_PROMPT =
  "Analyze the reference image and write a detailed Kling video prompt. Preserve the original identity, massing, proportions, facade/window rhythm, roof shape, materials, scale, site relationship, and color mood. Add realistic daylight, clean archviz quality, accurate perspective, and natural cinematic camera motion. Output only the final prompt, with no title or explanation.";

const SEEDANCE_VIDEO_PROMPT = [
  "Analyze the reference image(s) and write a Seedance 2.0 video prompt.",
  "Use @image1, @image2, and so on as active reference tags in load order.",
  "Write only visible, measurable shot direction. Preserve identity, pose-critical details, lighting logic, materials, environment geometry, and continuity from the references.",
  "Use concise production blocks when useful: SCENE CONTEXT, ACTIVE REFERENCES, LOCATION MAP, FIRST FRAME / BLOCKING, FORMAT MODE, OPTICS, CAMERA, ACTION, PERFORMANCE, LIGHTING, STYLE, OUTPUT SETTINGS, POSITIVE LOCKS.",
  "If the user asks for multiple shots, specify the cut order or timing. Use positive phrasing only, FOV in degrees, and concrete camera movement. Return only the final Seedance prompt text, no title, no markdown fence, no explanation.",
].join(" ");

const VIDEO_SYSTEM_PROMPT =
  "You write concise production prompts for image-to-video and first/last-frame video models. Return only the final prompt text.";

const SEEDANCE_SYSTEM_PROMPT =
  "You write Seedance 2.0 prompts for production video generation. Return only the final Seedance prompt text.";

const IMPROVE_SYSTEM_PROMPT =
  "You improve creative generation prompts for production workflows. Return only the improved prompt text, no title, no bullets, no explanation.";

export async function describeUploadedImage(image: UploadedImage) {
  return describeUploadedImages([image]);
}

export async function describeUploadedImages(
  images: UploadedImage[],
  options: { mode?: "generic" | "video" | "klingVideo" | "seedanceVideo"; userPrompt?: string; cameraPrompt?: string } = {},
) {
  const usableImages = images.filter(Boolean).slice(0, 4);
  if (!usableImages.length) {
    throw new Error("Upload an image first.");
  }

  const imagesBase64 = await Promise.all(usableImages.map(uploadedImageToBase64));
  const mode = options.mode ?? "generic";
  const prompt = buildDescribePrompt({
    mode,
    userPrompt: options.userPrompt,
    cameraPrompt: options.cameraPrompt,
  });
  const systemPrompt = mode === "generic" ? undefined : mode === "seedanceVideo" ? SEEDANCE_SYSTEM_PROMPT : VIDEO_SYSTEM_PROMPT;
  const maxTokens = mode === "klingVideo" || mode === "seedanceVideo" ? 1200 : 512;

  const response = await promptFetch("/api/prompt/describe-image", {
    method: "POST",
    headers: authJsonHeaders(),
    credentials: "include",
    body: JSON.stringify({
      imageBase64: imagesBase64[0],
      imagesBase64,
      prompt,
      systemPrompt,
      maxTokens,
      temperature: 0.2,
    }),
  });

  const data = await response.json().catch(() => ({})) as Partial<DescribeImageResponse> & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || requestSizeError(response) || "Could not describe image.");
  }
  if (!data.text) {
    throw new Error("Description response did not include text.");
  }
  if (mode === "klingVideo") return cleanKlingPrompt(data.text);
  if (mode === "seedanceVideo") return cleanSeedancePrompt(data.text);
  return cleanParagraph(data.text);
}

export async function generateSeedancePromptWithWorkflow(
  images: UploadedImage[],
  options: { userPrompt: string },
) {
  const userPrompt = options.userPrompt.trim();
  if (!userPrompt) {
    throw new Error("Write the initial Seedance idea first.");
  }

  const usableImages = images.filter(Boolean).slice(0, 4);
  if (!usableImages.length) {
    throw new Error("Upload at least one reference image before generating a Seedance prompt.");
  }

  const imagesBase64 = await Promise.all(usableImages.map(uploadedImageToBase64));
  const response = await promptFetch("/api/prompt/seedance-workflow", {
    method: "POST",
    headers: authJsonHeaders(),
    credentials: "include",
    body: JSON.stringify({
      prompt: userPrompt,
      imageBase64: imagesBase64[0],
      imagesBase64,
    }),
  });

  const data = await response.json().catch(() => ({})) as Partial<DescribeImageResponse> & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || requestSizeError(response) || "Could not generate Seedance prompt.");
  }
  if (!data.text) {
    throw new Error("Seedance workflow response did not include generated prompt text.");
  }

  return cleanSeedancePrompt(data.text);
}

export async function generateKlingPromptWithWorkflow(
  images: UploadedImage[],
  options: { userPrompt: string; cameraPrompt?: string },
) {
  const userPrompt = options.userPrompt.trim();
  if (!userPrompt) {
    throw new Error("Write the initial Kling image-to-video idea first.");
  }

  const usableImages = images.filter(Boolean).slice(0, 4);
  if (!usableImages.length) {
    throw new Error("Upload at least one reference image before generating a Kling prompt.");
  }

  const imagesBase64 = await Promise.all(usableImages.map(uploadedImageToBase64));
  const response = await promptFetch("/api/prompt/kling-workflow", {
    method: "POST",
    headers: authJsonHeaders(),
    credentials: "include",
    body: JSON.stringify({
      prompt: userPrompt,
      cameraPrompt: options.cameraPrompt?.trim() || undefined,
      imageBase64: imagesBase64[0],
      imagesBase64,
    }),
  });

  const data = await response.json().catch(() => ({})) as Partial<DescribeImageResponse> & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || requestSizeError(response) || responseStatusError(response) || "Could not generate Kling prompt.");
  }
  if (!data.text) {
    throw new Error("Kling workflow response did not include generated prompt text.");
  }

  return cleanKlingPrompt(data.text);
}

export async function improvePromptWithQwen({
  text,
  images = [],
  mode,
  cameraPrompt,
}: {
  text: string;
  images?: UploadedImage[];
  mode: "imageEditing" | "video" | "klingVideo" | "seedanceVideo";
  cameraPrompt?: string;
}) {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error("Write a prompt first.");
  }

  const usableImages = images.filter(Boolean).slice(0, 4);
  const imagesBase64 = usableImages.length ? await Promise.all(usableImages.map(uploadedImageToBase64)) : [];
  const prompt = buildImprovePrompt({
    mode,
    text: trimmedText,
    cameraPrompt,
    hasImages: imagesBase64.length > 0,
  });

  const response = await promptFetch("/api/prompt/improve", {
    method: "POST",
    headers: authJsonHeaders(),
    credentials: "include",
    body: JSON.stringify({
      prompt,
      imageBase64: imagesBase64[0],
      imagesBase64: imagesBase64.length ? imagesBase64 : undefined,
      systemPrompt: mode === "seedanceVideo" ? SEEDANCE_SYSTEM_PROMPT : IMPROVE_SYSTEM_PROMPT,
      maxTokens: mode === "klingVideo" || mode === "seedanceVideo" ? 1200 : 600,
      temperature: 0.2,
    }),
  });

  const data = await response.json().catch(() => ({})) as Partial<DescribeImageResponse> & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || requestSizeError(response) || "Could not improve prompt.");
  }
  if (!data.text) {
    throw new Error("Improve response did not include text.");
  }

  if (mode === "klingVideo") return cleanKlingPrompt(data.text);
  if (mode === "seedanceVideo") return cleanSeedancePrompt(data.text);
  return cleanParagraph(data.text);
}

function authJsonHeaders() {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = getStoredAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

async function promptFetch(path: string, init: RequestInit) {
  const attempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(`${API_BASE}${path}`, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(650 * attempt);
      }
    }
  }

  throw new Error(
    lastError instanceof Error && lastError.message
      ? `Could not reach the prompt backend. The backend may still be restarting. ${lastError.message}`
      : "Could not reach the prompt backend. The backend may still be restarting.",
  );
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function uploadedImageToBase64(image: UploadedImage) {
  const source = image.croppedUrl ?? image.url;
  const blob = await fetch(source).then((response) => {
    if (!response.ok) throw new Error("Could not read uploaded image.");
    return response.blob();
  }).catch((error) => {
    throw new Error(error instanceof Error && error.message
      ? `Could not read uploaded image. ${error.message}`
      : "Could not read uploaded image.");
  });

  const promptBlob = await compressImageForPrompt(blob).catch(() => blob);
  return blobToDataUrl(promptBlob);
}

async function compressImageForPrompt(blob: Blob) {
  if (!blob.type.startsWith("image/")) return blob;

  const decoded = await decodeImageBlob(blob);
  try {
    const largestSide = Math.max(decoded.width, decoded.height);
    if (!largestSide) return blob;

    let maxDimension = Math.min(PROMPT_IMAGE_MAX_DIMENSION, largestSide);
    let quality = PROMPT_IMAGE_INITIAL_QUALITY;
    let best: Blob | undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const next = await renderPromptImage(decoded.source, decoded.width, decoded.height, maxDimension, quality);
      if (!next) break;

      if (!best || next.size < best.size) {
        best = next;
      }
      if (next.size <= PROMPT_IMAGE_TARGET_BYTES) {
        return next;
      }

      if (quality > 0.64) {
        quality = Math.max(0.64, quality - 0.08);
      } else {
        maxDimension = Math.max(PROMPT_IMAGE_MIN_DIMENSION, Math.round(maxDimension * 0.82));
      }
    }

    return best && (best.size < blob.size || blob.size > PROMPT_IMAGE_TARGET_BYTES) ? best : blob;
  } finally {
    decoded.close();
  }
}

async function decodeImageBlob(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Fall back to an HTMLImageElement below.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const element = new Image();
  element.decoding = "async";
  element.src = objectUrl;
  await new Promise<void>((resolve, reject) => {
    element.onload = () => resolve();
    element.onerror = () => reject(new Error("Could not decode uploaded image."));
  });

  return {
    source: element,
    width: element.naturalWidth,
    height: element.naturalHeight,
    close: () => URL.revokeObjectURL(objectUrl),
  };
}

async function renderPromptImage(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, maxDimension: number, quality: number) {
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return undefined;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);

  return new Promise<Blob | undefined>((resolve) => {
    canvas.toBlob((next) => resolve(next ?? undefined), "image/jpeg", quality);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not convert image to base64."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

function requestSizeError(response: Response) {
  return response.status === 413
    ? "The reference image payload was too large. The app now compresses prompt-reference images, so try generating the prompt again."
    : "";
}

function responseStatusError(response: Response) {
  return response.status ? `${response.status} ${response.statusText || "Request failed"}` : "";
}

function cleanParagraph(value: string) {
  return value
    .replace(/^\s*(prompt|image description|description)\s*:\s*/i, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanKlingPrompt(value: string) {
  return cleanParagraph(stripCodeFence(value)).replace(/^\s*(kling prompt|prompt)\s*:\s*/i, "");
}

function cleanSeedancePrompt(value: string) {
  return stripCodeFence(value)
    .replace(/^\s*(seedance prompt|prompt)\s*:\s*/i, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCodeFence(value: string) {
  return value
    .replace(/^\s*```(?:[a-zA-Z0-9_-]+)?\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function buildDescribePrompt({
  mode,
  userPrompt,
  cameraPrompt,
}: {
  mode: "generic" | "video" | "klingVideo" | "seedanceVideo";
  userPrompt?: string;
  cameraPrompt?: string;
}) {
  if (mode === "generic") {
    return IMAGE_DESCRIPTION_PROMPT;
  }

  const base = mode === "klingVideo"
    ? KLING_VIDEO_PROMPT
    : mode === "seedanceVideo"
      ? SEEDANCE_VIDEO_PROMPT
      : VIDEO_ARCHVIZ_PROMPT;
  const context = [
    userPrompt?.trim() ? `User prompt: ${userPrompt.trim()}` : "",
    cameraPrompt?.trim() ? `Camera movement instruction to blend naturally: ${cameraPrompt.trim()}` : "",
  ].filter(Boolean).join("\n");

  return context ? `${base}\n\n${context}` : base;
}

function buildImprovePrompt({
  mode,
  text,
  cameraPrompt,
  hasImages,
}: {
  mode: "imageEditing" | "video" | "klingVideo" | "seedanceVideo";
  text: string;
  cameraPrompt?: string;
  hasImages: boolean;
}) {
  if (mode === "imageEditing") {
    return [
      "Improve this image-editing prompt for an instruction-based image model.",
      "Make it clearer, more structured, and more production-ready while preserving the user's intent.",
      "Keep it concise and actionable. Return only the improved prompt.",
      `Current prompt: ${text}`,
    ].join("\n");
  }

  const maxRule = mode === "klingVideo"
    ? "Improve and enhance the prompt with all useful visual, motion, timing, camera, and continuity details. Do not shorten it to a character limit."
    : mode === "seedanceVideo"
      ? "Rewrite as a Seedance 2.0 prompt with useful production blocks and preserved reference identity. Return only the final prompt text."
      : "Keep the final prompt as one clear production paragraph.";

  return [
    "Improve this video-generation prompt using the reference image when available.",
    "Blend the user's intent with the selected camera movement naturally.",
    "Preserve subject/building identity, proportions, materials, lighting logic, perspective, and scene continuity.",
    maxRule,
    hasImages ? "Use the uploaded image as visual reference." : "",
    `Current prompt: ${text}`,
    cameraPrompt?.trim() ? `Camera movement instruction: ${cameraPrompt.trim()}` : "",
    "Return only the improved prompt.",
  ].filter(Boolean).join("\n");
}
