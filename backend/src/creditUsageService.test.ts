// creditUsageService reconciles what the app *estimated* a job would cost against
// what the Credit Portal actually recorded, keyed by ComfyUI prompt id. Those
// figures end up in the credit dashboard and in per-project spend, so the parsing
// rules matter: a row whose credits arrive as the string "12.4" must count, and a
// row with no prompt id must not silently become someone else's spend.
//
// The module memoises both lookups behind a TTL, which means a single import can
// only ever observe one fetch outcome. Each scenario therefore imports a fresh copy
// via a unique query suffix -- Node's ESM loader keys its module cache on the full
// specifier, so "./creditUsageService.js?case=1" is a genuinely separate instance
// with its own empty cache.

import assert from "node:assert/strict";
import test from "node:test";

process.env.COMFY_SERVERS = "http://127.0.0.1:8201";

type Reply = { ok?: boolean; status?: number; body?: unknown };

let caseCounter = 0;

/** A fresh module instance plus a fetch stub answering by URL substring. */
async function withFetch(replies: Array<[match: string, reply: Reply]>) {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = replies.find(([match]) => url.includes(match));
    const reply = hit?.[1] ?? { ok: false, status: 404 };
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.body ?? {},
    } as Response;
  }) as typeof fetch;

  caseCounter += 1;
  const service = await import(`./creditUsageService.js?case=${caseCounter}`);
  return {
    service: service as typeof import("./creditUsageService.js"),
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("getActualCreditsByPromptIds returns nothing without asking when given no ids", async () => {
  const { service, calls, restore } = await withFetch([]);
  try {
    assert.equal((await service.getActualCreditsByPromptIds([])).size, 0);
    assert.equal((await service.getActualCreditsByPromptIds(["  ", ""])).size, 0);
    // No prompt ids means no reason to touch the Credit Portal at all.
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("maps recorded credits onto the requested prompt ids only", async () => {
  const { service, restore } = await withFetch([
    [
      "usage-rows",
      {
        body: {
          rows: [
            { prompt_id: "prompt_a", estimated_credits: 12 },
            { prompt_id: "prompt_b", estimated_credits: 30 },
          ],
        },
      },
    ],
  ]);
  try {
    const result = await service.getActualCreditsByPromptIds(["prompt_a"]);
    assert.deepEqual([...result.entries()], [["prompt_a", 12]]);
    // prompt_b was recorded but not asked for; leaking it would attribute another
    // job's spend to this one.
    assert.equal(result.has("prompt_b"), false);
  } finally {
    restore();
  }
});

test("accepts numeric credits sent as strings, keeping fractional precision", async () => {
  const { service, restore } = await withFetch([
    ["usage-rows", { body: { rows: [{ prompt_id: "prompt_a", estimated_credits: "12.4" }] } }],
  ]);
  try {
    // Deliberately not rounded to a whole credit: these are real recorded charges,
    // and truncating each one would drift the reconciled total away from the
    // Credit Portal's own figure.
    assert.equal((await service.getActualCreditsByPromptIds(["prompt_a"])).get("prompt_a"), 12.4);
  } finally {
    restore();
  }
});

test("rounds recorded credits at four decimal places", async () => {
  const { service, restore } = await withFetch([
    ["usage-rows", { body: { rows: [{ prompt_id: "prompt_a", estimated_credits: 0.123456789 }] } }],
  ]);
  try {
    assert.equal((await service.getActualCreditsByPromptIds(["prompt_a"])).get("prompt_a"), 0.1235);
  } finally {
    restore();
  }
});

test("ignores rows with no prompt id or an unusable credit value", async () => {
  const { service, restore } = await withFetch([
    [
      "usage-rows",
      {
        body: {
          rows: [
            { prompt_id: "", estimated_credits: 99 },
            { prompt_id: "prompt_a", estimated_credits: "not a number" },
            { prompt_id: "prompt_b", estimated_credits: null },
            { estimated_credits: 50 },
            { prompt_id: "prompt_c", estimated_credits: 7 },
          ],
        },
      },
    ],
  ]);
  try {
    const result = await service.getActualCreditsByPromptIds(["prompt_a", "prompt_b", "prompt_c"]);
    assert.deepEqual([...result.entries()], [["prompt_c", 7]]);
  } finally {
    restore();
  }
});

test("trims the prompt ids it is asked about", async () => {
  const { service, restore } = await withFetch([
    ["usage-rows", { body: { rows: [{ prompt_id: "prompt_a", estimated_credits: 5 }] } }],
  ]);
  try {
    assert.equal((await service.getActualCreditsByPromptIds(["  prompt_a  "])).get("prompt_a"), 5);
  } finally {
    restore();
  }
});

test("returns an empty map rather than throwing when the tracker is unreachable", async () => {
  const { service, restore } = await withFetch([["usage-rows", { ok: false, status: 503 }]]);
  try {
    // A dead Credit Portal must not fail the job list that asked for reconciliation.
    assert.equal((await service.getActualCreditsByPromptIds(["prompt_a"])).size, 0);
  } finally {
    restore();
  }
});

test("caches the usage lookup instead of refetching per call", async () => {
  const { service, calls, restore } = await withFetch([
    ["usage-rows", { body: { rows: [{ prompt_id: "prompt_a", estimated_credits: 5 }] } }],
  ]);
  try {
    await service.getActualCreditsByPromptIds(["prompt_a"]);
    await service.getActualCreditsByPromptIds(["prompt_a"]);
    // The job list reconciles many jobs at once; one round trip serves them all.
    assert.equal(calls.filter((url) => url.includes("usage-rows")).length, 1);
  } finally {
    restore();
  }
});

test("project stats merge all-time totals with the current month", async () => {
  const { service, calls, restore } = await withFetch([
    [
      "from=",
      {
        body: {
          by_project: [{ project_name: "Glass Tower", total_runs: 2, total_estimated_credits: 40, total_estimated_usd: 1 }],
        },
      },
    ],
    [
      "summary",
      {
        body: {
          by_project: [{ project_name: "Glass Tower", total_runs: 10, total_estimated_credits: 200, total_estimated_usd: 5 }],
        },
      },
    ],
  ]);
  try {
    const stats = await service.getCreditTrackerProjectStats();
    const tower = stats.get("Glass Tower");

    assert.equal(tower?.trackedRuns, 10);
    assert.equal(tower?.creditsUsed, 200);
    // The month figures come from the date-filtered request, not the all-time one.
    assert.equal(tower?.monthTrackedRuns, 2);
    assert.equal(tower?.monthCreditsUsed, 40);
    // Two requests: unfiltered, then filtered to this calendar month.
    assert.equal(calls.filter((url) => url.includes("summary")).length, 2);
    assert.ok(calls.some((url) => url.includes("from=") && url.includes("to=")));
  } finally {
    restore();
  }
});

test("a project seen only this month still appears, with zero all-time history", async () => {
  const { service, restore } = await withFetch([
    ["from=", { body: { by_project: [{ project_name: "Brand New", total_runs: 1, total_estimated_credits: 10 }] } }],
    ["summary", { body: { by_project: [] } }],
  ]);
  try {
    const stats = await service.getCreditTrackerProjectStats();
    const project = stats.get("Brand New");
    assert.equal(project?.monthCreditsUsed, 10);
    assert.equal(project?.creditsUsed, 0);
  } finally {
    restore();
  }
});

test("project stats read the federated shape when the tracker sends one", async () => {
  const { service, restore } = await withFetch([
    [
      "summary",
      {
        body: {
          by_project: [{ project_name: "Ignored", total_estimated_credits: 1 }],
          federated: { by_project: [{ project_name: "Federated Tower", total_estimated_credits: 99 }] },
        },
      },
    ],
  ]);
  try {
    const stats = await service.getCreditTrackerProjectStats();
    // A federated response aggregates several trackers; the top-level list is the
    // single-node fallback and must lose to it.
    assert.ok(stats.has("Federated Tower"));
    assert.equal(stats.has("Ignored"), false);
  } finally {
    restore();
  }
});

test("project rows without a usable name are skipped", async () => {
  const { service, restore } = await withFetch([
    [
      "summary",
      {
        body: {
          by_project: [
            { project_name: "  ", total_estimated_credits: 5 },
            { total_estimated_credits: 5 },
            { project_name: "Real Project", total_estimated_credits: 5 },
          ],
        },
      },
    ],
  ]);
  try {
    const stats = await service.getCreditTrackerProjectStats();
    assert.deepEqual([...stats.keys()], ["Real Project"]);
  } finally {
    restore();
  }
});

test("project stats resolve to an empty map when every tracker fails", async () => {
  const { service, restore } = await withFetch([["summary", { ok: false, status: 500 }]]);
  try {
    assert.equal((await service.getCreditTrackerProjectStats()).size, 0);
  } finally {
    restore();
  }
});

test("negative or missing totals are floored rather than passed through", async () => {
  const { service, restore } = await withFetch([
    ["summary", { body: { by_project: [{ project_name: "Odd Data", total_runs: -5 }] } }],
  ]);
  try {
    const project = (await service.getCreditTrackerProjectStats()).get("Odd Data");
    // A negative run count would read as a credit back on the dashboard.
    assert.equal(project?.trackedRuns, 0);
    assert.equal(project?.creditsUsed, 0);
    assert.equal(project?.usdUsed, 0);
  } finally {
    restore();
  }
});
