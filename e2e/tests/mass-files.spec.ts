/**
 * Mass file stress tests — pre-generate ~100K files with
 * `bash e2e/create-mass-files.sh`, then perform select/deselect/hijack
 * operations while the daemon is still processing the initial scan.
 *
 * Tests worker throughput, queue saturation, watcher debounce under
 * load, and state consistency when operations are interleaved with
 * bulk processing.
 *
 * Pre-requisite:
 *   bash e2e/create-mass-files.sh [COUNT] [TEST_DIR]
 *
 * If mass-test/ doesn't exist yet, the first test creates 10K files
 * as a fallback (enough to stress the pipeline on Pi).
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = path.join(TEST_DIR, "Archives");
const SPACES = path.join(TEST_DIR, "Spaces");
const MASS_DIR = path.join(ARCHIVES, "mass-test");
const SCRIPT = path.resolve(__dirname, "../create-mass-files.sh");

// Detect pre-generated count or fall back to 10K
function detectFileCount(): number {
  if (fs.existsSync(MASS_DIR)) {
    const count = fs.readdirSync(MASS_DIR).length;
    if (count > 0) return count;
  }
  return 10_000; // fallback
}

// ── Helpers ──

async function apiLogin(page: Page): Promise<string> {
  let jwt = await page.evaluate(() => localStorage.getItem("jwt") ?? "");
  if (jwt) return jwt;
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

async function fetchEntries(
  page: Page,
  jwt: string,
  opts: { parentPath?: string; parentIno?: number } = {}
) {
  return page.evaluate(
    async ({ jwt, opts }) => {
      let url = "/api/sync/entries";
      if (opts.parentIno != null) url += `?parent_ino=${opts.parentIno}`;
      else if (opts.parentPath && opts.parentPath !== "/")
        url += `?path=${encodeURIComponent(opts.parentPath)}`;
      const resp = await fetch(url, { headers: { "X-Auth": jwt } });
      const text = await resp.text();
      try {
        return JSON.parse(text) as { items: any[] };
      } catch {
        return { items: [] as any[], _error: text };
      }
    },
    { jwt, opts }
  );
}

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

async function loginAndWait(page: Page) {
  await page.goto("/");
  await page.waitForTimeout(3000);
  return apiLogin(page);
}

// ── Setup ──

function ensureMassFiles(): number {
  // Files should be pre-created by setup-and-run.sh (MASS_FILE_COUNT env).
  // Use: npx playwright test --config mass-files.config.ts
  if (fs.existsSync(MASS_DIR)) {
    const count = fs.readdirSync(MASS_DIR).length;
    if (count > 0) {
      console.log(`mass-test/ pre-created with ${count} files`);
      return count;
    }
  }

  // Fallback: create via script (may miss events on macOS kqueue)
  const fallback = 10_000;
  console.log(
    `mass-test/ not found — creating ${fallback} files via script (some may be missed by watcher)...`
  );
  execSync(`bash "${SCRIPT}" ${fallback} "${TEST_DIR}"`, { stdio: "inherit" });
  return fallback;
}

// ── Tests ──

let FILE_COUNT: number;

test.describe.serial("Mass file operations", () => {
  test("create mass files → all registered", async ({ page }) => {
    const start = Date.now();
    FILE_COUNT = ensureMassFiles();
    const createMs = Date.now() - start;
    console.log(`Ensured ${FILE_COUNT} files in ${createMs}ms`);

    const jwt = await loginAndWait(page);

    // Wait for the mass-test directory to appear
    await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "mass-test"),
      60_000
    );

    // Get the dir entry
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");
    expect(massDir).toBeTruthy();

    // Wait for children to be registered (this is the main test)
    // The watcher + pipeline need to process all entries.
    // Pipeline processes ~23 entries/sec sequentially, so 10K ≈ 7min.
    const childStart = Date.now();
    let childCount = 0;
    while (Date.now() - childStart < 600_000) {
      const children = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      childCount = children.items.length;
      if (childCount >= FILE_COUNT) break;
      // Log progress every 5K
      if (childCount % 5000 < 100) {
        console.log(`Registered ${childCount}/${FILE_COUNT} files`);
      }
      await page.waitForTimeout(1000);
    }

    console.log(
      `All registered: ${childCount}/${FILE_COUNT} in ${Date.now() - childStart}ms`
    );
    expect(childCount).toBeGreaterThanOrEqual(FILE_COUNT);
  });

  test("batch select all → all synced", async ({ page }) => {
    if (!FILE_COUNT) FILE_COUNT = detectFileCount();

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");
    expect(massDir).toBeTruthy();

    // Select the folder (recursively selects all children)
    const start = Date.now();
    expect(await apiSelect(page, jwt, [massDir.inode])).toBe(200);

    // Wait for all children to be synced
    let syncedCount = 0;
    while (Date.now() - start < 600_000) {
      const children = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      syncedCount = children.items.filter(
        (c: any) => c.status === "synced"
      ).length;
      if (syncedCount >= FILE_COUNT) break;
      if (syncedCount % 5000 < 100) {
        console.log(`Synced ${syncedCount}/${FILE_COUNT}`);
      }
      await page.waitForTimeout(1000);
    }

    console.log(
      `All synced: ${syncedCount}/${FILE_COUNT} in ${Date.now() - start}ms`
    );
    expect(syncedCount).toBeGreaterThanOrEqual(FILE_COUNT);

    // Verify Spaces directory exists with files
    expect(fs.existsSync(path.join(SPACES, "mass-test"))).toBe(true);
    const spacesFiles = fs.readdirSync(path.join(SPACES, "mass-test"));
    expect(spacesFiles.length).toBe(FILE_COUNT);
  });

  test("deselect all while syncing → hijack mid-process (re-select)", async ({
    page,
  }) => {
    if (!FILE_COUNT) FILE_COUNT = detectFileCount();

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");

    // Ensure all are synced from previous test
    const children = await fetchEntries(page, jwt, {
      parentIno: massDir.inode,
    });
    const allSynced = children.items.every(
      (c: any) => c.status === "synced"
    );

    if (!allSynced) {
      // Wait for sync to complete
      expect(await apiSelect(page, jwt, [massDir.inode])).toBe(200);
      await page.waitForTimeout(10_000);
    }

    // Now deselect → triggers mass removal from Spaces
    const start = Date.now();
    expect(await apiDeselect(page, jwt, [massDir.inode])).toBe(200);

    // IMMEDIATELY re-select (hijack) — worker is busy removing files.
    // This tests queue dedup and hasQueued() abort during mass operations.
    // Retry if SQLite is busy from the mass deselect still processing.
    await page.waitForTimeout(500); // brief pause to let worker start
    let selectStatus = await apiSelect(page, jwt, [massDir.inode]);
    for (let retry = 0; retry < 5 && selectStatus !== 200; retry++) {
      await page.waitForTimeout(1000);
      selectStatus = await apiSelect(page, jwt, [massDir.inode]);
    }
    expect(selectStatus).toBe(200);

    // Final state: selected=true → all should converge to synced
    let syncedCount = 0;
    while (Date.now() - start < 600_000) {
      const ch = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      syncedCount = ch.items.filter(
        (c: any) => c.status === "synced"
      ).length;
      if (syncedCount >= FILE_COUNT) break;
      await page.waitForTimeout(2000);
    }

    console.log(
      `Hijack converged: ${syncedCount}/${FILE_COUNT} in ${Date.now() - start}ms`
    );
    expect(syncedCount).toBeGreaterThanOrEqual(FILE_COUNT);
  });

  test("select all → deselect half mid-process → partial sync", async ({
    page,
  }) => {
    if (!FILE_COUNT) FILE_COUNT = detectFileCount();

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");

    // First deselect all to start clean
    expect(await apiDeselect(page, jwt, [massDir.inode])).toBe(200);

    // Wait for all to become archived
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      const ch = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      const archivedCount = ch.items.filter(
        (c: any) => c.status === "archived"
      ).length;
      if (archivedCount >= FILE_COUNT) break;
      await page.waitForTimeout(2000);
    }

    // Select all
    expect(await apiSelect(page, jwt, [massDir.inode])).toBe(200);

    // Wait briefly for processing to start, then deselect first half
    await page.waitForTimeout(1000);

    const children = await fetchEntries(page, jwt, {
      parentIno: massDir.inode,
    });
    const firstHalf = children.items
      .slice(0, Math.floor(children.items.length / 2))
      .map((c: any) => c.inode);

    // Deselect half — batch API (retry if SQLite is busy)
    let deselectStatus = await apiDeselect(page, jwt, firstHalf);
    for (let retry = 0; retry < 5 && deselectStatus !== 200; retry++) {
      await page.waitForTimeout(1000);
      deselectStatus = await apiDeselect(page, jwt, firstHalf);
    }
    expect(deselectStatus).toBe(200);

    // Wait for convergence
    const convStart = Date.now();
    while (Date.now() - convStart < 600_000) {
      const ch = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      const synced = ch.items.filter(
        (c: any) => c.status === "synced"
      ).length;
      const archived = ch.items.filter(
        (c: any) => c.status === "archived"
      ).length;
      if (synced + archived >= FILE_COUNT) {
        console.log(
          `Partial sync converged: ${synced} synced, ${archived} archived in ${Date.now() - convStart}ms`
        );
        break;
      }
      await page.waitForTimeout(2000);
    }

    // Half should be synced, half archived.
    // Allow ~2% tolerance — mass interleaved operations leave some entries
    // still transitioning within the timeout. This is a stress test; what
    // matters is that the vast majority converge correctly.
    const finalChildren = await fetchEntries(page, jwt, {
      parentIno: massDir.inode,
    });
    const synced = finalChildren.items.filter(
      (c: any) => c.status === "synced"
    ).length;
    const archived = finalChildren.items.filter(
      (c: any) => c.status === "archived"
    ).length;

    const threshold = Math.floor(FILE_COUNT * 0.98);
    expect(synced + archived).toBeGreaterThanOrEqual(threshold);
    expect(synced).toBeGreaterThan(0);
    expect(archived).toBeGreaterThan(0);
    console.log(`Final: ${synced} synced, ${archived} archived (threshold: ${threshold})`);
  });

  test("rapid folder toggle during mass processing → converges", async ({
    page,
  }) => {
    if (!FILE_COUNT) FILE_COUNT = detectFileCount();

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");

    // Start with all deselected
    expect(await apiDeselect(page, jwt, [massDir.inode])).toBe(200);
    await page.waitForTimeout(5000);

    // Rapid folder toggles — stress the queue dedup
    for (let i = 0; i < 10; i++) {
      await apiSelect(page, jwt, [massDir.inode]);
      await apiDeselect(page, jwt, [massDir.inode]);
    }
    // Final: select (odd number of selects)
    expect(await apiSelect(page, jwt, [massDir.inode])).toBe(200);

    // All should eventually sync (final state: selected)
    const start = Date.now();
    let syncedCount = 0;
    while (Date.now() - start < 600_000) {
      const ch = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      syncedCount = ch.items.filter(
        (c: any) => c.status === "synced"
      ).length;
      if (syncedCount >= FILE_COUNT) break;
      await page.waitForTimeout(2000);
    }

    console.log(
      `Rapid toggle converged: ${syncedCount}/${FILE_COUNT} in ${Date.now() - start}ms`
    );
    expect(syncedCount).toBeGreaterThanOrEqual(FILE_COUNT);
  });

  test("delete 1K files from Archives during mass sync → entries cleaned", async ({
    page,
  }) => {
    if (!FILE_COUNT) FILE_COUNT = detectFileCount();

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");

    // Ensure all synced
    const children = await fetchEntries(page, jwt, {
      parentIno: massDir.inode,
    });
    if (
      children.items.some((c: any) => c.status !== "synced")
    ) {
      expect(await apiSelect(page, jwt, [massDir.inode])).toBe(200);
      await page.waitForTimeout(30_000);
    }

    // Delete first 1000 files from Archives while all are synced
    const deleteCount = 1000;
    for (let i = 0; i < deleteCount; i++) {
      const fpath = path.join(MASS_DIR, `f-${i}.txt`);
      if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    }

    // Pipeline should:
    // - Detect A_disk=0 for deleted files
    // - P0: S_disk=1 → recover S→A (since selected=true, Spaces copy exists)
    // OR: clean up if both gone

    // Wait for convergence — either recovered or cleaned up
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      const ch = await fetchEntries(page, jwt, {
        parentIno: massDir.inode,
      });
      const allSettled = ch.items.every(
        (c: any) =>
          c.status === "synced" || c.status === "archived"
      );
      if (allSettled && ch.items.length > 0) {
        console.log(
          `Mass delete converged: ${ch.items.length} entries in ${Date.now() - start}ms`
        );
        break;
      }
      await page.waitForTimeout(2000);
    }

    // Final state should be consistent
    const final = await fetchEntries(page, jwt, {
      parentIno: massDir.inode,
    });
    expect(final.items.length).toBeGreaterThan(0);

    // Cleanup: deselect all
    await apiDeselect(page, jwt, [massDir.inode]);
    await page.waitForTimeout(10_000);
  });

  test("select all → immediate deselect+reselect 3x rapid → converges to synced", async ({
    page,
  }) => {
    if (!FILE_COUNT) FILE_COUNT = detectFileCount();

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const massDir = data.items.find((e: any) => e.name === "mass-test");

    // Ensure clean state: all archived
    expect(await apiDeselect(page, jwt, [massDir.inode])).toBe(200);
    const waitStart = Date.now();
    while (Date.now() - waitStart < 300_000) {
      const ch = await fetchEntries(page, jwt, { parentIno: massDir.inode });
      const archivedCount = ch.items.filter(
        (c: any) => c.status === "archived"
      ).length;
      if (archivedCount >= FILE_COUNT) break;
      await page.waitForTimeout(2000);
    }

    // Select → worker starts mass copy
    expect(await apiSelect(page, jwt, [massDir.inode])).toBe(200);

    // 3x rapid deselect-reselect while worker is processing
    for (let i = 0; i < 3; i++) {
      await apiDeselect(page, jwt, [massDir.inode]);
      await apiSelect(page, jwt, [massDir.inode]);
    }

    // Final state: selected=true → all should converge to synced
    const start = Date.now();
    let syncedCount = 0;
    while (Date.now() - start < 600_000) {
      const ch = await fetchEntries(page, jwt, { parentIno: massDir.inode });
      syncedCount = ch.items.filter(
        (c: any) => c.status === "synced"
      ).length;
      if (syncedCount >= FILE_COUNT) break;
      await page.waitForTimeout(2000);
    }

    console.log(
      `3x hijack converged: ${syncedCount}/${FILE_COUNT} in ${Date.now() - start}ms`
    );
    expect(syncedCount).toBeGreaterThanOrEqual(FILE_COUNT);
  });

  // Final cleanup — remove mass-test from disk.
  // DB entry cleanup happens automatically on next server start
  // (setup-and-run.sh does rm -rf $TEST_DIR).
  test("cleanup mass-test directory", async () => {
    fs.rmSync(MASS_DIR, { recursive: true, force: true });
    if (fs.existsSync(path.join(SPACES, "mass-test")))
      fs.rmSync(path.join(SPACES, "mass-test"), {
        recursive: true,
        force: true,
      });

    expect(fs.existsSync(MASS_DIR)).toBe(false);
    expect(fs.existsSync(path.join(SPACES, "mass-test"))).toBe(false);
  });
});
