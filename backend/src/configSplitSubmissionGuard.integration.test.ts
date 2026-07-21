import assert from "node:assert/strict";
import test from "node:test";

process.env.ROLE = "dispatcher";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_ROW_LEVEL_WRITES = "true";
process.env.APP_STATE_DRIVER = "sqlite";
process.env.GENERATION_BACKEND = "runpod";
process.env.RUNPOD_SUBMISSION_MODE = "sync";

const { validateRuntimeConfigForStartup } = await import("./config.js");

test("split roles require durable asynchronous RunPod submissions", () => {
  assert.throws(
    () => validateRuntimeConfigForStartup(),
    /RUNPOD_SUBMISSION_MODE=async/,
  );
});
