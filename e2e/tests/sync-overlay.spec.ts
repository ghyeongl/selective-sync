/**
 * The sync overlay must survive a rename without a page reload.
 *
 * Found barefoot against the staging container, driving the UI: select a file,
 * rename it with the app's own Rename button, and its checkbox goes empty and
 * stays empty — measured for 45s — while the backend has it selected and
 * synced the whole time. A full reload fixes it, which is what makes this a
 * frontend state bug rather than a pipeline one.
 *
 * Cause: the catalog keys on inode and a rename preserves it, so the SSE
 * handler still finds the entry and updates its status — but ListingItem
 * matches the overlay to rows by NAME, and the handler never applied the new
 * name the event already carries. The renamed row therefore matched nothing.
 *
 * This spec creates and removes its own fixture. It must not rename a shared
 * one: sync-stress asserts there are exactly 20 "small-*" files, and
 * copy-interrupt reaches for small-1.txt by name.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = process.env.E2E_ARCHIVES_DIR ?? path.join(TEST_DIR, "Archives");
const SPACES = process.env.E2E_SPACES_DIR ?? path.join(TEST_DIR, "Spaces");

const SRC = "overlay-src.txt";
const DST = "overlay-renamed.txt";

async function apiLogin(page: Page): Promise<string> {
  const jwt = await page.evaluate(() => localStorage.getItem("jwt") ?? "");
  if (jwt) return jwt;
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

async function syncEntry(page: Page, jwt: string, name: string) {
  return page.evaluate(
    async ({ jwt, name }) => {
      const resp = await fetch("/api/sync/entries?path=", {
        headers: { "X-Auth": jwt },
      });
      const body = await resp.json();
      return (body.items as any[]).find((i) => i.name === name) ?? null;
    },
    { jwt, name }
  );
}

test.afterAll(() => {
  for (const n of [SRC, DST]) {
    for (const root of [ARCHIVES, SPACES]) {
      fs.rmSync(path.join(root, n), { force: true });
    }
  }
});

test("renaming a synced file keeps its checkbox, with no reload", async ({
  page,
}) => {
  fs.writeFileSync(path.join(ARCHIVES, SRC), "overlay fixture");

  await page.goto("/");
  await page.waitForTimeout(3000);
  const jwt = await apiLogin(page);

  // Wait for the watcher to register it, then reload so the row is present.
  await expect
    .poll(async () => (await syncEntry(page, jwt, SRC)) !== null, {
      timeout: 30_000,
    })
    .toBe(true);
  await page.reload();
  await page.waitForTimeout(2000);

  // Select through the UI, and wait for the backend to agree.
  const row = page.locator(`[aria-label="${SRC}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const box = row.locator('input[type="checkbox"]');
  if (!(await box.isChecked())) {
    await box.click();
  }
  await expect
    .poll(async () => (await syncEntry(page, jwt, SRC))?.selected, {
      timeout: 60_000,
    })
    .toBe(true);

  // Rename with the app's own control — no reload from here on.
  await row.locator(".name").click();
  // Two Rename buttons exist (toolbar and #listing) and only one is visible,
  // so an unscoped locator is a strict-mode violation rather than a click.
  await page.locator('[aria-label="Rename"]:visible').first().click();
  const field = page
    .locator('.card.floating input, [role="dialog"] input')
    .first();
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill(DST);
  await page
    .locator(".card-action button:visible")
    .filter({ hasText: /rename|ok|confirm/i })
    .first()
    .click();

  // The backend must end with the renamed file still selected, so a failure
  // below is unambiguously about the frontend rather than the pipeline.
  await expect
    .poll(async () => (await syncEntry(page, jwt, DST))?.selected, {
      timeout: 60_000,
    })
    .toBe(true);

  // And the live page must show it, having never been reloaded.
  const renamedBox = page.locator(
    `[aria-label="${DST}"] input[type="checkbox"]`
  );
  await expect(renamedBox).toBeChecked({ timeout: 30_000 });
});
