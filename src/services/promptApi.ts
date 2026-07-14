import type { UploadedImage } from "../types";
import { getStoredAuthToken } from "./backendApi";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

type DescribeImageResponse = {
  text: string;
  model?: string;
  runpodJobId?: string;
  runpodStatus?: string;
};

const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image clearly for an image editing workflow. Mention the main subject, environment, composition, lighting, colors, materials, style, visible text, and anything important to preserve.";

const VIDEO_ARCHVIZ_PROMPT =
  "Analyze the reference image and write a video-generation prompt using Momi ArchViz logic. Preserve building or subject identity, massing, proportions, facade/window rhythm, roof shape, materials, scale, site relationship, and color mood. Add realistic daylight, clean professional archviz style, natural camera motion, accurate perspective, and avoid redesign, distortion, fantasy details, or extra floors. Output only one clear paragraph.";

const KLING_VIDEO_PROMPT =
  "Analyze the reference image and write a Kling video prompt. Preserve the original identity, massing, proportions, facade/window rhythm, roof shape, materials, scale, site relationship, and color mood. Add realistic daylight, clean archviz quality, accurate perspective, and natural cinematic camera motion. Output only the final prompt as one paragraph, maximum 350 characters, no title, no bullets, no explanation.";

const VIDEO_SYSTEM_PROMPT =
  "You write concise production prompts for image-to-video and first/last-frame video models. Return only the final prompt text.";

const IMPROVE_SYSTEM_PROMPT =
  "You improve creative generation prompts for production workflows. Return only the improved prompt text, no title, no bullets, no explanation.";

export async function describeUploadedImage(image: UploadedImage) {
  return describeUploadedImages([image]);
}

export async function describeUploadedImages(
  images: UploadedImage[],
  options: { mode?: "generic" | "video" | "klingVideo"; userPrompt?: string; cameraPrompt?: string } = {},
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
  const systemPrompt = mode === "generic" ? undefined : VIDEO_SYSTEM_PROMPT;
  const maxTokens = mode === "klingVideo" ? 140 : 512;

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
    throw new Error(data.error || "Could not describe image.");
  }
  if (!data.text) {
    throw new Error("Description response did not include text.");
  }
  return mode === "klingVideo" ? cleanKlingPrompt(data.text) : cleanParagraph(data.text);
}

export async function improvePromptWithQwen({
  text,
  images = [],
  mode,
  cameraPrompt,
}: {
  text: string;
  images?: UploadedImage[];
  mode: "imageEditing" | "video" | "klingVideo";
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
      systemPrompt: IMPROVE_SYSTEM_PROMPT,
      maxTokens: mode === "klingVideo" ? 160 : 600,
      temperature: 0.2,
    }),
  });

  const data = await response.json().catch(() => ({})) as Partial<DescribeImageResponse> & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || "Could not improve prompt.");
  }
  if (!data.text) {
    throw new Error("Improve response did not include text.");
  }

  return mode === "klingVideo" ? cleanKlingPrompt(data.text) : cleanParagraph(data.text);
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

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not convert image to base64."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",", 2)[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

function cleanParagraph(value: string) {
  return value
    .replace(/^\s*(prompt|image description|description)\s*:\s*/i, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanKlingPrompt(value: string) {
  const cleaned = cleanParagraph(value);
  if (cleaned.length <= 350) {
    return cleaned;
  }

  const clipped = cleaned.slice(0, 350);
  const sentenceEnd = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf(";"), clipped.lastIndexOf(","));
  return (sentenceEnd > 240 ? clipped.slice(0, sentenceEnd) : clipped).trim().replace(/[.,;:]+$/, "");
}

function buildDescribePrompt({
  mode,
  userPrompt,
  cameraPrompt,
}: {
  mode: "generic" | "video" | "klingVideo";
  userPrompt?: string;
  cameraPrompt?: string;
}) {
  if (mode === "generic") {
    return IMAGE_DESCRIPTION_PROMPT;
  }

  const base = mode === "klingVideo" ? KLING_VIDEO_PROMPT : VIDEO_ARCHVIZ_PROMPT;
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
  mode: "imageEditing" | "video" | "klingVideo";
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
    ? "Keep the final prompt as one paragraph under 350 characters."
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
