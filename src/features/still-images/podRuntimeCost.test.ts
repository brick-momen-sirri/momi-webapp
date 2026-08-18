import { describe, expect, it } from "vitest";

import {
  formatPodRuntime,
  gpuDisplayName,
  measuredPodCredits,
  POD_RUNTIME_SOURCE,
  podCostExplanation,
} from "./podRuntimeCost";

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

describe("gpuDisplayName", () => {
  it("drops the vendor prefix every GPU shares", () => {
    expect(gpuDisplayName("NVIDIA GeForce RTX 5090")).toBe("GeForce RTX 5090");
    expect(gpuDisplayName("NVIDIA RTX PRO 6000 Blackwell Server Edition")).toBe("RTX PRO 6000 Blackwell Server Edition");
    expect(gpuDisplayName("  ")).toBeUndefined();
    expect(gpuDisplayName(undefined)).toBeUndefined();
  });
});

// The same preset legitimately costs two different amounts, because its endpoint
// accepts several GPU classes and the worker decides. Saying so on the card is what
// stops that looking like a bug.
describe("podCostExplanation", () => {
  it("names the seconds, the GPU and the rate behind a cost", () => {
    const explanation = podCostExplanation({
      creditsActual: 19,
      creditsActualSource: POD_RUNTIME_SOURCE,
      runpodTiming: { executionMs: 100_000, gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition", usdPerSecond: 0.0009215 },
    });

    expect(explanation).toContain("1m 40s of worker time");
    expect(explanation).toContain("on RTX PRO 6000 Blackwell Server Edition");
    expect(explanation).toContain("$0.0009215/s");
  });

  it("says why an uncosted run is uncosted", () => {
    // Three different gaps, one message: no worker time, no identified GPU, or no
    // rate for it. All of them mean "nobody measured this", not "it was free".
    const explanation = podCostExplanation({ runpodTiming: { executionMs: 100_000 } });
    expect(explanation).toContain("Not measured");
  });
});
