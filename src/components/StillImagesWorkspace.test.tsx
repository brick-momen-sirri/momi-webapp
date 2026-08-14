import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { StillImagesWorkspace } from "./StillImagesWorkspace";
import { createInitialStillImagesState, getStillImageCategory } from "../features/still-images/stillImageCategories";
import type { Job, Project } from "../types";

// The results panel is the only place a Still Images job becomes visible, so an
// empty list has to be distinguishable from "nothing ran" and a failure has to
// surface its reason rather than looking like a job still in flight.

const state = createInitialStillImagesState();
const category = getStillImageCategory("pro-upscaler");

const project: Project = {
  id: "prj_1",
  name: "Groupe Rawji",
  shortName: "RAW",
  folderPath: "C:\\projects\\raw",
  ownerId: "usr_1",
  members: [],
  groupMembers: [],
  memberCount: 0,
  visibility: "team",
  jobCount: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as Project;

function stillJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_still_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelId: "still_pro-upscaler",
    modelType: "Pro Upscaler",
    prompt: "",
    status: "completed",
    inputImages: ["/api/media?path=in.png"],
    resultUrls: ["/api/media?path=out.png"],
    resultUrl: "/api/media?path=out.png",
    thumbnailUrls: [],
    outputType: "image",
    createdAt: "2026-08-12T10:00:00.000Z",
    workflowOptions: {
      stillImage: { categoryId: "pro-upscaler", settings: { engine: "normal", upscale: "x4" } },
      save: { cameraNumber: "0012" },
    },
    ...overrides,
  } as Job;
}

function renderPanel(jobs: Job[]) {
  return render(
    <StillImagesWorkspace
      category={category}
      state={state["pro-upscaler"]}
      selectedProject={project}
      targetFolderId=""
      saveNumber="0012"
      userName="Momen"
      jobs={jobs}
    />,
  );
}

describe("StillImagesWorkspace", () => {
  it("shows an empty state and a zero count when nothing has been generated", () => {
    renderPanel([]);
    expect(screen.getByText("0 generated results")).toBeInTheDocument();
    expect(screen.getByText("No still image results for this project yet")).toBeInTheDocument();
  });

  it("names the user who submitted the job in the metadata row", () => {
    // Projects are studio-wide, so a result in this list is as likely to be
    // someone else's as your own.
    renderPanel([stillJob()]);
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getAllByText("Momen").length).toBeGreaterThan(0);
  });

  it("renders a completed job with its result image and metadata", () => {
    renderPanel([stillJob()]);

    expect(screen.getByText("1 generated result")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Pro Upscaler" })).toBeInTheDocument();
    expect(screen.getByText("Camera 0012")).toBeInTheDocument();
    const result = screen.getByAltText("Result for Pro Upscaler") as HTMLImageElement;
    expect(result.src).toContain("out.png");
    expect(screen.getByAltText("Still image input 1")).toBeInTheDocument();
  });

  // Still image results are the largest media this app produces -- 4K to 10K PNGs
  // that routinely pass 100 MB. This panel lists every result in a project, so
  // rendering originals here means a project with 50 results pulls several GB and
  // decodes each one to a several-hundred-MB bitmap. It used to do exactly that.
  it("shows a downscaled rendition on the card, never the original", () => {
    renderPanel([stillJob()]);

    const result = screen.getByAltText("Result for Pro Upscaler") as HTMLImageElement;
    // 1440, the largest rendition: the card spans the panel and these renders
    // are being judged on quality, so a smaller one upscaled reads as a fault in
    // the render rather than in the preview.
    expect(result.getAttribute("src")).toBe("/api/media/thumbnail?path=out.png&w=1440");
    // Still a rendition, never the un-resized media route.
    expect(result.getAttribute("src")).not.toBe("/api/media?path=out.png");
    // Nothing on the card may point at the un-resized media route.
    expect(result.getAttribute("src")).not.toBe("/api/media?path=out.png");
    // jsdom does not reflect these as IDL properties, so read the attributes.
    expect(result.getAttribute("loading")).toBe("lazy");
    expect(result.getAttribute("decoding")).toBe("async");
  });

  it("carries the same action toolbar as an Animation card", async () => {
    const onDownload = vi.fn();
    render(
      <StillImagesWorkspace
        category={category}
        state={state["pro-upscaler"]}
        selectedProject={project}
        targetFolderId=""
        saveNumber="0012"
        userName="Momen"
        jobs={[stillJob()]}
        onDownload={onDownload}
      />,
    );

    // Rendered from the shared JobActions rather than rebuilt here, so the two
    // surfaces cannot drift into different behaviour.
    const download = screen.getByRole("button", { name: /download/i });
    expect(download).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy image to clipboard/i })).toBeInTheDocument();

    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(download);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("omits the toolbar when the host wires no actions", () => {
    // The panel is rendered without handlers in tests and previews; it must not
    // show controls that would do nothing.
    renderPanel([stillJob()]);
    expect(screen.queryByRole("button", { name: /copy image to clipboard/i })).not.toBeInTheDocument();
  });

  it("previews an input as a chip-sized rendition too", () => {
    renderPanel([stillJob()]);
    const input = screen.getByAltText("Still image input 1") as HTMLImageElement;
    expect(input.getAttribute("src")).toBe("/api/media/thumbnail?path=in.png&w=240");
  });

  it("opens the preview at preview size, and downloads the original separately", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    renderPanel([stillJob()]);

    // Download goes straight at the result-file route, which answers with
    // Content-Disposition: attachment -- so the untouched original streams to
    // disk without the page ever holding it.
    const download = screen.getByRole("link", { name: /download original/i });
    expect(download.getAttribute("href")).toBe("/api/jobs/job_still_1/result-file");
    expect(download).toHaveAttribute("download");

    await userEvent.click(screen.getByRole("button", { name: /open preview/i }));

    const fullscreen = screen.getByRole("dialog", { name: /fullscreen image preview/i });
    const preview = within(fullscreen).getByRole("img") as HTMLImageElement;
    // Fullscreen is a bigger rendition, still not the original.
    expect(preview.getAttribute("src")).toBe("/api/media/thumbnail?path=out.png&w=1440");
  });

  it("pluralizes the count", () => {
    renderPanel([stillJob(), stillJob({ id: "job_still_2" })]);
    expect(screen.getByText("2 generated results")).toBeInTheDocument();
  });

  it("shows the error message for a failed job instead of a pending placeholder", () => {
    renderPanel([stillJob({ status: "failed", resultUrl: undefined, resultUrls: [], errorMessage: "Pod ran out of VRAM." })]);

    expect(screen.getByText("This job failed")).toBeInTheDocument();
    expect(screen.getByText("Pod ran out of VRAM.")).toBeInTheDocument();
    expect(screen.queryByAltText("Result for Pro Upscaler")).not.toBeInTheDocument();
  });

  it("does not show a stale result image while a job is still running", () => {
    // resultUrl can be populated from a previous attempt on retry; only a completed
    // job should display one.
    renderPanel([stillJob({ status: "running" })]);
    expect(screen.queryByAltText("Result for Pro Upscaler")).not.toBeInTheDocument();
  });

  it("reports the phase a running job is actually in", () => {
    renderPanel([
      stillJob({
        status: "running",
        runpodProgress: {
          phase: "queued",
          runpodStatus: "IN_QUEUE",
          phaseStartedAt: new Date().toISOString(),
        },
      }),
    ]);

    expect(screen.getByText("Waiting for a worker")).toBeInTheDocument();
    // RunPod's own status string is deliberately not shown: "IN_QUEUE" is
    // jargon, and the label above already says it in English.
    expect(screen.queryByText("IN_QUEUE")).not.toBeInTheDocument();
  });

  it("shows the real queue wait once RunPod reports it", () => {
    renderPanel([
      stillJob({
        status: "running",
        runpodProgress: {
          phase: "running",
          runpodStatus: "IN_PROGRESS",
          workerId: "fcphj8m6z5rcyy",
          delayMs: 11673,
          phaseStartedAt: new Date().toISOString(),
        },
      }),
    ]);

    expect(screen.getByText(/Processing on the worker/)).toBeInTheDocument();

    // Real figures from RunPod, not a synthesised percentage: 11673ms of queue
    // time, rounded to the second.
    expect(screen.getByText(/queued 12s/)).toBeInTheDocument();
    // The worker id is not shown. It is support detail rather than something an
    // artist waiting on a render needs; it stays on the job record and in logs.
    expect(screen.queryByText(/fcphj8m6/)).not.toBeInTheDocument();
  });

  it("shows finished steps above the current one, so progress is visible", () => {
    // The single line this replaced answered "what now?" but never "how far?".
    renderPanel([
      stillJob({
        status: "running",
        runpodProgress: {
          phase: "running",
          detail: "Sampling tiles",
          stepDone: 11,
          stepTotal: 30,
          item: 6,
          completedSteps: ["Loading the input image", "Resizing the image", "Building the mask"],
          phaseStartedAt: new Date().toISOString(),
        },
      }),
    ]);

    expect(screen.getByText("Loading the input image")).toBeInTheDocument();
    expect(screen.getByText("Building the mask")).toBeInTheDocument();
    expect(screen.getByText("Sampling tiles")).toBeInTheDocument();
    // The tile number is what stops a restarting step count reading as a fault.
    expect(screen.getByText(/tile 6 · step 11\/30/)).toBeInTheDocument();
  });

  it("leads with what the worker itself reported, keeping the phase as context", () => {
    // The stream names the ComfyUI node running right now; "Sampling tiles" is
    // the answer someone watching a slow render is actually after.
    renderPanel([
      stillJob({
        status: "running",
        runpodProgress: {
          phase: "running",
          runpodStatus: "IN_PROGRESS",
          detail: "Sampling tiles",
          phaseStartedAt: new Date().toISOString(),
        },
      }),
    ]);

    expect(screen.getByText("Sampling tiles")).toBeInTheDocument();
    // The phase drops to the footer once the worker has something specific to
    // say, so it reads as context rather than competing with the live step.
    expect(screen.getByText(/Processing on the worker/)).toBeInTheDocument();
  });

  it("falls back to the job status when no phase has been reported yet", () => {
    // Older jobs, and any job the dispatcher has not picked up, carry no phase.
    renderPanel([stillJob({ status: "queued", resultUrl: undefined, resultUrls: [] })]);
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("labels each input when a preset takes several", () => {
    renderPanel([
      stillJob({
        inputImages: ["/api/media?path=a.png", "/api/media?path=b.png"],
        workflowOptions: {
          stillImage: { categoryId: "reference-generator", settings: {} },
          save: { cameraNumber: "0001" },
        },
      }),
    ]);

    expect(screen.getByText("Input 1")).toBeInTheDocument();
    expect(screen.getByText("Input 2")).toBeInTheDocument();
  });

  it("falls back gracefully when a job has no prompt", () => {
    renderPanel([stillJob({ prompt: "" })]);
    expect(screen.getByText("No prompt for this preset.")).toBeInTheDocument();
  });
});

// jobSection's own cases live in features/still-images/jobSection.test.ts, next to
// the module, so they are not tied to this component rendering.
