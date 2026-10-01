import { randomUUID } from "node:crypto";
import { comfyOrgApiKey } from "./config.js";
import { BackendHttpError } from "./httpError.js";

type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: AnthropicImageMediaType;
        data: string;
      };
    };

type AnthropicRouterResponse = {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ComfyRouterClaudeResult = {
  text: string;
  responseId?: string;
  model: string;
  usage?: AnthropicRouterResponse["usage"];
};

export async function runClaudeWithComfyRouter({
  model,
  system,
  content,
  maxTokens,
  fetchImpl = fetch,
}: {
  model: string;
  system: string;
  content: AnthropicContentBlock[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
}): Promise<ComfyRouterClaudeResult> {
  if (!comfyOrgApiKey) {
    throw new BackendHttpError("Claude prompt generation is not configured. COMFY_ORG_API_KEY is missing.", {
      statusCode: 503,
      code: "comfy_router_not_configured",
    });
  }

  const endpoint = `https://api.comfy.org/v2/models/${model}`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        "X-API-Key": comfyOrgApiKey,
      },
      body: JSON.stringify({
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content }],
      }),
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    throw new BackendHttpError(`Could not reach Comfy Router for Claude.${detail}`, {
      statusCode: 502,
      code: "comfy_router_unreachable",
    });
  }

  const responseText = await response.text();
  const payload = parseJson(responseText) as AnthropicRouterResponse | Record<string, unknown>;
  if (!response.ok) {
    const errorType = response.headers.get("X-Comfy-Error-Type");
    const detail = routerErrorDetail(payload);
    const context = [errorType, detail].filter(Boolean).join(": ");
    throw new BackendHttpError(`Comfy Router rejected the Claude request (${response.status})${context ? `: ${context}` : "."}`, {
      statusCode: routerHttpStatus(response.status),
      code: "comfy_router_rejected",
    });
  }

  const result = payload as AnthropicRouterResponse;
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) {
    throw new BackendHttpError("Claude returned no prompt text through Comfy Router.", {
      statusCode: 502,
      code: "comfy_router_no_text",
    });
  }

  return {
    text,
    responseId: result.id,
    model: result.model?.trim() || model,
    usage: result.usage,
  };
}

export function anthropicImageBlock(value: string, index: number): AnthropicContentBlock {
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  const mediaType = (dataUrl?.[1]?.toLowerCase() ?? "image/jpeg") as AnthropicImageMediaType;
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) {
    throw new BackendHttpError(
      `Reference image ${index + 1} uses ${mediaType}, but Claude accepts JPEG, PNG, GIF, or WebP images.`,
      { statusCode: 400, code: "unsupported_prompt_image" },
    );
  }

  const data = (dataUrl?.[2] ?? trimmed).replace(/\s+/g, "");
  if (!data) {
    throw new BackendHttpError(`Reference image ${index + 1} is empty.`, {
      statusCode: 400,
      code: "empty_prompt_image",
    });
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  };
}

function parseJson(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function routerErrorDetail(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }
  return "";
}

function routerHttpStatus(status: number) {
  if (status === 413 || status === 429) return status;
  if (status === 400 || status === 422) return 400;
  if (status === 401 || status === 403) return 503;
  return 502;
}
