import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import { assertLtxCqFlfDelivered, ltxCqFlfWorkflowModel } from "./ltxCqFirstLastFrame.js";
import type { RunpodMediaResult } from "./runpodComfyService.js";
import { persistServerlessArtifacts } from "./serverlessArtifactService.js";
import type { Job, Project } from "./types.js";

// The dispatcher's completion gate end to end below the RunPod call: the worker's
// output is downloaded into the submitting user's project, cropped, checked, and
// only then can the job complete. Anything short of that is a failed job.

const execFileAsync = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "momi-ltx-cq-flf-delivery-"));

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const model = ltxCqFlfWorkflowModel();
const output: RunpodMediaResult = {
  url: "https://r2.example/momi/job_flf/FLF_CQ_00001_.mp4?X-Amz-Signature=secret",
  filename: "FLF_CQ_00001_.mp4",
  source: "videos",
  type: "s3_url",
  isVideo: true,
};

function project(name: string): Project {
  return {
    id: `prj_${name}`,
    name,
    shortName: name,
    folderPath: path.join(root, `1234_Studio_${name}`),
    ownerId: "usr_owner",
    members: [],
    groupMembers: [],
    jobCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function job(target: Project): Job {
  return {
    id: "job_flf",
    runpodJobId: "rp_flf",
    runpodStatus: "COMPLETED",
    projectId: target.id,
    userId: "usr_artist",
    modelId: model.id,
    modelName: model.name,
    category: model.category,
    inputType: "start_end_frames",
    prompt: "The camera glides from the lobby to the terrace.",
    resolution: { width: 1920, height: 1080, label: "1080p" },
    durationSeconds: 2,
    status: "running",
    inputImages: ["/api/media?path=first.png", "/api/media?path=last.png"],
    resultUrls: [],
    thumbnailUrls: [],
    outputType: "video",
    projectFolderPath: target.folderPath,
    workflowPath: model.workflowPath,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

async function render(name: string, frames: number) {
  const file = path.join(root, name);
  await execFileAsync(
    ffmpeg,
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1088:rate=24", "-frames:v", String(frames),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file],
    { timeout: 120_000, windowsHide: true },
  );
  return fs.readFile(file);
}

const serve = (bytes: Buffer | undefined) =>
  (async () =>
    bytes
      ? new Response(bytes, { headers: { "content-type": "video/mp4" } })
      : new Response("upstream failure", { status: 500 })) as typeof fetch;

test("a finished render is stored in the submitter's project, cropped to 1080 and checked before completion", async (t) => {
  let bytes: Buffer;
  try {
    bytes = await render("good.mp4", 49);
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }
  const target = project("Good");
  const current = job(target);
  const artifacts = await persistServerlessArtifacts({
    project: target,
    job: current,
    model,
    media: [output],
    selectedMedia: [output],
    fetchImpl: serve(bytes),
  });

  assert.doesNotThrow(() => assertLtxCqFlfDelivered(artifacts.selectedArtifacts));
  const saved = artifacts.selectedArtifacts[0].filePath ?? "";
  assert.ok(saved.startsWith(target.folderPath), saved);
  assert.deepEqual(artifacts.outputResolution && [artifacts.outputResolution.width, artifacts.outputResolution.height], [1920, 1080]);
  const { stdout } = await execFileAsync(
    ffprobe,
    ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate", "-of", "json", saved],
    { windowsHide: true },
  );
  const stream = (JSON.parse(stdout) as { streams: Array<Record<string, string | number>> }).streams[0];
  assert.deepEqual([stream.width, stream.height, Number(stream.nb_read_frames), stream.avg_frame_rate], [1920, 1080, 49, "24/1"]);

  // Filed under the user who submitted it, and the presigned signature is not kept.
  const records = (await fs.readFile(path.join(target.folderPath, "metadata", "manifest.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual([records.length, records[0].userId, records[0].jobId], [1, "usr_artist", "job_flf"]);
  assert.ok(!JSON.stringify(artifacts.resultRemoteRefs).includes("Signature"));
});

test("a render with the wrong length, or one that cannot be downloaded, fails the job instead", async (t) => {
  let short: Buffer;
  try {
    short = await render("short.mp4", 41);
  } catch {
    t.skip("ffmpeg unavailable");
    return;
  }
  for (const [name, bytes, reason] of [
    ["Short", short, /has 41 frames, expected 49/],
    ["Unreachable", undefined, /could not be saved/],
  ] as const) {
    const target = project(name);
    const artifacts = await persistServerlessArtifacts({
      project: target,
      job: job(target),
      model,
      media: [output],
      selectedMedia: [output],
      fetchImpl: serve(bytes),
    });
    assert.throws(() => assertLtxCqFlfDelivered(artifacts.selectedArtifacts), reason, name);
  }
});
