import { expect, test } from "@playwright/test";

const apiBase = "http://127.0.0.1:13339";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("compiled production gateway supports local media upload and job submission", async ({ page, request }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  let jobRequestId: string | undefined;
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    const expectedAnonymousProbe = response.status() === 401 && new URL(response.url()).pathname === "/api/auth/me";
    if (response.status() >= 400 && !expectedAnonymousProbe) {
      failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
    if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/jobs") {
      jobRequestId = response.headers()["x-request-id"];
    }
  });

  await page.goto("/");
  await expect(page).toHaveTitle("Momi AI Generation Manager");

  const localFetch = await page.evaluate(async () => {
    const blobUrl = URL.createObjectURL(new Blob(["production-csp-probe"], { type: "text/plain" }));
    try {
      const [blobResponse, dataResponse] = await Promise.all([fetch(blobUrl), fetch("data:text/plain,production-csp-probe")]);
      return { blob: await blobResponse.text(), data: await dataResponse.text() };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  });
  expect(localFetch).toEqual({ blob: "production-csp-probe", data: "production-csp-probe" });

  await page.getByLabel("Email").fill("artist@brickvisual.com");
  await page.getByLabel("Password").fill("not-a-production-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Generation Settings" })).toBeVisible();
  expect(await inaccessibleInteractiveControls(page)).toEqual([]);
  await page.getByRole("button", { name: "Select project E2E Glass Tower" }).click();
  await page.getByLabel("Upload Input image").setInputFiles({
    name: "e2e-input.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByPlaceholder("Describe the generation you want...").fill("A glass tower at blue hour");
  await page.getByRole("button", { name: "Generate" }).click();

  await expect(page.getByText("Job sent to RunPod serverless.")).toBeVisible();
  const fixtureState = await request.get(`${apiBase}/api/e2e/state`).then((response) => response.json());
  expect(fixtureState.uploads).toEqual([
    expect.objectContaining({ bytes: onePixelPng.length, contentType: "image/png", projectId: "proj_e2e" }),
  ]);
  expect(fixtureState.submissions).toEqual([
    expect.objectContaining({
      projectId: "proj_e2e",
      modelId: "nano_banana_e2e",
      prompt: "A glass tower at blue hour",
      inputImages: ["/api/media?path=e2e-upload.png"],
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]{16,}$/),
    }),
  ]);
  expect(jobRequestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

async function inaccessibleInteractiveControls(page: import("@playwright/test").Page) {
  return page.locator("button, a[href], input, select, textarea").evaluateAll((elements) =>
    elements.flatMap((element, index) => {
      const control = element as HTMLInputElement;
      if (control.type === "hidden") return [];
      const labelled =
        control.labels?.length ||
        element.getAttribute("aria-label")?.trim() ||
        element.getAttribute("aria-labelledby")?.trim() ||
        element.getAttribute("title")?.trim() ||
        element.textContent?.trim();
      return labelled ? [] : [`${element.tagName.toLowerCase()}[${index}]`];
    }),
  );
}
