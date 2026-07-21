import assert from "node:assert/strict";
import test from "node:test";

process.env.ROLE = "api";
process.env.GENERATION_BACKEND = "runpod";
process.env.RUNPOD_SUBMISSION_MODE = "async";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_ROW_LEVEL_WRITES = "true";
process.env.APP_STATE_DRIVER = "json";

const { validateRuntimeConfigForStartup } = await import("./config.js");

test("split roles refuse process-local JSON app state", () => {
  assert.throws(
    () => validateRuntimeConfigForStartup(),
    /APP_STATE_DRIVER=sqlite/,
  );
});
