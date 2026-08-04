import assert from "node:assert/strict";
import test from "node:test";

// OPS_ALLOW_LOOPBACK=false with no OPS_ACCESS_TOKEN leaves no way at all to
// reach /metrics or /ops-dashboard. That is always a mistake, and it is the kind
// of mistake that is invisible until an operator needs the dashboard during an
// incident -- so it fails at startup instead.

process.env.OPS_ACCESS_TOKEN = "";
process.env.OPS_ALLOW_LOOPBACK = "false";

const { validateRuntimeConfigForStartup } = await import("./config.js");

test("closing loopback with no token configured is refused at startup", () => {
  assert.throws(
    () => validateRuntimeConfigForStartup(),
    /would make \/metrics and \/ops-dashboard unreachable/,
  );
});
