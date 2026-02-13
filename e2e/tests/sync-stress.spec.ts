/**
 * Sync stress tests — API-driven operations at scale.
 *
 * Tests large file sync, burst batch select/deselect, rapid toggle,
 * concurrent mixed operations, and folder recursion via the HTTP API.
 * All tests use the server started by setup-and-run.sh with test data
 * in /tmp/e2e-sync-test/ (20 small, 5 medium, 1 large, 1 giant, 1 dir).
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";

// ────────────────────────────────────────────
// API helpers — safe JSON parse, explicit login
// ────────────────────────────────────────────

/** Login via API (--noauth accepts any creds) and return JWT. */
async function apiLogin(page: Page): Promise<string> {
  // First try to get existing JWT from auto-login
  let jwt = await page.evaluate(() => localStorage.getItem("jwt") ?? "");
  if (jwt) return jwt;

  // Fallback: explicit API login
  jwt = await page.evaluate(async () => {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "", password: "", recaptcha: "" }),
    });
    if (!resp.ok) throw new Error(`login failed: ${resp.status}`);
    return resp.text();
  });
  return jwt;
}

/** Fetch entries — safe JSON parse, returns {items:[]} on error. */
async function fetchEntries(page: Page, jwt: string, opts: { parentPath?: string; parentIno?: number } = {}) {
  return page.evaluate(
    async ({ jwt, opts }) => {
      let url = "/api/sync/entries";
      if (opts.parentIno != null) {
        url += `?parent_ino=${opts.parentIno}`;
      } else if (opts.parentPath && opts.parentPath !== "/") {
        url += `?path=${encodeURIComponent(opts.parentPath)}`;
      }
      const resp = await fetch(url, { headers: { "X-Auth": jwt } });
      const text = await resp.text();
      try {
        return JSON.parse(text) as { items: any[] };
      } catch {
        return { items: [] as any[], _error: text, _status: resp.status };
      }
    },
    { jwt, opts }
  );
}

/** Call select API. */
async function apiSelect(page: Page, jwt: string, inodes: number[]) {
  return page.evaluate(
    async ({ jwt, inodes }) => {
      const resp = await fetch("/api/sync/select", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth": jwt },
        body: JSON.stringify({ inodes }),
      });
      return resp.status;
    },
    { jwt, inodes }
  );
}

/** Call deselect API. */
async function apiDeselect(page: Page, jwt: string, inodes: number[]) {
  return page.evaluate(
    async ({ jwt, inodes }) => {
      const resp = await fetch("/api/sync/deselect", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth": jwt },
        body: JSON.stringify({ inodes }),
      });
      return resp.status;
    },
    { jwt, inodes }
  );
}

/** Poll entries until predicate is satisfied. */
async function pollUntil(
  page: Page,
  jwt: string,
  predicate: (items: any[]) => boolean,
  timeout = 30_000
) {
  const start = Date.now();
  let lastItems: any[] = [];
  while (Date.now() - start < timeout) {
    const data = await fetchEntries(page, jwt);
    lastItems = data.items ?? [];
    if (predicate(lastItems)) return lastItems;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `pollUntil timed out (${lastItems.length} items, sample: ${JSON.stringify(lastItems.slice(0, 3))})`
  );
}

/** Wait for a specific file to reach expected status. */
async function waitFileStatus(
  page: Page,
  jwt: string,
  fileName: string,
  expectedStatus: string,
  timeout = 30_000
) {
  return pollUntil(
    page,
    jwt,
    (items) =>
      items.some(
        (i: any) => i.name === fileName && i.status === expectedStatus
      ),
    timeout
  );
}

/** Navigate, login, wait for entries. */
async function loginAndWait(page: Page, minEntries = 25) {
  await page.goto("/");
  // Give frontend time to auto-login and redirect
  await page.waitForTimeout(3000);
  const jwt = await apiLogin(page);
  // Wait for daemon seed to register all entries
  await pollUntil(
    page,
    jwt,
    (items) => items.length >= minEntries,
    30_000
  );
  return jwt;
}

// ────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────

test.describe("Infrastructure", () => {
  test("server boots, entries registered by seed", async ({ page }) => {
    const jwt = await loginAndWait(page, 25);
    const data = await fetchEntries(page, jwt);
    // 20 small + 5 medium + 1 large + 1 test-dir = 27
    expect(data.items.length).toBeGreaterThanOrEqual(27);

    // All should start as "archived" (sel=0, S_disk=0)
    for (const item of data.items) {
      expect(item.status).toBe("archived");
    }
  });
});

test.describe.serial("Large File Operations", () => {
  test("50MB select → synced", async ({ page }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const large = data.items.find((e: any) => e.name === "large-file.dat");
    expect(large).toBeTruthy();

    expect(await apiSelect(page, jwt, [large.inode])).toBe(200);

    await waitFileStatus(page, jwt, "large-file.dat", "synced", 60_000);

    const spacesPath = path.join(TEST_DIR, "Spaces", "large-file.dat");
    expect(fs.existsSync(spacesPath)).toBe(true);
    expect(fs.statSync(spacesPath).size).toBe(50 * 1024 * 1024);
  });

  test("50MB deselect → archived, file removed", async ({ page }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const large = data.items.find((e: any) => e.name === "large-file.dat");

    expect(await apiDeselect(page, jwt, [large.inode])).toBe(200);

    await waitFileStatus(page, jwt, "large-file.dat", "archived", 60_000);
    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "large-file.dat"))
    ).toBe(false);
  });

  test("50MB select + immediate deselect → final state archived", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const large = data.items.find((e: any) => e.name === "large-file.dat");

    // Fire both back-to-back — queue deduplicates, worker sees final DB state
    await apiSelect(page, jwt, [large.inode]);
    await apiDeselect(page, jwt, [large.inode]);

    // Give daemon time to drain queue
    await page.waitForTimeout(3000);

    await waitFileStatus(page, jwt, "large-file.dat", "archived", 60_000);
    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "large-file.dat"))
    ).toBe(false);
  });
});

test.describe.serial("Rapid Multi-Request: Burst Select", () => {
  test("batch select 20 files → all synced", async ({ page }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const smallInodes = data.items
      .filter((e: any) => e.name.startsWith("small-"))
      .map((e: any) => e.inode);
    expect(smallInodes.length).toBe(20);

    // Single batch select with all 20 inodes
    expect(await apiSelect(page, jwt, smallInodes)).toBe(200);

    // Wait for all 20 to reach "synced"
    await pollUntil(
      page,
      jwt,
      (items) => {
        const smalls = items.filter((i: any) => i.name.startsWith("small-"));
        return (
          smalls.length === 20 &&
          smalls.every((i: any) => i.status === "synced")
        );
      },
      60_000
    );

    for (let i = 1; i <= 20; i++) {
      expect(
        fs.existsSync(path.join(TEST_DIR, "Spaces", `small-${i}.txt`))
      ).toBe(true);
    }
  });

  test("batch deselect 20 files → all archived", async ({ page }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const smallInodes = data.items
      .filter((e: any) => e.name.startsWith("small-"))
      .map((e: any) => e.inode);

    // Single batch deselect
    expect(await apiDeselect(page, jwt, smallInodes)).toBe(200);

    await pollUntil(
      page,
      jwt,
      (items) => {
        const smalls = items.filter((i: any) => i.name.startsWith("small-"));
        return (
          smalls.length === 20 &&
          smalls.every((i: any) => i.status === "archived")
        );
      },
      60_000
    );

    for (let i = 1; i <= 20; i++) {
      expect(
        fs.existsSync(path.join(TEST_DIR, "Spaces", `small-${i}.txt`))
      ).toBe(false);
    }
  });

  test("20 concurrent single-file select calls (SQLite contention)", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const smallInodes = data.items
      .filter((e: any) => e.name.startsWith("small-"))
      .map((e: any) => e.inode);

    // Fire 20 concurrent calls — some may 500 due to SQLite locking
    const results = await page.evaluate(
      async ({ jwt, inodes }) => {
        const promises = inodes.map((ino: number) =>
          fetch("/api/sync/select", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Auth": jwt },
            body: JSON.stringify({ inodes: [ino] }),
          }).then((r) => r.status)
        );
        return Promise.all(promises);
      },
      { jwt, inodes: smallInodes }
    );

    const okCount = results.filter((s: number) => s === 200).length;
    const failedInodes = smallInodes.filter(
      (_: any, i: number) => results[i] !== 200
    );

    // Retry failed ones sequentially
    for (const ino of failedInodes) {
      expect(await apiSelect(page, jwt, [ino])).toBe(200);
    }

    // Eventually all should sync
    await pollUntil(
      page,
      jwt,
      (items) => {
        const smalls = items.filter((i: any) => i.name.startsWith("small-"));
        return (
          smalls.length === 20 &&
          smalls.every((i: any) => i.status === "synced")
        );
      },
      60_000
    );

    // Report contention rate for visibility
    console.log(
      `SQLite contention: ${okCount}/20 succeeded on first try`
    );
  });
});

test.describe.serial("Rapid Toggle Stress", () => {
  test("toggle same file 20 times → final state archived (even = deselect wins)", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const medium = data.items.find((e: any) => e.name === "medium-1.dat");
    expect(medium).toBeTruthy();

    // 20 toggles with retry on 500 (SQLite contention with daemon worker)
    const results = await page.evaluate(
      async ({ jwt, inode }) => {
        const statuses: number[] = [];
        for (let i = 0; i < 20; i++) {
          const endpoint =
            i % 2 === 0 ? "/api/sync/select" : "/api/sync/deselect";
          let status = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
            const resp = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Auth": jwt },
              body: JSON.stringify({ inodes: [inode] }),
            });
            status = resp.status;
            if (status === 200) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          statuses.push(status);
        }
        return statuses;
      },
      { jwt, inode: medium.inode }
    );

    expect(results).toEqual(Array(20).fill(200));

    await page.waitForTimeout(3000);
    await waitFileStatus(page, jwt, "medium-1.dat", "archived", 30_000);
    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "medium-1.dat"))
    ).toBe(false);
  });

  test("toggle same file 21 times → final state synced (odd = select wins)", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const medium = data.items.find((e: any) => e.name === "medium-2.dat");
    expect(medium).toBeTruthy();

    const results = await page.evaluate(
      async ({ jwt, inode }) => {
        const statuses: number[] = [];
        for (let i = 0; i < 21; i++) {
          const endpoint =
            i % 2 === 0 ? "/api/sync/select" : "/api/sync/deselect";
          let status = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
            const resp = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Auth": jwt },
              body: JSON.stringify({ inodes: [inode] }),
            });
            status = resp.status;
            if (status === 200) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          statuses.push(status);
        }
        return statuses;
      },
      { jwt, inode: medium.inode }
    );

    expect(results).toEqual(Array(21).fill(200));

    await page.waitForTimeout(3000);
    await waitFileStatus(page, jwt, "medium-2.dat", "synced", 30_000);
    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "medium-2.dat"))
    ).toBe(true);
  });
});

test.describe.serial("Concurrent Mixed Operations", () => {
  test("concurrent select + deselect on different files", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const medium3 = data.items.find((e: any) => e.name === "medium-3.dat");
    const medium4 = data.items.find((e: any) => e.name === "medium-4.dat");
    expect(medium3).toBeTruthy();
    expect(medium4).toBeTruthy();

    // Pre-select medium-4 so we can deselect it
    expect(await apiSelect(page, jwt, [medium4.inode])).toBe(200);
    await waitFileStatus(page, jwt, "medium-4.dat", "synced", 30_000);

    // Concurrently: select medium-3, deselect medium-4
    // One may fail due to SQLite lock — retry the failed one
    const results = await page.evaluate(
      async ({ jwt, selectIno, deselectIno }) => {
        const [selResp, deselResp] = await Promise.all([
          fetch("/api/sync/select", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Auth": jwt },
            body: JSON.stringify({ inodes: [selectIno] }),
          }),
          fetch("/api/sync/deselect", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Auth": jwt },
            body: JSON.stringify({ inodes: [deselectIno] }),
          }),
        ]);
        return { select: selResp.status, deselect: deselResp.status };
      },
      { jwt, selectIno: medium3.inode, deselectIno: medium4.inode }
    );

    // Retry any that failed due to SQLite contention
    if (results.select !== 200) {
      expect(await apiSelect(page, jwt, [medium3.inode])).toBe(200);
    }
    if (results.deselect !== 200) {
      expect(await apiDeselect(page, jwt, [medium4.inode])).toBe(200);
    }

    await waitFileStatus(page, jwt, "medium-3.dat", "synced", 30_000);
    await waitFileStatus(page, jwt, "medium-4.dat", "archived", 30_000);

    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "medium-3.dat"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "medium-4.dat"))
    ).toBe(false);
  });

  test("10 concurrent select calls for same file → idempotent", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const medium5 = data.items.find((e: any) => e.name === "medium-5.dat");
    expect(medium5).toBeTruthy();

    // Fire 10 concurrent calls — some may 500 due to SQLite contention
    const results = await page.evaluate(
      async ({ jwt, inode }) => {
        const promises = Array(10)
          .fill(null)
          .map(() =>
            fetch("/api/sync/select", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Auth": jwt,
              },
              body: JSON.stringify({ inodes: [inode] }),
            }).then((r) => r.status)
          );
        return Promise.all(promises);
      },
      { jwt, inode: medium5.inode }
    );

    // At least one must succeed; retry if needed
    const okCount = results.filter((s: number) => s === 200).length;
    expect(okCount).toBeGreaterThan(0);
    if (okCount < 10) {
      // Ensure select is applied
      expect(await apiSelect(page, jwt, [medium5.inode])).toBe(200);
    }

    await waitFileStatus(page, jwt, "medium-5.dat", "synced", 30_000);
    expect(
      fs.existsSync(path.join(TEST_DIR, "Spaces", "medium-5.dat"))
    ).toBe(true);
    expect(
      fs.statSync(path.join(TEST_DIR, "Spaces", "medium-5.dat")).size
    ).toBe(1024 * 1024);
  });
});

test.describe("Folder Operations", () => {
  test("select folder → all children synced", async ({ page }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const testDir = data.items.find((e: any) => e.name === "test-dir");
    expect(testDir).toBeTruthy();
    expect(testDir.type).toBe("dir");

    expect(await apiSelect(page, jwt, [testDir.inode])).toBe(200);

    // Wait for folder and children
    await waitFileStatus(page, jwt, "test-dir", "synced", 30_000);
    await page.waitForTimeout(5000);

    // Check children
    const children = await fetchEntries(page, jwt, {
      parentIno: testDir.inode,
    });
    expect(children.items.length).toBe(10);
    for (const child of children.items) {
      expect(child.status).toBe("synced");
    }

    for (let i = 1; i <= 10; i++) {
      expect(
        fs.existsSync(
          path.join(TEST_DIR, "Spaces", "test-dir", `child-${i}.txt`)
        )
      ).toBe(true);
    }
  });
});
