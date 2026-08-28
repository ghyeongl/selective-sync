/**
 * Boot state — must run before any other spec.
 *
 * This assertion ("everything starts archived") is only true of a freshly
 * seeded environment. It previously lived in sync-stress.spec.ts, which
 * Playwright runs fourth alphabetically, so by the time it executed the
 * copy-interrupt, duplicates and fs-crud specs had already selected and synced
 * things. It passed or failed depending on what they happened to leave behind.
 *
 * The filename sorts first so the claim in the test name is actually true.
 * Do not add stateful tests here.
 */
import { test, expect, type Page } from "@playwright/test";

async function apiLogin(page: Page): Promise<string> {
  const existing = await page.evaluate(() => localStorage.getItem("jwt") ?? "");
  if (existing) return existing;
  return page.evaluate(async () => {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "", password: "", recaptcha: "" }),
    });
    if (!resp.ok) throw new Error(`login failed: ${resp.status}`);
    return resp.text();
  });
}

test("server boots and the seed is registered, all archived", async ({ page }) => {
  await page.goto("/");
  const jwt = await apiLogin(page);

  const items = await page.evaluate(async (jwt) => {
    const resp = await fetch("/api/sync/entries?path=", { headers: { "X-Auth": jwt } });
    const body = await resp.json();
    return body.items as Array<{ name: string; status: string; selected: boolean }>;
  }, jwt);

  // 20 small + 5 medium + large + giant + test-dir
  expect(items.length).toBeGreaterThanOrEqual(27);

  const notArchived = items.filter((i) => i.status !== "archived");
  expect(
    notArchived,
    `a freshly seeded environment must start fully archived; found ${JSON.stringify(
      notArchived.map((i) => `${i.name}=${i.status}`)
    )}`
  ).toEqual([]);
});
