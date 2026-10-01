import { expect, test } from "@playwright/test";

// Copying a result link where production actually runs: over plain http on the
// studio network, which is not a secure context, so navigator.clipboard is absent.
// 127.0.0.1 would count as secure, so the app is reached under a mapped hostname.
// Top-level because it needs its own browser launch.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP momi.e2e 127.0.0.1"] } });

const apiBase = "http://127.0.0.1:13339";

async function signIn(page: import("@playwright/test").Page) {
  await page.getByLabel("Email").fill("artist@brickvisual.com");
  await page.getByLabel("Password").fill("not-a-production-password");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("copies the link through the fallback, without a prompt", async ({ page, context, request }) => {
  await request.post(`${apiBase}/api/e2e/latency`, { data: {} });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto("http://momi.e2e:18190/");
  expect(await page.evaluate(() => ({ secure: window.isSecureContext, clipboard: "clipboard" in navigator && Boolean(navigator.clipboard) }))).toEqual({
    secure: false,
    clipboard: false,
  });
  await signIn(page);
  const firstCard = page.locator("article[id^='result-card-']").first();
  await expect(firstCard).toBeVisible({ timeout: 20_000 });
  const jobId = (await firstCard.getAttribute("id"))?.replace("result-card-", "");

  const started = Date.now();
  await firstCard.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Link copied. Anyone with access to this project can open it.")).toBeVisible();
  const toastAfterMs = Date.now() - started;
  expect(dialogs).toEqual([]);

  // Read it back from a secure origin, which may read the clipboard.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:18190" });
  const reader = await context.newPage();
  await reader.goto("http://127.0.0.1:18190/");
  const copied = await reader.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`http://momi.e2e:18190/?result=${jobId}`);
  console.log(`[result-link] copy over http ${JSON.stringify({ toastAfterMs, copied })}`);
});
