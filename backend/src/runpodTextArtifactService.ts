import { runpodTextOutputMaxBytes } from "./config.js";

export type RunpodTextArtifact = {
  text: string;
  filename?: string;
  type?: string;
  source: string;
  url?: string;
};

type TextCandidate = {
  filename?: string;
  type?: string;
  source: string;
  url?: string;
  inlineText?: string;
};

const textExtensions = new Set([".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".log"]);
const textSourceKeys = new Set([
  "text",
  "texts",
  "prompt",
  "prompts",
  "generated_prompt",
  "generatedprompt",
  "generated_text",
  "generatedtext",
  "caption",
  "captions",
  "description",
  "descriptions",
  "string",
]);
const candidateContainerKeys = new Set([
  "artifacts",
  "files",
  "outputs",
  "output",
  "result",
  "results",
  "text",
  "texts",
  "prompt",
  "prompts",
  "generated_prompt",
  "generatedPrompt",
  "generated_text",
  "generatedText",
  "ui",
  "string",
]);

export async function extractRunpodTextArtifacts(output: unknown, fetchImpl: typeof fetch = fetch): Promise<RunpodTextArtifact[]> {
  const collectedCandidates = collectTextCandidates(output);
  const preferredInlineCandidates = collectedCandidates.filter(isPreferredInlineTextCandidate);
  const candidates = (preferredInlineCandidates.length ? preferredInlineCandidates : collectedCandidates)
    .sort((a, b) => textCandidatePriority(a) - textCandidatePriority(b));
  const artifacts: RunpodTextArtifact[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = textCandidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    const text = await readTextCandidate(candidate, fetchImpl).catch(() => undefined);
    if (!text?.trim()) continue;

    artifacts.push({
      text: normalizeText(text),
      filename: candidate.filename,
      type: candidate.type,
      source: candidate.source,
      url: candidate.url,
    });
  }

  return artifacts;
}

export function combinedTextArtifactContent(artifacts: RunpodTextArtifact[]) {
  const preferred = artifacts.some((artifact) => isPreferredInlineTextArtifact(artifact))
    ? artifacts.filter((artifact) => isPreferredInlineTextArtifact(artifact))
    : artifacts;

  return preferred
    .map((artifact) => artifact.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function isRunpodTextOutputItem(item: unknown, source: string) {
  return Boolean(textCandidateFromItem(item, source));
}

function collectTextCandidates(value: unknown, source = "output", depth = 0): TextCandidate[] {
  if (depth > 5) return [];

  const direct = textCandidateFromItem(value, source);
  if (direct) return [direct];

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextCandidates(item, source, depth + 1));
  }

  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => {
    if (!candidateContainerKeys.has(key) && !(source === "outputs" && /^\d+$/.test(key))) return [];
    return collectTextCandidates(child, key, depth + 1);
  });
}

function textCandidateFromItem(item: unknown, source: string): TextCandidate | undefined {
  if (typeof item === "string") {
    const url = itemLooksLikeReadableUrl(item) ? item.trim() : undefined;
    const candidate = {
      source,
      url,
      filename: filenameFromValue(url),
      inlineText: url ? undefined : item,
    };
    return candidateLooksLikeText(candidate) ? candidate : undefined;
  }

  if (!isRecord(item)) return undefined;

  const data = stringFrom(item.data);
  const url =
    stringFrom(item.url) ??
    stringFrom(item.href) ??
    stringFrom(item.s3_url) ??
    stringFrom(item.download_url) ??
    stringFrom(item.file) ??
    stringFrom(item.path) ??
    (data && itemLooksLikeReadableUrl(data) ? data : undefined);
  const filename =
    stringFrom(item.filename) ??
    stringFrom(item.file_name) ??
    stringFrom(item.name) ??
    filenameFromValue(url);
  const type =
    stringFrom(item.content_type) ??
    stringFrom(item.contentType) ??
    stringFrom(item.mime_type) ??
    stringFrom(item.mimeType) ??
    stringFrom(item.type);

  let inlineText =
    stringFrom(item.text) ??
    stringFrom(item.content) ??
    stringFrom(item.prompt) ??
    stringFrom(item.generated_prompt) ??
    stringFrom(item.generatedPrompt) ??
    stringFrom(item.generated_text) ??
    stringFrom(item.generatedText) ??
    stringFrom(item.caption) ??
    stringFrom(item.description) ??
    stringFrom(item.string);

  const candidate = { source, filename, type, url, inlineText };
  if (!candidateLooksLikeText(candidate)) return undefined;

  if (!inlineText && data && !itemLooksLikeReadableUrl(data)) {
    inlineText = data;
  }

  return { source, filename, type, url, inlineText };
}

function candidateLooksLikeText(candidate: TextCandidate) {
  return isTextSource(candidate.source)
    || hasTextExtension(candidate.filename)
    || hasTextContentType(candidate.type)
    || hasTextUrl(candidate.url);
}

async function readTextCandidate(candidate: TextCandidate, fetchImpl: typeof fetch) {
  if (candidate.inlineText?.trim()) {
    return candidate.inlineText;
  }

  if (!candidate.url) return undefined;
  if (candidate.url.startsWith("data:")) {
    return readTextDataUrl(candidate.url);
  }
  if (!/^https?:\/\//i.test(candidate.url)) {
    return undefined;
  }

  const response = await fetchImpl(candidate.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`Could not read RunPod text artifact: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > runpodTextOutputMaxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("RunPod text artifact is larger than the configured text limit.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > runpodTextOutputMaxBytes) {
    throw new Error("RunPod text artifact is larger than the configured text limit.");
  }

  return buffer.toString("utf8");
}

function readTextDataUrl(value: string) {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0 || !value.startsWith("data:")) return undefined;

  const header = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const isBase64 = header.toLowerCase().endsWith(";base64");
  const buffer = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  if (buffer.byteLength > runpodTextOutputMaxBytes) {
    throw new Error("RunPod text artifact is larger than the configured text limit.");
  }
  return buffer.toString("utf8");
}

function normalizeText(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

function textCandidateKey(candidate: TextCandidate) {
  return [
    candidate.source,
    candidate.filename ?? "",
    candidate.type ?? "",
    candidate.url ?? "",
    candidate.inlineText ? `${candidate.inlineText.length}:${candidate.inlineText.slice(0, 80)}` : "",
  ].join("|");
}

function textCandidatePriority(candidate: TextCandidate) {
  if (isPreferredInlineTextCandidate(candidate)) return 0;
  if (candidate.inlineText?.trim()) return 1;
  if (candidate.url) return 2;
  return 3;
}

function isPreferredInlineTextCandidate(candidate: TextCandidate) {
  return candidate.source.trim().toLowerCase() === "texts" && Boolean(candidate.inlineText?.trim());
}

function isPreferredInlineTextArtifact(artifact: RunpodTextArtifact) {
  return artifact.source.trim().toLowerCase() === "texts" && !artifact.url;
}

function isTextSource(source: string) {
  return textSourceKeys.has(source.trim().toLowerCase());
}

function hasTextUrl(value: string | undefined) {
  if (!value) return false;
  if (value.startsWith("data:")) {
    return /^data:text\//i.test(value) || /^data:application\/json/i.test(value);
  }
  return hasTextExtension(filenameFromValue(value));
}

function hasTextExtension(value: string | undefined) {
  if (!value) return false;
  const clean = value.split("?")[0].split("#")[0].toLowerCase();
  const extension = clean.includes(".") ? `.${clean.split(".").at(-1)}` : "";
  return textExtensions.has(extension);
}

function hasTextContentType(value: string | undefined) {
  if (!value) return false;
  const clean = value.toLowerCase();
  return clean.startsWith("text/") || clean.includes("application/json");
}

function itemLooksLikeReadableUrl(value: string) {
  const clean = value.trim();
  return /^https?:\/\//i.test(clean) || clean.startsWith("data:");
}

function filenameFromValue(value: string | undefined) {
  if (!value) return undefined;
  if (value.startsWith("data:")) return undefined;

  try {
    const url = new URL(value);
    const fromParam = url.searchParams.get("filename") ?? url.searchParams.get("path");
    const pathName = fromParam || url.pathname;
    const filename = pathName.split("/").filter(Boolean).at(-1);
    return filename ? decodeURIComponent(filename) : undefined;
  } catch {
    const filename = value.split(/[\\/]/).filter(Boolean).at(-1);
    return filename;
  }
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
