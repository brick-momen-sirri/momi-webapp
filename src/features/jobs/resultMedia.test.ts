// resultMedia decides which URL a result actually lives at, and how it reaches
// the user's disk.
//
//   - fetchResultBlob tries the authenticated backend route first and only then the
//     URL recorded on the job. Losing that order means an authenticated-only file
//     appears broken; losing the fallback means older jobs stop downloading.
//   - downloadFromUrl must stay a bare anchor. The moment it goes back to
//     fetch + Blob, a 100 MB still is buffered in the tab -- which is exactly what
//     moving downloads to a streamed backend response was meant to stop. Naming
//     and format conversion now live on the server; see httpMedia.test.ts.
//
// The canvas re-encode is not covered here: it needs a real image decoder and a
// 2D context, and jsdom fires neither onload nor onerror for a blob URL. Only its
// passthrough branch is asserted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../types";
import { backendResultFileUrl, getStoredAuthToken } from "../../services/backendApi";
import {
  clipboardCompatibleImageBlob,
  downloadFromUrl,
  fetchResultBlob,
  getPrimaryResultUrl,
  isImageResult,
} from "./resultMedia";

vi.mock("../../services/backendApi", () => ({
  backendResultFileUrl: vi.fn((jobId: string, index: number) => `/api/jobs/${jobId}/result/${index}`),
  getStoredAuthToken: vi.fn().mockReturnValue("test-token"),
}));

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Veo 3",
    inputType: "single_image",
    prompt: "a shot",
    resolution: "1080p",
    status: "completed",
    inputImages: [],
    ...overrides,
  } as Job;
}

function blob(type: string) {
  return new Blob([new Uint8Array([1])], { type });
}

beforeEach(() => {
  vi.mocked(getStoredAuthToken).mockReturnValue("test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPrimaryResultUrl", () => {
  it("prefers the first result URL", () => {
    const target = job({ resultUrls: ["a.png", "b.png"], resultUrl: "old.png", thumbnailUrl: "t.png" });
    expect(getPrimaryResultUrl(target)).toBe("a.png");
  });

  it("falls back through resultUrl, then thumbnails", () => {
    expect(getPrimaryResultUrl(job({ resultUrl: "old.png", thumbnailUrl: "t.png" }))).toBe("old.png");
    expect(getPrimaryResultUrl(job({ thumbnailUrls: ["t0.png"], thumbnailUrl: "t.png" }))).toBe("t0.png");
    expect(getPrimaryResultUrl(job({ thumbnailUrl: "t.png" }))).toBe("t.png");
  });

  it("is undefined when the job has produced nothing", () => {
    expect(getPrimaryResultUrl(job())).toBeUndefined();
  });

  it("ignores an empty result list rather than returning undefined from it", () => {
    expect(getPrimaryResultUrl(job({ resultUrls: [], resultUrl: "old.png" }))).toBe("old.png");
  });
});

describe("isImageResult", () => {
  it("is true for an explicit image output", () => {
    expect(isImageResult(job({ outputType: "image" }))).toBe(true);
  });

  it("is false for video and sequence outputs", () => {
    expect(isImageResult(job({ outputType: "video" }))).toBe(false);
    expect(isImageResult(job({ outputType: "sequence" }))).toBe(false);
  });

  it("assumes an image when nothing says otherwise", () => {
    // Older jobs recorded no outputType.
    expect(isImageResult(job({ outputType: undefined }))).toBe(true);
  });

  it("treats a recorded video length as proof it is not an image", () => {
    expect(isImageResult(job({ outputType: undefined, videoLength: "5s" }))).toBe(false);
  });
});

describe("fetchResultBlob", () => {
  it("reads the authenticated backend route first", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true, blob: async () => blob("image/png") }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchResultBlob(job({ resultUrls: ["direct.png"] }));

    expect(backendResultFileUrl).toHaveBeenCalledWith("job_1", 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/jobs/job_1/result/0");
  });

  it("sends the bearer token when one is stored", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true, blob: async () => blob("image/png") }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchResultBlob(job());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(init.credentials).toBe("include");
  });

  it("omits the header entirely when no token is stored", async () => {
    vi.mocked(getStoredAuthToken).mockReturnValue(undefined as unknown as string);
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true, blob: async () => blob("image/png") }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchResultBlob(job());

    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeUndefined();
  });

  it("falls back to the URL recorded on the job when the backend route fails", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).startsWith("/api/jobs")
        ? ({ ok: false, status: 404 } as unknown as Response)
        : ({ ok: true, blob: async () => blob("image/png") } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchResultBlob(job({ resultUrls: ["direct.png"] }));

    expect(result.type).toBe("image/png");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/jobs/job_1/result/0", "direct.png"]);
  });

  it("reports the last failure when no source works", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
    );

    await expect(fetchResultBlob(job({ resultUrls: ["direct.png"] }))).rejects.toThrow(/could not read result file \(500\)/i);
  });

  it("surfaces a network failure rather than hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await expect(fetchResultBlob(job())).rejects.toThrow("offline");
  });

  it("does not use the primary-result fallback for a non-zero index", async () => {
    // Index 1 has no recorded URL of its own, and the primary URL is index 0's --
    // using it would silently download the wrong image.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, status: 404 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResultBlob(job({ resultUrl: "only-the-first.png" }), 1)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("downloadFromUrl", () => {
  it("clicks a temporary link and cleans it up", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadFromUrl("/api/jobs/job_1/result-file");

    expect(click).toHaveBeenCalledTimes(1);
    // The anchor must not survive in the document, or repeated downloads pile up.
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    click.mockRestore();
  });

  it("never reads the response into memory", async () => {
    // The whole point of the anchor: a 10K still is over 100 MB, and buffering it
    // into a Blob to hand to createObjectURL is what used to make downloading one
    // a memory event in the tab.
    const fetchMock = vi.fn();
    const createObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadFromUrl("/api/jobs/job_1/result-file");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("leaves the filename to the response's Content-Disposition", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const appended: string[] = [];
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
      if (node instanceof HTMLAnchorElement) appended.push(node.getAttribute("download") ?? "<absent>");
      return realAppend(node);
    });

    downloadFromUrl("/api/jobs/job_1/result-file");

    // An empty download attribute asks for a download without naming it, so the
    // server's Content-Disposition wins. A non-empty value here would override
    // the real result filename with a guess.
    expect(appended).toEqual([""]);
    click.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("format passthroughs", () => {
  it("returns the blob unchanged when the clipboard already supports its type", async () => {
    vi.stubGlobal("ClipboardItem", { supports: () => true });
    const webp = blob("image/webp");
    await expect(clipboardCompatibleImageBlob(webp)).resolves.toBe(webp);
  });

  it("passes a PNG straight through on a browser with no supports() probe", async () => {
    // Older browsers expose ClipboardItem without the feature-detection helper.
    vi.stubGlobal("ClipboardItem", {});
    const png = blob("image/png");
    await expect(clipboardCompatibleImageBlob(png)).resolves.toBe(png);
  });
});
