// promptApi turns uploaded images into prompt-generation requests. Two groups of
// behavior are worth pinning:
//
//   1. The guards that refuse to send a request at all. Each of these calls hits a
//      RunPod-backed prompt endpoint, so a request sent with nothing usable in it
//      spends money and returns noise. The tests assert no fetch happened, not just
//      that an error was thrown.
//   2. The response handling, which has to distinguish "server said no" from
//      "server said yes but sent no text" -- returning an empty prompt silently
//      would let a user submit a render with a blank prompt.
//
// Image bytes reach the request via fetch(blobUrl) -> compress -> data URL. The
// compression step needs a real canvas decoder and falls back to the original blob
// when there isn't one, which is exactly what happens under jsdom, so these tests
// exercise the real path rather than stubbing it out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedImage } from "../types";
import {
  describeUploadedImage,
  describeUploadedImages,
  generateKlingPromptWithWorkflow,
  generateSeedancePromptWithWorkflow,
  improvePromptWithQwen,
} from "./promptApi";

vi.mock("./backendApi", () => ({
  getStoredAuthToken: vi.fn().mockReturnValue("test-token"),
}));

function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
  return { id: "img_1", name: "shot.png", url: "blob:shot", ...overrides } as UploadedImage;
}

type PromptReply = { ok?: boolean; status?: number; body?: Record<string, unknown> };

let fetchMock: ReturnType<typeof vi.fn>;

/** Answers image reads with bytes and prompt endpoints with the supplied reply. */
function stubFetch(reply: PromptReply = { body: { text: "a described image" } }) {
  fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes("/api/prompt/")) {
      return {
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        headers: new Headers(),
        json: async () => reply.body ?? {},
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The JSON body of the single prompt-endpoint call. */
function promptRequest() {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/prompt/"));
  if (!call) throw new Error("expected a prompt request");
  return { url: String(call[0]), body: JSON.parse(String((call[1] as RequestInit).body)) };
}

function promptCallCount() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/prompt/")).length;
}

beforeEach(() => {
  stubFetch();
  // The compression step decodes the blob to measure it. jsdom has no
  // createImageBitmap, and its HTMLImageElement fallback never fires onload or
  // onerror for a blob URL, so the decode would hang forever rather than fail.
  // Failing it deterministically exercises the real "could not compress, send the
  // original bytes" path instead.
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("no decoder")));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => {
      throw new Error("no object URLs under jsdom");
    },
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refusing to spend a request", () => {
  it("will not describe an empty image list", async () => {
    await expect(describeUploadedImages([])).rejects.toThrow(/upload an image first/i);
    expect(promptCallCount()).toBe(0);
  });

  it("will not describe a list of holes", async () => {
    // Image slots are sparse, so a list can be non-empty yet carry nothing.
    await expect(describeUploadedImages([undefined as unknown as UploadedImage])).rejects.toThrow(/upload an image first/i);
    expect(promptCallCount()).toBe(0);
  });

  it("will not generate a Seedance prompt without an idea to work from", async () => {
    await expect(generateSeedancePromptWithWorkflow([image()], { userPrompt: "   " })).rejects.toThrow(
      /write the initial seedance idea/i,
    );
    expect(promptCallCount()).toBe(0);
  });

  it("will not generate a Seedance prompt without a reference image", async () => {
    await expect(generateSeedancePromptWithWorkflow([], { userPrompt: "a flythrough" })).rejects.toThrow(
      /upload at least one reference image/i,
    );
    expect(promptCallCount()).toBe(0);
  });

  it("will not improve an empty prompt", async () => {
    await expect(improvePromptWithQwen({ text: "  ", mode: "video" })).rejects.toThrow(/write a prompt first/i);
    expect(promptCallCount()).toBe(0);
  });
});

describe("describing an image", () => {
  it("posts the image to the describe endpoint and returns the text", async () => {
    stubFetch({ body: { text: "a glass tower at dusk" } });
    await expect(describeUploadedImage(image())).resolves.toBe("a glass tower at dusk");

    const { url, body } = promptRequest();
    expect(url).toContain("/api/prompt/describe-image");
    expect(body.imageBase64).toMatch(/^data:image\/png;base64,/);
  });

  it("sends the cropped version when one exists", async () => {
    // The crop is what the user approved; describing the uncropped original would
    // describe content that will not be in the render.
    await describeUploadedImage(image({ url: "blob:original", croppedUrl: "blob:cropped" }));
    const readUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(readUrls).toContain("blob:cropped");
    expect(readUrls).not.toContain("blob:original");
  });

  it("carries the auth token", async () => {
    await describeUploadedImage(image());
    const headers = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/prompt/"))?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer test-token");
  });

  it("sends at most four images", async () => {
    const images = Array.from({ length: 6 }, (_, index) => image({ id: `img_${index}`, url: `blob:${index}` }));
    await describeUploadedImages(images);
    expect((promptRequest().body.imagesBase64 as string[]).length).toBe(4);
  });

  it("collapses newlines and strips a leading label", async () => {
    stubFetch({ body: { text: "Description:  a tower\nwith  glass" } });
    await expect(describeUploadedImage(image())).resolves.toBe("a tower with glass");
  });

  it("asks for no system prompt in generic mode", async () => {
    await describeUploadedImages([image()], { mode: "generic" });
    expect(promptRequest().body.systemPrompt).toBeUndefined();
  });

  it("raises the token budget for the long-form video modes", async () => {
    await describeUploadedImages([image()], { mode: "generic" });
    expect(promptRequest().body.maxTokens).toBe(512);

    stubFetch({ body: { text: "shot list" } });
    await describeUploadedImages([image()], { mode: "seedanceVideo" });
    // Seedance prompts are multi-block, so 512 tokens would truncate them.
    expect(promptRequest().body.maxTokens).toBe(1200);
  });

  it("keeps paragraph structure for Seedance but flattens it for other modes", async () => {
    stubFetch({ body: { text: "SCENE\n\nCAMERA" } });
    await expect(describeUploadedImages([image()], { mode: "seedanceVideo" })).resolves.toBe("SCENE\n\nCAMERA");

    stubFetch({ body: { text: "SCENE\n\nCAMERA" } });
    await expect(describeUploadedImages([image()], { mode: "video" })).resolves.toBe("SCENE CAMERA");
  });

  it("strips a markdown fence the model wrapped around the prompt", async () => {
    stubFetch({ body: { text: "```\na fenced prompt\n```" } });
    await expect(describeUploadedImages([image()], { mode: "klingVideo" })).resolves.toBe("a fenced prompt");
  });
});

describe("failed responses", () => {
  it("surfaces the server's error message", async () => {
    stubFetch({ ok: false, status: 400, body: { error: "Prompt worker is offline." } });
    await expect(describeUploadedImage(image())).rejects.toThrow("Prompt worker is offline.");
  });

  it("falls back to a generic message when the server sends no reason", async () => {
    stubFetch({ ok: false, status: 500, body: {} });
    await expect(describeUploadedImage(image())).rejects.toThrow(/could not describe image/i);
  });

  it("treats a successful response with no text as a failure", async () => {
    // Returning "" here would put an empty prompt in the form and let the user
    // submit a paid render with no prompt at all.
    stubFetch({ ok: true, body: { model: "qwen" } });
    await expect(describeUploadedImage(image())).rejects.toThrow(/did not include text/i);
  });

  it("reports an unreadable image rather than sending an empty payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).includes("/api/prompt/")
          ? ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ text: "x" }) } as unknown as Response)
          : ({ ok: false, status: 404, headers: new Headers() } as unknown as Response),
      ),
    );
    await expect(describeUploadedImage(image())).rejects.toThrow(/could not read uploaded image/i);
  });
});

describe("workflow-backed prompt generation", () => {
  it("sends the trimmed idea to the Seedance workflow endpoint", async () => {
    stubFetch({ body: { text: "SCENE CONTEXT: a flythrough" } });
    await expect(generateSeedancePromptWithWorkflow([image()], { userPrompt: "  a flythrough  " })).resolves.toContain(
      "SCENE CONTEXT",
    );

    const { url, body } = promptRequest();
    expect(url).toContain("/api/prompt/seedance-workflow");
    expect(body.prompt).toBe("a flythrough");
  });

  it("treats a textless Seedance response as a failure", async () => {
    stubFetch({ ok: true, body: {} });
    await expect(generateSeedancePromptWithWorkflow([image()], { userPrompt: "a flythrough" })).rejects.toThrow(
      /did not include generated prompt text/i,
    );
  });

  it("surfaces a Seedance workflow error from the server", async () => {
    stubFetch({ ok: false, status: 502, body: { error: "Seedance worker timed out." } });
    await expect(generateSeedancePromptWithWorkflow([image()], { userPrompt: "a flythrough" })).rejects.toThrow(
      "Seedance worker timed out.",
    );
  });

  it("requires a reference image for the Kling workflow", async () => {
    await expect(generateKlingPromptWithWorkflow([], { userPrompt: "a slow push in" })).rejects.toThrow();
    expect(promptCallCount()).toBe(0);
  });
});

describe("improving an existing prompt", () => {
  it("sends the trimmed text and works without any images", async () => {
    stubFetch({ body: { text: "an improved prompt" } });
    await expect(improvePromptWithQwen({ text: "  make it better  ", mode: "video" })).resolves.toBe("an improved prompt");

    const { url, body } = promptRequest();
    expect(url).toContain("/api/prompt/improve");
    expect(String(body.prompt)).toContain("make it better");
  });

  it("includes reference images when they are supplied", async () => {
    stubFetch({ body: { text: "an improved prompt" } });
    await improvePromptWithQwen({ text: "make it better", images: [image()], mode: "imageEditing" });
    expect((promptRequest().body.imagesBase64 as string[]).length).toBe(1);
  });
});
