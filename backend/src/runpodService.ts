type DescribeImageParams = {
  imageBase64?: string;
  imagesBase64?: string[];
  prompt?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
};

type RunpodResponse = {
  id?: string;
  status?: string;
  output?: unknown;
  text?: string;
  model?: string;
  message?: string;
  error?: string;
};

const DEFAULT_IMAGE_DESCRIPTION_PROMPT =
  "Describe this image clearly for an image editing workflow. Mention the main subject, environment, composition, lighting, colors, materials, style, visible text, and anything important to preserve.";

const DEFAULT_SYSTEM_PROMPT =
  "You are a precise visual assistant for a creative production team. Return a useful, concise image description.";

export async function describeImageWithRunpod({
  imageBase64,
  imagesBase64,
  prompt = DEFAULT_IMAGE_DESCRIPTION_PROMPT,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  maxTokens = 512,
  temperature = 0.2,
  fetchImpl = fetch,
}: DescribeImageParams) {
  const apiKey = process.env.PROMPT_RUNPOD_API_KEY ?? process.env.RUNPOD_PROMPT_API_KEY ?? process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    throw new Error("RUNPOD_API_KEY is not configured on the backend.");
  }
  const endpointUrl = promptRunpodEndpointUrl();
  if (!endpointUrl) {
    throw new Error("Prompt helper RunPod endpoint is not configured. Set PROMPT_RUNPOD_ENDPOINT_ID or PROMPT_RUNPOD_ENDPOINT_URL.");
  }

  const payload = {
    input: {
      ...(imagesBase64?.length
        ? { images_base64: imagesBase64.slice(0, 4).map(stripDataUrlPrefix) }
        : imageBase64?.trim()
          ? { image_base64: stripDataUrlPrefix(imageBase64) }
          : {}),
      prompt,
      system_prompt: systemPrompt,
      max_tokens: maxTokens,
      temperature,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetchImpl(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({})) as RunpodResponse;
    if (!response.ok) {
      throw new Error(data.error || data.message || `RunPod request failed with ${response.status}`);
    }

    const output = data.output ?? data;
    if (isRecord(output) && stringFrom(output.status)?.toLowerCase() === "error") {
      throw new Error(stringFrom(output.message) || "RunPod image description failed.");
    }

    const text = extractOutputText(output) ?? extractOutputText(data);
    if (!text?.trim()) {
      throw new Error("RunPod response did not include output text.");
    }

    return {
      text: text.trim(),
      model: isRecord(output) ? stringFrom(output.model) : data.model,
      runpodJobId: data.id,
      runpodStatus: data.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractOutputText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value.map(extractOutputText).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join("\n").trim() : undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of ["text", "response", "result", "generated_text", "generatedText", "caption", "description", "content", "message"]) {
    const text = extractOutputText(value[key]);
    if (text) return text;
  }

  const choices = value.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (isRecord(choice)) {
        const text = extractOutputText(choice.message) ?? extractOutputText(choice.delta) ?? extractOutputText(choice.text);
        if (text) return text;
      }
      const text = extractOutputText(choice);
      if (text) return text;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripDataUrlPrefix(value: string) {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("data:") && trimmed.includes(",")) {
    return trimmed.split(",", 2)[1];
  }
  return trimmed;
}

function promptRunpodEndpointUrl() {
  const explicitUrl = process.env.PROMPT_RUNPOD_ENDPOINT_URL ?? process.env.RUNPOD_PROMPT_ENDPOINT_URL;
  if (explicitUrl?.trim()) {
    return explicitUrl.trim().replace(/\/$/, "");
  }

  const endpointId = process.env.PROMPT_RUNPOD_ENDPOINT_ID ?? process.env.RUNPOD_PROMPT_ENDPOINT_ID;
  if (endpointId?.trim()) {
    return `https://api.runpod.ai/v2/${endpointId.trim()}/runsync`;
  }

  return undefined;
}
