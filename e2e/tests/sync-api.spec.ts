/**
 * Coverage for the sync endpoints the suite never touched.
 *
 * Before this, e2e exercised only /entries, /select, /deselect and
 * /duplicates. /entry/{inode}, /stats, /dirsize and /events had ZERO coverage,
 * so a regression in any of them would have reached pi1 unnoticed.
 *
 * Behaviours here were established by probing the running staging container
 * first, not assumed: a bogus inode answers 404, /dirsize without its parameter
 * answers 400, and /stats reports Bavail rather than total free — which is why
 * it correctly showed diskFree: 0 on a runner whose disk was full for
 * unprivileged writes.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = process.env.E2E_ARCHIVES_DIR ?? path.join(TEST_DIR, "Archives");

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

async function get(page: Page, jwt: string, url: string) {
  return page.evaluate(
    async ({ jwt, url }) => {
      const r = await fetch(url, { headers: { "X-Auth": jwt } });
      return { status: r.status, body: await r.text() };
    },
    { jwt, url }
  );
}

test.describe("sync API endpoints", () => {
  test("/stats reports the figures the sidebar renders", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    const jwt = await apiLogin(page);

    const res = await get(page, jwt, "/api/sync/stats");
    expect(res.status).toBe(200);
    const stats = JSON.parse(res.body);

    // Every field the UI reads must be present and of the right kind — a
    // missing one renders as blank or NaN rather than failing loudly.
    for (const k of [
      "diskTotal",
      "diskFree",
      "archivesSize",
      "spacesSize",
      "queueLen",
    ]) {
      expect(typeof stats[k], `${k} should be a number`).toBe("number");
      expect(stats[k]).toBeGreaterThanOrEqual(0);
    }
    expect(stats.diskTotal).toBeGreaterThan(0);
    // diskFree is Bavail, so it can legitimately be 0 on a full disk, but it
    // can never exceed the total.
    expect(stats.diskFree).toBeLessThanOrEqual(stats.diskTotal);
    expect(typeof stats.statusCounts).toBe("object");
  });

  test("/entry/{inode} returns the entry, and 404s an unknown one", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    const jwt = await apiLogin(page);

    const listed = await get(page, jwt, "/api/sync/entries?path=");
    expect(listed.status).toBe(200);
    const items = JSON.parse(listed.body).items as Array<{
      inode: number;
      name: string;
    }>;
    expect(items.length).toBeGreaterThan(0);

    const one = items[0];
    const found = await get(page, jwt, `/api/sync/entry/${one.inode}`);
    expect(found.status).toBe(200);
    const entry = JSON.parse(found.body);
    expect(entry.inode).toBe(one.inode);
    expect(entry.name).toBe(one.name);

    // An inode no catalog row holds must be a clean 404, not an empty 200 —
    // "not found" and "here is nothing" are different answers, and the entries
    // endpoint once conflated exactly that (inode 0 IS the root).
    const missing = await get(page, jwt, "/api/sync/entry/999999999");
    expect(missing.status).toBe(404);
  });

  test("/dirsize streams sizes, and rejects a call with no inodes", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    const jwt = await apiLogin(page);

    const bad = await get(page, jwt, "/api/sync/dirsize");
    expect(bad.status).toBe(400);

    const notANumber = await get(page, jwt, "/api/sync/dirsize?inodes=abc");
    expect(notANumber.status).toBe(400);

    // A real directory streams a size event back.
    const listed = await get(page, jwt, "/api/sync/entries?path=");
    const dirs = (JSON.parse(listed.body).items as Array<{
      inode: number;
      type: string;
    }>).filter((i) => i.type === "dir");
    test.skip(dirs.length === 0, "no directory in the fixture to size");

    const streamed = await get(
      page,
      jwt,
      `/api/sync/dirsize?inodes=${dirs[0].inode}`
    );
    expect(streamed.status).toBe(200);
    expect(streamed.body).toContain("data:");
  });

  test("/events pushes a status change to a connected listener", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    const jwt = await apiLogin(page);

    const name = "sse-probe.txt";

    // Subscribe BEFORE causing the change. Writing the file first lets its
    // registration event fire while nothing is listening, and the test then
    // waits out its timeout for an event that already happened.
    const listener = page.evaluate(
      async ({ jwt, name }) => {
        return new Promise<string[]>((resolve) => {
          const seen: string[] = [];
          const es = new EventSource("/api/sync/events");
          const done = (r: string[]) => {
            es.close();
            resolve(r);
          };
          es.onmessage = (m) => {
            seen.push(m.data);
            try {
              const ev = JSON.parse(m.data);
              if (ev.name === name) done(seen);
            } catch {
              /* keepalive frames are not JSON */
            }
          };
          setTimeout(() => done(seen), 60_000);
        });
      },
      { jwt, name }
    );

    // Give the EventSource a moment to connect, then cause the change.
    await page.waitForTimeout(1500);
    fs.writeFileSync(path.join(ARCHIVES, name), "sse fixture");

    const received = await listener;
    expect(
      received.some((d) => d.includes(name)),
      `expected an event naming ${name}; saw ${received.length} frames`
    ).toBe(true);
  });
});

test.afterAll(() => {
  fs.rmSync(path.join(ARCHIVES, "sse-probe.txt"), { force: true });
});
