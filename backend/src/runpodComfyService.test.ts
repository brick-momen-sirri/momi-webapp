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
  const submissions: Array<{ jobId: string; status: string }> = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return jsonResponse({ id: "job-progress", status: "IN_PROGRESS" });
    }
    assert.deepEqual(submissions, [{ jobId: "job-progress", status: "IN_PROGRESS" }]);
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
    onSubmitted: (submission) => {
      submissions.push(submission);
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /\/status\/job-progress$/);
  assert.equal(result.media[0]?.isVideo, true);
});

test("resume polls an acknowledged job id without submitting the workflow again", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return jsonResponse({
      id: "job-resume",
      status: "COMPLETED",
      output: { images: [{ filename: "result.png", url: "https://cdn.example/result.png" }] },
    });
  };

  const result = await service.resumeComfyWorkflowOnRunpod({
    jobId: "job-resume",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "GET");
  assert.match(calls[0]?.url ?? "", /\/status\/job-resume$/);
  assert.equal(result.jobId, "job-resume");
});

test("cancel posts to the acknowledged RunPod job without resubmitting", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return jsonResponse({ id: "job-cancel-remote", status: "CANCELLED" });
  };

  const result = await service.cancelComfyWorkflowOnRunpod("job-cancel-remote", fetchImpl as typeof fetch);

  assert.deepEqual(calls, [{
    url: "https://api.runpod.ai/v2/endpoint-test/cancel/job-cancel-remote",
    method: "POST",
  }]);
  assert.equal(result.status, "CANCELLED");
});

test("cancellation is checked before every RunPod status poll", async () => {
  let cancelRequested = false;
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url));
    cancelRequested = true;
    return jsonResponse({ id: "job-cancel", status: "IN_PROGRESS" });
  };

  await assert.rejects(
    service.runComfyWorkflowOnRunpod({
      workflow: {},
      images: [],
      fetchImpl: fetchImpl as typeof fetch,
      shouldCancel: () => cancelRequested,
    }),
    (error) => error instanceof service.RunpodComfyCanceledError,
  );

  assert.equal(calls.length, 1, "no status request should be sent after cancellation");
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

test("old RunPod image-only response keeps media behavior and no text artifacts", async () => {
  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: jsonFetch({
      id: "job-image-only",
      status: "COMPLETED",
      output: {
        success: true,
        images: [{ filename: "preview.png", type: "s3_url", data: "https://cdn.example/preview.png" }],
      },
    }) as typeof fetch,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]?.url, "https://cdn.example/preview.png");
  assert.equal(result.textArtifacts.length, 0);
  assert.equal(result.generatedText, undefined);
});

test("RunPod response with inline texts returns generated prompt before file artifacts", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url) === "https://cdn.example/seedance_prompt.txt") {
      return new Response("FILE TEXT SHOULD NOT WIN", {
        headers: { "content-type": "text/plain" },
      });
    }

    return jsonResponse({
      id: "job-inline-text",
      status: "COMPLETED",
      output: {
        success: true,
        images: [{ filename: "preview.png", type: "s3_url", data: "https://cdn.example/preview.png" }],
        files: [{ filename: "seedance_prompt.txt", type: "s3_url", data: "https://cdn.example/seedance_prompt.txt" }],
        texts: [{ filename: "seedance_prompt.txt", text: "SCENE CONTEXT\nInline Seedance prompt." }],
      },
    });
  };

  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(result.media.length, 1);
  assert.equal(result.generatedText, "SCENE CONTEXT\nInline Seedance prompt.");
  assert.equal(result.textArtifacts[0]?.source, "texts");
  assert.equal(result.textArtifacts[0]?.filename, "seedance_prompt.txt");
  assert.equal(calls.includes("https://cdn.example/seedance_prompt.txt"), false);
});

test("text file artifacts are read separately from media outputs", async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url) === "https://cdn.example/seedance_prompt.txt") {
      return new Response("SCENE CONTEXT\nA Seedance prompt from a generated text file.", {
        headers: { "content-type": "text/plain" },
      });
    }

    return jsonResponse({
      id: "job-text-file",
      status: "COMPLETED",
      output: {
        images: [{ filename: "preview.png", url: "https://cdn.example/preview.png" }],
        files: [{ filename: "seedance_prompt.txt", type: "s3_url", data: "https://cdn.example/seedance_prompt.txt" }],
      },
    });
  };

  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]?.filename, "preview.png");
  assert.equal(result.generatedText, "SCENE CONTEXT\nA Seedance prompt from a generated text file.");
  assert.equal(result.textArtifacts[0]?.filename, "seedance_prompt.txt");
});

test("direct worker output with texts is parsed without RunPod wrapper", async () => {
  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: jsonFetch({
      success: true,
      images: [{ filename: "preview.png", url: "https://cdn.example/preview.png" }],
      texts: [{ filename: "seedance_prompt_00001.txt", text: "SCENE CONTEXT\nDirect worker text." }],
    }) as typeof fetch,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.media[0]?.filename, "preview.png");
  assert.equal(result.generatedText, "SCENE CONTEXT\nDirect worker text.");
  assert.equal(result.textArtifacts[0]?.source, "texts");
});

test("Comfy history string outputs are treated as generated text", async () => {
  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: jsonFetch({
      id: "job-history-string",
      status: "COMPLETED",
      output: {
        outputs: {
          "6": {
            string: ["SCENE CONTEXT\nSeedance prompt from Comfy history."],
          },
        },
      },
    }) as typeof fetch,
  });

  assert.equal(result.generatedText, "SCENE CONTEXT\nSeedance prompt from Comfy history.");
  assert.equal(result.textArtifacts[0]?.source, "string");
});

test("response with no text artifacts does not crash", async () => {
  const result = await service.runComfyWorkflowOnRunpod({
    workflow: {},
    images: [],
    fetchImpl: jsonFetch({
      id: "job-no-text",
      status: "COMPLETED",
      output: {
        success: true,
        files: [{ filename: "preview.webp", type: "s3_url", data: "https://cdn.example/preview.webp" }],
      },
    }) as typeof fetch,
  });

  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]?.filename, "preview.webp");
  assert.equal(result.textArtifacts.length, 0);
  assert.equal(result.generatedText, undefined);
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

function jsonFetch(body: unknown) {
  return async () => jsonResponse(body);
}
