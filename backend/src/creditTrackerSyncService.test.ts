import assert from "node:assert/strict";
import test from "node:test";
import { buildCreditTrackerRows, configuredTrackerUrls, syncServerlessCreditUsage } from "./creditTrackerSyncService.js";
import type { CreditUsageSummary, Job, Project, WorkflowModel } from "./types.js";

test("credit_usage rows are mapped for Credit Tracker display", () => {
  const project = makeProject();
  const model = makeModel();
  const job = makeJob(project, model);
  const creditUsage: CreditUsageSummary = {
    total_estimated_credits: 21.1,
    total_estimated_usd: 0.1,
    source: "runpod_worker",
    rows: [
      {
        node_id: "12",
        node_title: "Kling",
        class_type: "KlingFirstLastFrameNode",
        total_estimated_credits: 21.1,
        total_estimated_usd: 0.1,
      },
    ],
  };

  const rows = buildCreditTrackerRows(project, job, model, creditUsage, ["C:\\media\\video.mp4"]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_name, "1234_TestOffice_TestProject");
  assert.equal(rows[0].partner_node_name, "Kling");
  assert.equal(rows[0].estimated_credits, 21.1);
  assert.equal(rows[0].estimated_usd, 0.1);
  assert.equal(rows[0].prompt_id, "runpod:rp-123");
  assert.equal(rows[0].source, "runpod_serverless");
  assert.match(rows[0].dedupe_key, /^runpod_serverless\|job-test\|rp-123\|12\|21\.1$/);
  assert.match(rows[0].input_summary, /video\.mp4/);
  assert.doesNotMatch(rows[0].input_summary, /data:image\/png;base64/);

  const inputSummary = JSON.parse(rows[0].input_summary);
  assert.deepEqual(inputSummary.input_images, [
    {
      index: 0,
      kind: "data_url",
      mime_type: "image/png",
      approximate_bytes: 2,
    },
  ]);
});

test("serverless credit usage posts to the first available Credit Tracker endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, inserted: 1, skipped: 0 }), {
      headers: { "content-type": "application/json" },
    });
  };

  const result = await syncServerlessCreditUsage({
    project: makeProject(),
    job: makeJob(makeProject(), makeModel()),
    model: makeModel(),
    creditUsage: {
      total_estimated_credits: 4,
      total_estimated_usd: 0.019,
      source: "runpod_worker",
    },
    trackerUrls: ["http://127.0.0.1:8201"],
    syncToken: "shared-test-token",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.inserted, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8201/credit-tracker/api/ingest-rows");
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-Credit-Tracker-Token"], "shared-test-token");

  const payload = JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.source_instance, "momi-runpod-serverless");
  assert.equal(payload.rows[0].estimated_credits, 4);
  assert.equal(payload.rows[0].project_name, "1234_TestOffice_TestProject");
});

test("serverless credit sync defaults to the main local Credit Tracker dashboard", () => {
  const previousUrls = process.env.CREDIT_TRACKER_URLS;
  const previousUrl = process.env.CREDIT_TRACKER_URL;
  const previousComfyUrl = process.env.COMFY_CREDIT_TRACKER_URL;
  delete process.env.CREDIT_TRACKER_URLS;
  delete process.env.CREDIT_TRACKER_URL;
  delete process.env.COMFY_CREDIT_TRACKER_URL;

  try {
    const urls = configuredTrackerUrls();

    assert.equal(urls[0], "http://127.0.0.1:8188");
    assert.ok(urls.includes("http://127.0.0.1:8201"));
  } finally {
    if (previousUrls === undefined) delete process.env.CREDIT_TRACKER_URLS;
    else process.env.CREDIT_TRACKER_URLS = previousUrls;
    if (previousUrl === undefined) delete process.env.CREDIT_TRACKER_URL;
    else process.env.CREDIT_TRACKER_URL = previousUrl;
    if (previousComfyUrl === undefined) delete process.env.COMFY_CREDIT_TRACKER_URL;
    else process.env.COMFY_CREDIT_TRACKER_URL = previousComfyUrl;
  }
});

function makeProject(): Project {
  return {
    id: "project-1",
    name: "Test Project",
    shortName: "TEST",
    folderPath: "C:\\ComfyUI\\output\\projects\\1234_TestOffice_TestProject",
    ownerId: "usr-test",
    members: [],
    groupMembers: [],
    jobCount: 0,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function makeModel(): WorkflowModel {
  return {
    id: "kling-v3-video",
    name: "Kling V3 Video",
    category: "image_to_video",
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\kling.json",
    requiredInputs: ["prompt", "single_image"],
    requiresPrompt: true,
    requiresImage: true,
    requiresStartEndFrames: false,
    outputType: "video",
  };
}

function makeJob(project: Project, model: WorkflowModel): Job {
  return {
    id: "job-test",
    runpodJobId: "rp-123",
    runpodStatus: "COMPLETED",
    projectId: project.id,
    userId: "usr-test",
    modelId: model.id,
    modelName: model.name,
    category: model.category,
    inputType: "single_image",
    prompt: "animated exterior",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: 5,
    status: "completed",
    inputImages: ["data:image/png;base64,AAA="],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "video",
    projectFolderPath: project.folderPath,
    workflowPath: model.workflowPath,
    creditsUsed: 21.1,
    source: "backend_job",
    createdAt: "2026-07-08T00:00:00.000Z",
    completedAt: "2026-07-08T00:02:00.000Z",
  };
}
