import { describe, expect, it } from "vitest";

import { formatPodRuntime, measuredPodCredits, POD_RUNTIME_SOURCE } from "./podRuntimeCost";

// The source string is a contract with the server: it is what separates a measured
// cost from a projection, and this side only ever recognises it. Asserted here the
// same way the seed bound is, because the pair cannot share a module.
describe("POD_RUNTIME_SOURCE", () => {
  it("matches the value backend/src/podRuntimeCost.ts stamps on a priced job", () => {
    expect(POD_RUNTIME_SOURCE).toBe("pod_runtime");
  });
});

describe("measuredPodCredits", () => {
  it("reads a figure priced from measured pod time", () => {
    expect(measuredPodCredits({ creditsActual: 42, creditsActualSource: POD_RUNTIME_SOURCE })).toBe(42);
  });

  it("refuses a figure from any other source", () => {
    // creditsActual can also hold a projection. Showing one as spend is what the
    // still-image exemption existed to prevent.
    expect(measuredPodCredits({ creditsActual: 42, creditsActualSource: "local_estimate" })).toBeUndefined();
    expect(measuredPodCredits({ creditsActual: 42 })).toBeUndefined();
    expect(measuredPodCredits({})).toBeUndefined();
  });

  it("treats zero as unmeasured", () => {
    // The backend never prices a run at zero, so a zero here came from somewhere
    // else -- and "0 cr" reads as free rather than unknown.
    expect(measuredPodCredits({ creditsActual: 0, creditsActualSource: POD_RUNTIME_SOURCE })).toBeUndefined();
  });
});

describe("formatPodRuntime", () => {
  it("reads seconds under a minute and minutes above one", () => {
    expect(formatPodRuntime({ runpodTiming: { executionMs: 42_000 } })).toBe("42s");
    expect(formatPodRuntime({ runpodTiming: { executionMs: 98_000 } })).toBe("1m 38s");
    // Padded, so a column of these lines up and 1m 8s cannot be misread as 1m 80s.
    expect(formatPodRuntime({ runpodTiming: { executionMs: 68_000 } })).toBe("1m 08s");
  });

  it("reports nothing when the worker time is unknown", () => {
    // A job that failed before a worker picked it up, so there is no worker time.
    expect(formatPodRuntime({ runpodTiming: { delayMs: 5_000 } })).toBeUndefined();
    expect(formatPodRuntime({})).toBeUndefined();
  });
});
