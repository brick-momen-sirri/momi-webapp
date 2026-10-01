import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Result links in a real browser against the compiled gateway, with the API's
// response times set to production's measured medians (pm2 api logs, 2026-10-01).
// /api/credits and /api/snapshot dominate: both wait on the Comfy credit tracker.

const apiBase = "http://127.0.0.1:13339";
// E2E_CREDITS_MS overrides the two credit-bound endpoints, to measure what a cached
// balance would change.
const creditsMs = process.env.E2E_CREDITS_MS ? Number(process.env.E2E_CREDITS_MS) : undefined;
const PRODUCTION_MEDIANS_MS = {
  "/api/credits": creditsMs ?? 1570,
  "/api/snapshot": creditsMs ?? 1595,
  "/api/jobs": 210,
  "/api/projects": 256,
  "/api/usage/monthly": 43,
  "/api/pods/status": 149,
  "/api/jobs/:id": 1,
};
const LINK = "/?result=job_link_target";

type Logged = { method: string; path: string; search: string; at: number };

async function useProductionLatency(request: APIRequestContext) {
  await request.post(`${apiBase}/api/e2e/latency`, { data: PRODUCTION_MEDIANS_MS });
  await request.post(`${apiBase}/api/e2e/requests/reset`);
}

async function requestsSince(request: APIRequestContext, since: number) {
  const { requests } = (await request.get(`${apiBase}/api/e2e/requests`).then((response) => response.json())) as {
    requests: Logged[];
  };
  return requests.filter((entry) => entry.at >= since);
}

/** "+ms METHOD path" per request, relative to the start of the measured step. */
function timeline(requests: Logged[], since: number) {
  return requests.map((entry) => `+${entry.at - since} ${entry.method} ${entry.path}${entry.search.includes("folderId") ? " (folder)" : ""}`);
}

function tally(requests: Logged[]) {
  const counts: Record<string, number> = {};
  for (const entry of requests) counts[`${entry.method} ${entry.path}`] = (counts[`${entry.method} ${entry.path}`] ?? 0) + 1;
  return counts;
}

async function signIn(page: Page) {
  await page.getByLabel("Email").fill("artist@brickvisual.com");
  await page.getByLabel("Password").fill("not-a-production-password");
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Each workspace endpoint is asked once: the link decides the project before the load. */
function expectSingleWorkspaceLoad(requests: Logged[]) {
  const counts = tally(requests);
  for (const endpoint of ["GET /api/models", "GET /api/projects", "GET /api/jobs", "GET /api/credits", "GET /api/users"]) {
    expect(counts[endpoint], endpoint).toBe(1);
  }
  const page = requests.find((entry) => entry.path === "/api/jobs");
  expect(page?.search).toContain("projectId=proj_marina");
  expect(page?.search).toContain("folderId=fld_shot2");
}

function report(name: string, values: Record<string, unknown>) {
  test.info().annotations.push({ type: name, description: JSON.stringify(values) });
  console.log(`[result-link] ${name} ${JSON.stringify(values)}`);
}

test.describe("opening a shared result link", () => {
  test("a signed-out colleague signs in and lands on the result, which stays in view", async ({ page, request }) => {
    await useProductionLatency(request);
    await page.goto(LINK);
    await expect(page.getByText("Sign in to open the result that was shared with you.")).toBeVisible();

    const started = Date.now();
    await signIn(page);
    const card = page.locator('[data-linked="true"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toBeInViewport();
    const visibleAfterMs = Date.now() - started;
    await expect(card).toContainText("Shared marina flythrough");

    // Let every follow-up load land, then check the card was not pushed away.
    await page.waitForTimeout(8_000);
    await expect(page.locator("#result-card-job_link_target")).toBeInViewport();
    expect(new URL(page.url()).search).toBe("");

    const requests = await requestsSince(request, started);
    report("signed-out", { visibleAfterMs, requests: tally(requests), timeline: timeline(requests, started) });
    expectSingleWorkspaceLoad(requests);
  });

  test("a signed-in colleague opens the link in a new tab", async ({ page, context, request }) => {
    await page.goto("/");
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Generation Settings" })).toBeVisible();

    await useProductionLatency(request);
    const tab = await context.newPage();
    const started = Date.now();
    await tab.goto(LINK);
    const card = tab.locator('[data-linked="true"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toBeInViewport();
    const visibleAfterMs = Date.now() - started;
    await tab.waitForTimeout(8_000);
    await expect(tab.locator("#result-card-job_link_target")).toBeInViewport();

    const requests = await requestsSince(request, started);
    report("signed-in new tab", { visibleAfterMs, requests: tally(requests), timeline: timeline(requests, started) });
    expectSingleWorkspaceLoad(requests);
  });

  test("a link to a result outside the colleague's projects shows nothing of it", async ({ page, request }) => {
    await useProductionLatency(request);
    await page.goto("/?result=job_private");
    await signIn(page);
    await expect(page.getByText(/That result link can't be opened/)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-linked]")).toHaveCount(0);
    await expect(page.getByText("Not yours")).toHaveCount(0);
  });
});
