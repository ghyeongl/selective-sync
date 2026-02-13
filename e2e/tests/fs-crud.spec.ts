/**
 * Filesystem CRUD tests — directly manipulate Archives/ and Spaces/
 * directories, then verify the daemon (watcher + pipeline) converges
 * to the correct state.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = path.join(TEST_DIR, "Archives");
const SPACES = path.join(TEST_DIR, "Spaces");

// Watcher debounce is 300ms — wait longer for propagation
const WATCHER_SETTLE = 2000;

// ── Helpers (copied from sync-stress for independence) ──

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

// ── Tests ──

test.describe.serial("Archives CRUD → watcher detection", () => {
  test("create new file in Archives → entry registered as archived", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Write a new file directly to Archives
    fs.writeFileSync(path.join(ARCHIVES, "fs-new.txt"), "hello from fs");

    // Wait for watcher to detect and pipeline to register
    await page.waitForTimeout(WATCHER_SETTLE);

    const items = await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "fs-new.txt"),
      15_000
    );
    const entry = items.find((i: any) => i.name === "fs-new.txt");
    expect(entry).toBeTruthy();
    expect(entry.status).toBe("archived");
  });

  test("modify file in Archives → entry updated", async ({ page }) => {
    const jwt = await loginAndWait(page);

    // Get current state
    let items = await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "fs-new.txt"),
      10_000
    );
    const before = items.find((i: any) => i.name === "fs-new.txt");
    const mtimeBefore = before.mtime;

    // Wait a bit to ensure mtime changes
    await page.waitForTimeout(1100);

    // Modify the file
    fs.writeFileSync(
      path.join(ARCHIVES, "fs-new.txt"),
      "updated content from fs"
    );
    await page.waitForTimeout(WATCHER_SETTLE);

    // Mtime should be updated
    items = await pollUntil(
      page,
      jwt,
      (items) => {
        const e = items.find((i: any) => i.name === "fs-new.txt");
        return e != null && e.mtime > mtimeBefore;
      },
      15_000
    );
    const after = items.find((i: any) => i.name === "fs-new.txt");
    expect(after.mtime).toBeGreaterThan(mtimeBefore);
    expect(after.status).toBe("archived");
  });

  test("delete file from Archives → entry removed", async ({ page }) => {
    const jwt = await loginAndWait(page);

    // Verify it exists first
    await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "fs-new.txt"),
      10_000
    );

    // Delete from Archives
    fs.unlinkSync(path.join(ARCHIVES, "fs-new.txt"));
    await page.waitForTimeout(WATCHER_SETTLE);

    // Entry should eventually be cleaned up (p0/p4 removes stale entries)
    await pollUntil(
      page,
      jwt,
      (items) => !items.some((i: any) => i.name === "fs-new.txt"),
      30_000
    );
  });

  test("create new directory with files in Archives → all registered", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Create dir and files with small delays to ensure separate watcher events
    const dirPath = path.join(ARCHIVES, "fs-dir");
    fs.mkdirSync(dirPath, { recursive: true });
    await page.waitForTimeout(500);
    fs.writeFileSync(path.join(dirPath, "a.txt"), "aaa");
    await page.waitForTimeout(200);
    fs.writeFileSync(path.join(dirPath, "b.txt"), "bbb");

    await page.waitForTimeout(WATCHER_SETTLE);

    // Parent dir should appear
    const items = await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "fs-dir"),
      15_000
    );
    const dir = items.find((i: any) => i.name === "fs-dir");
    expect(dir).toBeTruthy();
    expect(dir.type).toBe("dir");

    // Poll until both children are registered
    // Watcher needs to detect files inside the new dir + pipeline processes them
    let childData: { items: any[] } = { items: [] };
    const childStart = Date.now();
    while (Date.now() - childStart < 30_000) {
      childData = await fetchEntries(page, jwt, {
        parentIno: dir.inode,
      });
      if (childData.items.length >= 2) break;
      await page.waitForTimeout(1000);
    }
    expect(childData.items.length).toBe(2);
    const names = childData.items.map((c: any) => c.name).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });
});

test.describe.serial("Spaces direct manipulation", () => {
  test("create file in Spaces directly → pipeline recovers to Archives, keeps selected", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Directly create a file in Spaces (simulates Spoke-created file)
    const content = "created by spoke";
    fs.writeFileSync(path.join(SPACES, "spoke-new.txt"), content);
    await page.waitForTimeout(WATCHER_SETTLE);

    // Pipeline flow:
    //   P0: S_disk=1, A_disk=0 → SafeCopy S→A (recover to Archives)
    //   P1: A_db=0, A_disk=1 → register entry with selected=S_disk=true
    //   P3: selected=1, S_disk=1 → match, skip (keeps Spaces file)
    //   P4: S_db != S_disk → insert spaces_view
    // Result: file exists in BOTH Archives and Spaces, selected=true

    // Wait for entry to appear as "synced" (sel=1, S_disk=1)
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "spoke-new.txt" && i.status === "synced"
        ),
      30_000
    );

    // Both copies should exist
    expect(fs.existsSync(path.join(SPACES, "spoke-new.txt"))).toBe(true);
    expect(fs.existsSync(path.join(ARCHIVES, "spoke-new.txt"))).toBe(true);
    expect(
      fs.readFileSync(path.join(ARCHIVES, "spoke-new.txt"), "utf-8")
    ).toBe(content);

    // Cleanup: deselect to remove from Spaces, then delete from Archives
    const data = await fetchEntries(page, jwt);
    const entry = data.items.find((e: any) => e.name === "spoke-new.txt");
    if (entry) {
      await apiDeselect(page, jwt, [entry.inode]);
      await page.waitForTimeout(3000);
    }
    if (fs.existsSync(path.join(ARCHIVES, "spoke-new.txt")))
      fs.unlinkSync(path.join(ARCHIVES, "spoke-new.txt"));
  });

  test("delete synced file from Spaces directly → pipeline re-syncs", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // First: select small-1.txt to sync it
    const data = await fetchEntries(page, jwt);
    const small1 = data.items.find((e: any) => e.name === "small-1.txt");
    expect(small1).toBeTruthy();

    expect(await apiSelect(page, jwt, [small1.inode])).toBe(200);

    // Wait for sync
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "small-1.txt" && i.status === "synced"
        ),
      30_000
    );
    expect(fs.existsSync(path.join(SPACES, "small-1.txt"))).toBe(true);

    // Now directly delete the Spaces copy
    fs.unlinkSync(path.join(SPACES, "small-1.txt"));
    await page.waitForTimeout(WATCHER_SETTLE);

    // Pipeline should detect mismatch (selected=true, S_disk=false)
    // and re-copy from Archives → Spaces
    await page.waitForTimeout(5000);
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "small-1.txt" && i.status === "synced"
        ),
      30_000
    );
    expect(fs.existsSync(path.join(SPACES, "small-1.txt"))).toBe(true);

    // Cleanup: deselect
    await apiDeselect(page, jwt, [small1.inode]);
    await page.waitForTimeout(3000);
  });

  test("modify synced file in Spaces directly → conflict or re-sync", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Select small-2 to sync
    const data = await fetchEntries(page, jwt);
    const small2 = data.items.find((e: any) => e.name === "small-2.txt");
    expect(await apiSelect(page, jwt, [small2.inode])).toBe(200);
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "small-2.txt" && i.status === "synced"
        ),
      30_000
    );

    // Modify the Spaces copy directly (simulates user edit)
    await page.waitForTimeout(1100);
    fs.writeFileSync(path.join(SPACES, "small-2.txt"), "user edited this");
    await page.waitForTimeout(WATCHER_SETTLE);

    // Pipeline should detect mismatch and handle (conflict or update)
    await page.waitForTimeout(5000);

    // The entry should still exist and be in some valid state
    const items = await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) =>
            i.name === "small-2.txt" &&
            ["synced", "conflict", "updating"].includes(i.status)
        ),
      30_000
    );
    const entry = items.find((i: any) => i.name === "small-2.txt");
    expect(entry).toBeTruthy();

    // Cleanup
    await apiDeselect(page, jwt, [small2.inode]);
    await page.waitForTimeout(3000);
  });
});

test.describe.serial("Archives modification of synced files", () => {
  test("modify Archives file while synced → Spaces updated", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Select small-3 to sync
    const data = await fetchEntries(page, jwt);
    const small3 = data.items.find((e: any) => e.name === "small-3.txt");
    expect(await apiSelect(page, jwt, [small3.inode])).toBe(200);
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "small-3.txt" && i.status === "synced"
        ),
      30_000
    );

    // Modify the Archives original (simulates external update)
    await page.waitForTimeout(1100);
    const newContent = "archives updated at " + Date.now();
    fs.writeFileSync(path.join(ARCHIVES, "small-3.txt"), newContent);
    await page.waitForTimeout(WATCHER_SETTLE);

    // Pipeline should detect mtime mismatch and re-sync to Spaces
    await page.waitForTimeout(5000);

    // Spaces copy should eventually have the new content
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "small-3.txt" && i.status === "synced"
        ),
      30_000
    );

    const spacesContent = fs.readFileSync(
      path.join(SPACES, "small-3.txt"),
      "utf-8"
    );
    expect(spacesContent).toBe(newContent);

    // Cleanup
    await apiDeselect(page, jwt, [small3.inode]);
    await page.waitForTimeout(3000);
  });

  test("rename file in Archives → old entry removed, new entry added", async ({
    page,
  }) => {
    // macOS kqueue: Rename fires 1 event (old path only), no cookie matching.
    // Linux inotify: MOVED_FROM + MOVED_TO with cookie.
    // This test requires Linux inotify to detect both old + new paths.
    test.skip(
      process.platform === "darwin",
      "rename detection requires Linux inotify (MOVED_FROM/MOVED_TO + cookie)"
    );
    const jwt = await loginAndWait(page);

    // Create a file we'll rename
    fs.writeFileSync(path.join(ARCHIVES, "before-rename.txt"), "rename me");
    await page.waitForTimeout(WATCHER_SETTLE);

    await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "before-rename.txt"),
      15_000
    );

    // Rename it
    fs.renameSync(
      path.join(ARCHIVES, "before-rename.txt"),
      path.join(ARCHIVES, "after-rename.txt")
    );
    await page.waitForTimeout(WATCHER_SETTLE);

    // Old name should disappear, new name should appear
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some((i: any) => i.name === "after-rename.txt") &&
        !items.some((i: any) => i.name === "before-rename.txt"),
      30_000
    );

    // Cleanup
    fs.unlinkSync(path.join(ARCHIVES, "after-rename.txt"));
  });

  test("delete Archives file while synced → P0 recovers from Spaces", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Create + select
    const content = "will survive via recovery";
    fs.writeFileSync(path.join(ARCHIVES, "will-delete.txt"), content);
    await page.waitForTimeout(WATCHER_SETTLE);

    const items = await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "will-delete.txt"),
      15_000
    );
    const entry = items.find((i: any) => i.name === "will-delete.txt");
    expect(await apiSelect(page, jwt, [entry.inode])).toBe(200);

    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "will-delete.txt" && i.status === "synced"
        ),
      30_000
    );
    expect(fs.existsSync(path.join(SPACES, "will-delete.txt"))).toBe(true);

    // Delete from Archives while synced
    fs.unlinkSync(path.join(ARCHIVES, "will-delete.txt"));
    await page.waitForTimeout(WATCHER_SETTLE);

    // Pipeline: A_disk=0, S_disk=1, sel=1 → P0 recovers S→A
    // Archives file should be restored from Spaces copy
    // Entry should converge back to synced state
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "will-delete.txt" && i.status === "synced"
        ),
      30_000
    );

    // Both copies should exist (recovered)
    expect(fs.existsSync(path.join(ARCHIVES, "will-delete.txt"))).toBe(true);
    expect(fs.existsSync(path.join(SPACES, "will-delete.txt"))).toBe(true);
    expect(
      fs.readFileSync(path.join(ARCHIVES, "will-delete.txt"), "utf-8")
    ).toBe(content);

    // Cleanup: deselect
    const data = await fetchEntries(page, jwt);
    const e = data.items.find((i: any) => i.name === "will-delete.txt");
    if (e) await apiDeselect(page, jwt, [e.inode]);
    await page.waitForTimeout(3000);
    if (fs.existsSync(path.join(ARCHIVES, "will-delete.txt")))
      fs.unlinkSync(path.join(ARCHIVES, "will-delete.txt"));
  });
});
