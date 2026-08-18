import { describe, expect, it } from "vitest";
import type { BackendWorkflowModel } from "./types";
import { mapJob, mapModel } from "./mappers";
import type { BackendJob } from "./types";

function fluxModel(overrides: Partial<BackendWorkflowModel> = {}): BackendWorkflowModel {
  return {
    id: "brick_api_flux3_i2v",
    name: "Flux 3 Image To Video",
    category: "image_to_video",
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\Brick_api_flux3_i2v.json",
    requiredInputs: ["prompt", "single_image", "resolution", "seed"],
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    imageSlotCount: 1,
    outputType: "video",
    ...overrides,
  };
}

describe("Flux 3 model mapping", () => {
  it("maps image-to-video limits into the generation controls", () => {
    const model = mapModel(fluxModel());

    expect(model.backendCategory).toBe("image_to_video");
    expect(model.imageSlotCount).toBe(1);
    expect(model.requiresImage).toBe(true);
    expect(model.supportedResolutions).toEqual(["720p", "1080p"]);
    expect(model.supportedDurations).toEqual(Array.from({ length: 16 }, (_, index) => index + 5));
    expect(model.defaultDurationSeconds).toBe(5);
  });

  it("maps the first/last-frame workflow to two required image slots", () => {
    const model = mapModel(
      fluxModel({
        id: "brick_api_flux3_flf2v",
        name: "Flux 3 First Last Frame To Video",
        category: "first_last_frame_to_video",
        workflowPath: "C:\\Momi-Animation\\workflow\\flf2v\\Brick_api_flux3_flf2v.json",
        requiredInputs: ["prompt", "start_frame", "end_frame", "resolution", "seed"],
        requiresStartEndFrames: true,
        imageSlotCount: 2,
      }),
    );

    expect(model.backendCategory).toBe("first_last_frame_to_video");
    expect(model.requiresTwoImages).toBe(true);
    expect(model.imageSlotCount).toBe(2);
  });
});

// A result is carried in two forms and they are not interchangeable: one the browser
// may fetch, one a job may be submitted against. Conflating them is what broke
// "Use as input" -- the proxied URL reached the dispatcher, which could find no file
// path in it and refused it as a remote link.
describe("mapJob result URLs", () => {
  function backendJob(overrides: Partial<BackendJob> = {}): BackendJob {
    return {
      id: "job_1",
      projectId: "prj_1",
      userId: "usr_1",
      modelId: "still_pro-upscaler",
      modelName: "Pro Upscaler",
      category: "image_upscaling",
      inputType: "single_image",
      status: "completed",
      inputImages: [],
      resultUrls: ["/api/media?path=C%3A%5Cout%5Cresult.png"],
      thumbnailUrls: [],
      outputType: "image",
      createdAt: "2026-08-18T09:00:00.000Z",
      ...overrides,
    } as BackendJob;
  }

  it("proxies the displayable URL and keeps the submittable one", () => {
    const job = mapJob(backendJob());

    // What the browser fetches: through the backend, with a media token.
    expect(job.resultUrl).toContain("/api/jobs/job_1/result-media");
    // What a chained job is submitted against: the path the backend stored.
    expect(job.resultSourceUrls).toEqual(["/api/media?path=C%3A%5Cout%5Cresult.png"]);
  });

  it("carries no access token into the submittable form", () => {
    // It ends up persisted in the next job's record, and the dispatcher reads the
    // path server-side, so a credential in there would be stored for nothing.
    const job = mapJob(backendJob());
    expect(job.resultSourceUrls?.[0]).not.toContain("access_token");
  });

  it("leaves project media alone, which is already its own source", () => {
    const job = mapJob(backendJob({ source: "existing_project_media" }));
    expect(job.resultSourceUrls).toEqual(["/api/media?path=C%3A%5Cout%5Cresult.png"]);
  });
});
