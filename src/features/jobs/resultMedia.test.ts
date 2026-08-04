// resultMedia decides which URL a result actually lives at, and what a downloaded
// file is called. Both matter more than they look:
//
//   - fetchResultBlob tries the authenticated backend route first and only then the
//     URL recorded on the job. Losing that order means an authenticated-only file
//     appears broken; losing the fallback means older jobs stop downloading.
//   - The filename carries the model and job id, and for two-image results the
//     index. Artists file these into project folders by hand, so a collision
//     between the two images of one job is a real loss of work.
//
// The canvas-backed format conversion is not covered here: it needs a real image
// decoder and a 2D context, and jsdom fires neither onload nor onerror for a blob
// URL. Only its passthrough branches are asserted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../types";
import { backendResultFileUrl, getStoredAuthToken } from "../../services/backendApi";
import {
  clipboardCompatibleImageBlob,
  convertImageBlobForDownload,
  downloadBlob,
  downloadNameForJob,
  fetchResultBlob,
  getPrimaryResultUrl,
  hasTwoImageDownloadChoices,
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

describe("hasTwoImageDownloadChoices", () => {
  it("is true only for a completed two-image result", () => {
    expect(hasTwoImageDownloadChoices(job({ outputType: "image", resultUrls: ["a.png", "b.png"] }))).toBe(true);
  });

  it("is false for one or three results", () => {
    expect(hasTwoImageDownloadChoices(job({ outputType: "image", resultUrls: ["a.png"] }))).toBe(false);
    expect(hasTwoImageDownloadChoices(job({ outputType: "image", resultUrls: ["a.png", "b.png", "c.png"] }))).toBe(false);
  });

  it("is false while the job is unfinished", () => {
    const running = job({ status: "running", outputType: "image", resultUrls: ["a.png", "b.png"] });
    expect(hasTwoImageDownloadChoices(running)).toBe(false);
  });

  it("is false for a two-part video result", () => {
    expect(hasTwoImageDownloadChoices(job({ outputType: "video", resultUrls: ["a.mp4", "b.mp4"] }))).toBe(false);
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

describe("downloadNameForJob", () => {
  it("names the file after the model and job", () => {
    expect(downloadNameForJob(job({ modelType: "Veo 3" }), blob("image/png"))).toBe("Veo_3-job_1.png");
  });

  it("replaces characters that are illegal in a filename", () => {
    const messy = job({ modelType: 'Kling v2.6 <"edit">', id: "job_2" });
    const name = downloadNameForJob(messy, blob("image/png"));
    expect(name).not.toMatch(/[<>"]/);
    // The sanitizer runs on the whole "model-id" template and only trims
    // underscores from the very ends, so a model name ending in an illegal
    // character leaves an "_" sitting next to the id separator. Cosmetic, and
    // pinned here so it is a deliberate choice rather than a surprise.
    expect(name).toBe("Kling_v2.6_edit_-job_2.png");
  });

  it("falls back to a generic base when the model is unknown", () => {
    expect(downloadNameForJob(job({ modelType: "" }), blob("image/png"))).toBe("result-job_1.png");
  });

  it("derives the extension from the blob's type", () => {
    const cases: Array<[string, string]> = [
      ["image/jpeg", ".jpg"],
      ["image/png", ".png"],
      ["image/webp", ".webp"],
      ["image/gif", ".gif"],
      ["video/mp4", ".mp4"],
      ["video/quicktime", ".mov"],
      ["video/webm", ".webm"],
    ];
    for (const [type, extension] of cases) {
      expect(downloadNameForJob(job(), blob(type))).toMatch(new RegExp(`\\${extension}$`));
    }
  });

  it("uses .bin for a type it does not recognise rather than no extension", () => {
    expect(downloadNameForJob(job(), blob("application/octet-stream"))).toMatch(/\.bin$/);
  });

  it("distinguishes the two images of a two-image result", () => {
    const two = job({ outputType: "image", resultUrls: ["a.png", "b.png"] });
    expect(downloadNameForJob(two, blob("image/png"), 0)).toContain("_image-1");
    expect(downloadNameForJob(two, blob("image/png"), 1)).toContain("_image-2");
    expect(downloadNameForJob(two, blob("image/png"), 0)).not.toBe(downloadNameForJob(two, blob("image/png"), 1));
  });

  it("adds no index suffix for a single result", () => {
    expect(downloadNameForJob(job({ outputType: "image", resultUrls: ["a.png"] }), blob("image/png"))).not.toContain("_image-");
  });
});

describe("downloadBlob", () => {
  it("clicks a temporary link and cleans it up", () => {
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadBlob(blob("image/png"), "shot.png");

    expect(click).toHaveBeenCalledTimes(1);
    // The anchor must not survive in the document, or repeated downloads pile up.
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    click.mockRestore();
  });

  it("revokes the object URL on a timer rather than leaking it", () => {
    vi.useFakeTimers();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:download", revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadBlob(blob("image/png"), "shot.png");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");

    click.mockRestore();
    vi.useRealTimers();
  });
});

describe("format passthroughs", () => {
  it("returns a PNG unchanged when PNG was requested", async () => {
    const png = blob("image/png");
    await expect(convertImageBlobForDownload(png, "png")).resolves.toBe(png);
  });

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
