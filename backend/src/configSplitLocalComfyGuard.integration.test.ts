import assert from "node:assert/strict";
import test from "node:test";

process.env.ROLE = "api";
process.env.JOB_STORE_DRIVER = "sqlite";
process.env.JOBS_ROW_LEVEL_WRITES = "true";
process.env.APP_STATE_DRIVER = "sqlite";
process.env.GENERATION_BACKEND = "local_comfy";

const { validateRuntimeConfigForStartup } = await import("./config.js");

test("split roles refuse the process-local Comfy pool", () => {
  assert.throws(
    () => validateRuntimeConfigForStartup(),
    /does not support GENERATION_BACKEND=local_comfy/,
  );
});
