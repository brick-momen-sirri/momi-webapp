import { describe, expect, it } from "vitest";

import { reusableStillImageJob } from "./reuseStillImageJob";
import type { Job } from "../../types";

// Before this existed, Reuse settings on a still image card ran the Animation
// reader: it restored a model, resolution and duration the preset never had, and
// none of the sliders the render actually used.

function job(stillImage?: NonNullable<Job["workflowOptions"]>["stillImage"], extra?: Partial<Job>) {
  return { workflowOptions: stillImage ? { stillImage } : undefined, prompt: "", ...extra } as Pick<
    Job,
    "workflowOptions" | "prompt"
  >;
}

describe("reusableStillImageJob", () => {
  it("ignores a job that is not a still image job", () => {
    expect(reusableStillImageJob(job())).toBeUndefined();
  });

  it("ignores a preset that no longer exists", () => {
    // Not a fallback to the first preset: restoring a retired preset's settings
    // into General Enhancement would render something nobody asked for.
    expect(reusableStillImageJob(job({ categoryId: "retired-preset", settings: {} }))).toBeUndefined();
  });

  it("restores the settings the job rendered with", () => {
    const reusable = reusableStillImageJob(
      job({ categoryId: "pro-upscaler", settings: { engine: "super-fast", upscale: "x4", enhancement: false } }),
    );

    expect(reusable?.categoryId).toBe("pro-upscaler");
    expect(reusable?.state.settings).toMatchObject({ engine: "super-fast", upscale: "x4", enhancement: false });
  });

  it("fills a setting the job never carried from the catalogue default", () => {
    // Hidden settings are dropped at submission, so a job with enhancement off
    // has no creativity value at all.
    const reusable = reusableStillImageJob(job({ categoryId: "pro-upscaler", settings: { enhancement: false } }));
    expect(reusable?.state.settings.creativity).toBe(30);
  });

  it("falls back to the default when a saved value is out of today's range", () => {
    // The catalogue caps general denoise at 0.45. A job from before a narrowing
    // would otherwise put a value in the form that the server rejects on submit.
    const reusable = reusableStillImageJob(
      job({ categoryId: "general-enhancement", settings: { generalDenoise: 0.9, details: 1.5 } }),
    );
    expect(reusable?.state.settings.generalDenoise).toBe(0.1);
    expect(reusable?.state.settings.details).toBe(1.5);
  });

  it("falls back when a select option has since been removed", () => {
    const reusable = reusableStillImageJob(job({ categoryId: "pro-upscaler", settings: { engine: "quantum" } }));
    expect(reusable?.state.settings.engine).toBe("normal");
  });

  it("restores the prompt", () => {
    const reusable = reusableStillImageJob(
      job({ categoryId: "qwen-edit", settings: { mode: "edit", imageCount: "1" } }, { prompt: "remove the car" }),
    );
    expect(reusable?.state.prompt).toBe("remove the car");
  });

  it("restores the seed, which is what makes the result reproducible", () => {
    const reusable = reusableStillImageJob(job({ categoryId: "qwen-edit", seed: 4242, settings: { mode: "edit" } }));
    expect(reusable?.state.seed).toBe("4242");
  });

  it("leaves the seed empty for a result recorded before seeds were saved", () => {
    // A fresh seed gets drawn on submit, so the render will differ -- there is
    // nothing on the job to reproduce it from.
    const reusable = reusableStillImageJob(job({ categoryId: "qwen-edit", settings: { mode: "edit" } }));
    expect(reusable?.state.seed).toBe("");
  });

  it("takes the slot count from the restored settings, not the job's images", () => {
    // Qwen Edit's mode decides how many slots the form draws. Rehydrating by the
    // job's own image count would leave an image in a slot nobody can see.
    expect(reusableStillImageJob(job({ categoryId: "qwen-edit", settings: { mode: "edit", imageCount: "3" } }))?.slotCount).toBe(
      3,
    );
    expect(reusableStillImageJob(job({ categoryId: "qwen-edit", settings: { mode: "reference-transfer" } }))?.slotCount).toBe(2);
    expect(reusableStillImageJob(job({ categoryId: "reference-generator", settings: {} }))?.slotCount).toBe(2);
  });
});
