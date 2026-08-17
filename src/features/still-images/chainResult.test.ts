import { describe, expect, it } from "vitest";

import { chainableResultImage } from "./chainResult";
import type { Job } from "../../types";

// The chain this exists for is enhance-then-upscale. Walking it by hand meant
// downloading a 100 MB PNG and uploading the same bytes back to the server they
// came from.

function job(overrides: Partial<Job> = {}) {
  return {
    id: "job_1",
    status: "completed",
    resultUrl: "/api/media?path=out.png",
    fileName: "RAW_0012_ProUpscaler_v001.png",
    modelType: "Pro Upscaler",
    ...overrides,
  } as Job;
}

describe("chainableResultImage", () => {
  it("submits the saved result itself, not a rendition", () => {
    // uploadJobMediaUrl forwards a saved-media URL untouched, so this is what
    // reaches the next job -- the same file on disk, no upload, no copy. A
    // rendition here would silently run the next preset on a downscaled image.
    expect(chainableResultImage(job())?.url).toBe("/api/media?path=out.png");
  });

  it("displays a rendition, because the slot is a thumbnail and the result is not", () => {
    expect(chainableResultImage(job())?.previewUrl).toBe("/api/media/thumbnail?path=out.png&w=240");
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
    expect(chainableResultImage(job({ resultUrl: undefined }))).toBeUndefined();
  });
});
