import { describe, expect, it } from "vitest";

import { chainableResultImage, chainableResultUrl } from "./chainResult";
import type { Job } from "../../types";

// The chain this exists for is enhance-then-upscale. Walking it by hand meant
// downloading a 100 MB PNG and uploading the same bytes back to the server they
// came from.
//
// The fixture matters as much as the assertions here. These tests used to describe
// resultUrl as "/api/media?path=out.png", which mapJob never produces for a backend
// job -- it proxies results through /api/jobs/:id/result-media so the browser can
// fetch them with a media token. Chaining submitted that proxied URL, the still
// image materializer could not find a `path` in it, and every send failed with
// "remote URLs cannot be inlined". The shapes below are the real ones.
function job(overrides: Partial<Job> = {}) {
  return {
    id: "job_1",
    status: "completed",
    resultUrl: "/api/jobs/job_1/result-media?index=0&access_token=tok",
    resultSourceUrls: ["/api/media?path=out.png"],
    fileName: "RAW_0012_ProUpscaler_v001.png",
    modelType: "Pro Upscaler",
    ...overrides,
  } as Job;
}

describe("chainableResultImage", () => {
  it("submits the saved media path, not the URL the card displays", () => {
    // The one that broke: uploadJobMediaUrl forwards a saved-media URL untouched,
    // so this is what reaches the next job -- the same file on disk, no upload, no
    // copy. The proxied form reaches it as a link it cannot resolve.
    expect(chainableResultImage(job())?.url).toBe("/api/media?path=out.png");
  });

  it("displays a rendition, because the slot is a thumbnail and the result is not", () => {
    // Display keeps using the proxied URL, which is what the browser is allowed to
    // fetch; only the submitted value changed.
    expect(chainableResultImage(job())?.previewUrl).toBe("/api/jobs/job_1/result-media?index=0&access_token=tok&w=240");
  });

  it("carries the result's own file name", () => {
    expect(chainableResultImage(job())?.name).toBe("RAW_0012_ProUpscaler_v001.png");
  });

  it("names it after the preset when the job has no file name", () => {
    expect(chainableResultImage(job({ fileName: undefined }))?.name).toBe("Pro Upscaler result");
  });

  it("asks for no crop", () => {
    // Still Images has no 16:9 crop surface, and the result is already the shape
    // the previous preset produced.
    expect(chainableResultImage(job())?.cropRequired).toBe(false);
  });

  it("gives each chained copy its own id", () => {
    // The same result can be sent to more than one preset, and slots are keyed
    // by id.
    expect(chainableResultImage(job())?.id).not.toBe(chainableResultImage(job())?.id);
  });

  it("refuses a job that has not finished", () => {
    // resultUrl can be populated from a previous attempt on retry, so status is
    // the thing to trust.
    expect(chainableResultImage(job({ status: "running" }))).toBeUndefined();
    expect(chainableResultImage(job({ status: "failed" }))).toBeUndefined();
  });

  it("refuses a completed job with nothing to chain", () => {
    expect(chainableResultImage(job({ resultSourceUrls: [] }))).toBeUndefined();
    expect(chainableResultImage(job({ resultSourceUrls: undefined }))).toBeUndefined();
  });
});

describe("chainableResultUrl", () => {
  it("takes the saved media path", () => {
    expect(chainableResultUrl(job())).toBe("/api/media?path=out.png");
  });

  it("refuses a result that is still only on the provider's storage", () => {
    // Until the media is pulled back, the job carries an https link, and no preset
    // can take one. The menu says so rather than letting Generate fail.
    expect(
      chainableResultUrl({ resultSourceUrls: ["https://momi-ai.s3.eu-north-1.amazonaws.com/08-26/abc/def.png"] }),
    ).toBeUndefined();
  });

  it("refuses the proxied display URL, whatever it is passed as", () => {
    expect(chainableResultUrl({ resultSourceUrls: ["/api/jobs/job_1/result-media?index=0"] })).toBeUndefined();
  });
});
