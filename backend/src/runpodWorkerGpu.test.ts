process.env.RUNPOD_API_KEY = "runpod-key-test";

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

const { clearRunpodWorkerGpuCache, resolveRunpodWorkerGpu } = await import("./runpodWorkerGpu.js");

// The shapes RunPod actually returns, taken from probing the live account rather
// than from the docs -- including the one that matters most, a null pod for a worker
// that has already been torn down.
function stubFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => clearRunpodWorkerGpuCache());

test("resolves a worker to the GPU behind it", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      body: {
        data: {
          pod: {
            id: "bg5ns13fydoi5o",
            costPerHr: 0.59,
            machine: { gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb" },
          },
        },
      },
    },
  ]);

  const gpu = await resolveRunpodWorkerGpu("bg5ns13fydoi5o", fetchImpl);

  assert.deepEqual(gpu, {
    gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb",
    costPerHr: 0.59,
  });
  // The worker id goes in as a variable, not spliced into the query text.
  assert.deepEqual((calls[0].body as { variables: unknown }).variables, { input: { podId: "bg5ns13fydoi5o" } });
});

test("asks once per worker, however many jobs it runs", async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { data: { pod: { machine: { gpuTypeId: "NVIDIA A40" } } } } },
  ]);

  const first = await resolveRunpodWorkerGpu("wrk_warm", fetchImpl);
  const second = await resolveRunpodWorkerGpu("wrk_warm", fetchImpl);

  assert.equal(first?.gpuTypeId, "NVIDIA A40");
  assert.deepEqual(second, first);
  // A warm worker takes job after job, and each is polled every few seconds. Without
  // the cache this would be the same question for the life of the endpoint.
  assert.equal(calls.length, 1);
});

test("a torn-down worker resolves to nothing, and is not asked about again", async () => {
  // RunPod's answer for an id it no longer knows: data.pod is null, not an error.
  const { fetchImpl, calls } = stubFetch([{ body: { data: { pod: null } } }]);

  assert.equal(await resolveRunpodWorkerGpu("wrk_gone", fetchImpl), undefined);
  assert.equal(await resolveRunpodWorkerGpu("wrk_gone", fetchImpl), undefined);
  // The negative is cached too: a worker that has gone will not come back.
  assert.equal(calls.length, 1);
});

test("a failing lookup yields nothing rather than throwing", async () => {
  // This runs inside the poll loop of a job that is already rendering. It may cost a
  // cost, never a render.
  const { fetchImpl } = stubFetch([new Error("socket hang up")]);
  assert.equal(await resolveRunpodWorkerGpu("wrk_broken", fetchImpl), undefined);

  clearRunpodWorkerGpuCache();
  const unauthorized = stubFetch([{ status: 401, body: {} }]);
  assert.equal(await resolveRunpodWorkerGpu("wrk_unauthorized", unauthorized.fetchImpl), undefined);

  clearRunpodWorkerGpuCache();
  const nonsense = stubFetch([{ body: { errors: [{ message: "GraphQL validation failed" }] } }]);
  assert.equal(await resolveRunpodWorkerGpu("wrk_nonsense", nonsense.fetchImpl), undefined);
});

test("an answer without a GPU name is not an answer", async () => {
  const { fetchImpl } = stubFetch([{ body: { data: { pod: { costPerHr: 0.59, machine: { gpuTypeId: "   " } } } } }]);
  assert.equal(await resolveRunpodWorkerGpu("wrk_blank", fetchImpl), undefined);
});

test("no worker id, no request", async () => {
  const { fetchImpl, calls } = stubFetch([{ body: { data: { pod: null } } }]);
  assert.equal(await resolveRunpodWorkerGpu("", fetchImpl), undefined);
  assert.equal(calls.length, 0);
});
