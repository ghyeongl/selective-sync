/**
 * Selection guards — /api/sync/select and /api/sync/deselect.
 *
 * inode 0 is the parent_ino sentinel for the virtual root. Before the guard,
 * SetSelected([0]) fell through to a recursive walk of "WHERE parent_ino = 0",
 * which matches every top-level entry — so one request selected the entire
 * archive and began syncing all of it. Found by hand against the staging
 * container: a single {"inodes":[0]} flipped all 28 top-level entries to
 * selected and started copying a 1 GiB fixture.
 */
import { test, expect, type Page } from "@playwright/test";

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

async function post(page: Page, jwt: string, path: string, body: unknown) {
  return page.evaluate(
    async ({ jwt, path, body }) => {
      const resp = await fetch(path, {
        method: "POST",
        headers: { "X-Auth": jwt, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: resp.status, text: await resp.text() };
    },
    { jwt, path, body }
  );
}

async function listRoot(page: Page, jwt: string) {
  return page.evaluate(async (jwt) => {
    const resp = await fetch("/api/sync/entries?path=", { headers: { "X-Auth": jwt } });
    const body = await resp.json();
    return body.items as Array<{ inode: number; name: string; selected: boolean }>;
  }, jwt);
}

test("the virtual root cannot be selected, and selects nothing", async ({ page }) => {
  await page.goto("/");
  const jwt = await apiLogin(page);

  const before = await listRoot(page, jwt);
  const selectedBefore = before.filter((e) => e.selected).length;

  const res = await post(page, jwt, "/api/sync/select", { inodes: [0] });
  expect(res.status, `inode 0 must be rejected, got ${res.status}: ${res.text}`).toBe(400);

  await page.waitForTimeout(3000);

  const after = await listRoot(page, jwt);
  expect(
    after.filter((e) => e.selected).length,
    "no entry may become selected via the virtual root"
  ).toBe(selectedBefore);
});

test("the virtual root cannot deselect either", async ({ page }) => {
  await page.goto("/");
  const jwt = await apiLogin(page);
  const res = await post(page, jwt, "/api/sync/deselect", { inodes: [0] });
  expect(res.status).toBe(400);
});

test("malformed selection payloads are rejected, not silently accepted", async ({ page }) => {
  await page.goto("/");
  const jwt = await apiLogin(page);
  for (const body of [{ inodes: ["abc"] }, { inodes: [{}] }]) {
    const res = await post(page, jwt, "/api/sync/select", body);
    expect(res.status, `payload ${JSON.stringify(body)} should be 400`).toBe(400);
  }
});
