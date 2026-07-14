import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";
process.env.RUNPOD_POLL_INTERVAL_MS = "1";
process.env.RUNPOD_TIMEOUT_MS = "1000";

const service = await import("./runpodComfyService.js");

test("runsync returns COMPLETED", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      id: "job-complete",
      status: "COMPLETED",
      output: {
        videos: [{ filename: "ComfyUI_00001_.mp4", type: "s3_url", data: "https://cdn.example/video.mp4" }],
        credit_usage: { total_estimated_credits: 10, total_estimated_usd: 0.0474, source: "worker" },
      },
    });
  };

  const result = await service.runComfyWorkflowOnRunpod({
    workflow: { "1": { class_type: "LoadImage", inputs: { image: "boxing.png" } } },
    images: [{ name: "boxing.png", image: "data:image/png;base64,AAA=" }],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 1);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.jobId, "job-complete");
  assert.equal(result.media[0]?.url, "https://cdn.example/video.mp4");
  assert.equal(result.creditUsage?.total_estimated_credits, 10);

  const payload = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(payload.input.images[0].name, "boxing.png");
  assert.equal(payload.input.comfy_org_api_key, "comfy-key-test");
});

test("runsync returns IN_PROGRESS then status COMPLETED", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return jsonResponse({ id: "job-progress", status: "IN_PROGRESS" });
    }
    return jsonResponse({
      id: "job-progress",
      status: "COMPLETED",
      output: { files: [{ filename: "result.webm", url: "https://cdn.example/result.webm" }] },
    });
  };

  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /\/status\/job-progress$/);
  assert.equal(result.media[0]?.isVideo, true);
});

test("video inputs are submitted as named worker input files", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      id: "job-video-input",
      status: "COMPLETED",
      output: { videos: [{ filename: "edited.mp4", url: "https://cdn.example/edited.mp4" }] },
    });
  };

  await service.runComfyWorkflowOnRunpod({
    workflow: { "25": { class_type: "LoadVideo", inputs: { file: "source.mp4" } } },
    images: [{ name: "reference.png", image: "data:image/png;base64,AAA=" }],
    videos: [{ name: "source.mp4", image: "data:video/mp4;base64,BBB=" }],
    fetchImpl: fetchImpl as typeof fetch,
  });

  const payload = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(payload.input.images.length, 2);
  assert.equal(payload.input.images[1].name, "source.mp4");
  assert.equal(payload.input.images[1].image, "data:video/mp4;base64,BBB=");
});

test("URL inputs are submitted without inline base64 media", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      id: "job-url-input",
      status: "COMPLETED",
      output: { images: [{ filename: "edited.png", url: "https://cdn.example/edited.png" }] },
    });
  };

  await service.runComfyWorkflowOnRunpod({
    workflow: { "1": { class_type: "LoadImage", inputs: { image: "reference.png" } } },
    images: [{ name: "reference.png", url: "https://backend.example/api/runpod-input?token=signed" }],
    fetchImpl: fetchImpl as typeof fetch,
  });

  const payload = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(payload.input.images[0].name, "reference.png");
  assert.equal(payload.input.images[0].url, "https://backend.example/api/runpod-input?token=signed");
  assert.equal(payload.input.images[0].image, undefined);
});

test("FAILED unauthorized response includes clear Comfy API message", async () => {
  const fetchImpl = async () => jsonResponse({
    id: "job-failed",
    status: "FAILED",
    output: {
      message: "Unauthorized: Please login first to use this node.",
    },
  });

  await assert.rejects(
    service.runComfyWorkflowOnRunpod({ workflow: {}, images: [], fetchImpl: fetchImpl as typeof fetch }),
    /COMFY_ORG_API_KEY is missing, invalid, or was not accepted/,
  );
});

test("video output under images is detected", () => {
  const media = service.extractRunpodMedia({
    images: [{ filename: "ComfyUI_00001_.mp4", type: "s3_url", data: "https://cdn.example/ComfyUI_00001_.mp4" }],
  });

  assert.equal(media.length, 1);
  assert.equal(media[0]?.isVideo, true);
  assert.equal(media[0]?.source, "images");
});

test("credit_usage is normalized for display", () => {
  const creditUsage = service.normalizeRunpodCreditUsage({
    total_estimated_credits: 21.1,
    total_estimated_usd: 0.1,
    source: "runpod_worker",
    per_node: [
      {
        node_id: "12",
        node_title: "Kling",
        class_type: "KlingFirstLastFrameNode",
        total_estimated_credits: 21.1,
        total_estimated_usd: 0.1,
      },
    ],
  });

  assert.equal(creditUsage?.total_estimated_credits, 21.1);
  assert.equal(creditUsage?.total_estimated_usd, 0.1);
  assert.equal(creditUsage?.source, "runpod_worker");
  assert.equal(creditUsage?.rows?.[0]?.node_title, "Kling");
});

test("empty none credit_usage is treated as missing", () => {
  const creditUsage = service.normalizeRunpodCreditUsage({
    total_estimated_credits: 0,
    total_estimated_usd: 0,
    source: "none",
  });

  assert.equal(creditUsage, undefined);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
