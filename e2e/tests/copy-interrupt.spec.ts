/**
 * Copy-interruption tests — select a ~1GB file, then IMMEDIATELY
 * send competing requests (deselect, delete source, modify source)
 * without waiting for the copy to finish.
 *
 * On fast SSDs, 1GB copies finish in <1s, so interruptions must be
 * fired immediately after select (no artificial delay). The test
 * verifies the system converges to a correct final state regardless
 * of whether the interruption caught the copy mid-flight or not.
 *
 * SafeCopy checks hasQueued() every 256KB chunk, so re-queuing
 * the same path during copy should abort it. On fast SSDs, the copy
 * may complete before the re-queue — both outcomes must be valid.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = path.join(TEST_DIR, "Archives");
const SPACES = path.join(TEST_DIR, "Spaces");

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

async function loginAndWait(page: Page, minEntries = 25) {
  await page.goto("/");
  await page.waitForTimeout(3000);
  const jwt = await apiLogin(page);
  await pollUntil(page, jwt, (items) => items.length >= minEntries, 30_000);
  return jwt;
}

function noTmpFiles(): boolean {
  const spacesFiles = fs.existsSync(SPACES) ? fs.readdirSync(SPACES) : [];
  return !spacesFiles.some((f) => f.endsWith(".sync-tmp"));
}

// ── Tests ──

test.describe.serial("1GB Copy Interruption", () => {
  test("giant-file.dat exists in Archives", async ({ page }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");
    expect(giant).toBeTruthy();
    expect(giant.status).toBe("archived");
    const stat = fs.statSync(path.join(ARCHIVES, "giant-file.dat"));
    expect(stat.size).toBe(1024 * 1024 * 1024);
  });

  test("select 1GB → immediate deselect → final state archived, no tmp", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Select — queues path for SafeCopy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Deselect IMMEDIATELY — no waiting. On fast SSD the copy might
    // already be done, or it might still be in progress.
    // Either way: deselect pushes the path to queue.
    //   Case A (copy in progress): hasQueued() → true → SafeCopy aborts → re-eval with sel=0
    //   Case B (copy done): re-eval sees sel=0 → P3 removes from Spaces
    expect(await apiDeselect(page, jwt, [giant.inode])).toBe(200);

    // Final state: archived (sel=0)
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        return g != null && g.status === "archived";
      },
      120_000
    );

    expect(fs.existsSync(path.join(SPACES, "giant-file.dat"))).toBe(false);
    expect(noTmpFiles()).toBe(true);
  });

  test("select 1GB → immediate delete Archives source → converges", async ({
    page,
  }) => {
    // giant-file.dat should still exist from setup (deselect doesn't delete Archives)
    expect(fs.existsSync(path.join(ARCHIVES, "giant-file.dat"))).toBe(true);

    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Select — queues SafeCopy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Delete Archives source IMMEDIATELY
    // On Unix, open file handles survive unlink — SafeCopy may complete.
    //   Case A (SafeCopy fails on read/mtime): error, tmp cleaned
    //   Case B (SafeCopy completes → Spaces copy exists):
    //     Watcher re-queues → A_disk=0, S_disk=1 → P0 recovers S→A
    fs.unlinkSync(path.join(ARCHIVES, "giant-file.dat"));

    // The pipeline must converge to one of:
    // - Recovered: Archives restored from Spaces (P0 recovery), status=synced
    // - Cleaned up: entry removed, no Spaces copy
    // Both are valid. Wait for a stable terminal state.
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        // Either gone (cleaned up) or synced (recovered)
        return g == null || g.status === "synced" || g.status === "archived";
      },
      120_000
    );

    expect(noTmpFiles()).toBe(true);

    // Cleanup: if recovered, deselect to clean Spaces
    const finalData = await fetchEntries(page, jwt);
    const finalGiant = finalData.items.find(
      (e: any) => e.name === "giant-file.dat"
    );
    if (finalGiant) {
      await apiDeselect(page, jwt, [finalGiant.inode]);
      await page.waitForTimeout(5000);
    }
  });

  test("select 1GB → immediate mtime touch → ErrSourceModified or re-sync", async ({
    page,
  }) => {
    // Ensure giant file exists
    const giantPath = path.join(ARCHIVES, "giant-file.dat");
    if (!fs.existsSync(giantPath)) {
      const fd = fs.openSync(giantPath, "w");
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 1024; i++) {
        fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd);
      // Wait for watcher to detect
      await new Promise((r) => setTimeout(r, 2000));
    }

    const jwt = await loginAndWait(page);
    await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "giant-file.dat"),
      30_000
    );

    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Select — starts SafeCopy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Touch mtime IMMEDIATELY — no waiting
    //   If copy not started yet: watcher queues → hasQueued() aborts copy → re-eval
    //   If copy in progress: SafeCopy's mtime check may fail → ErrSourceModified
    //   If copy done: watcher queues → P2 detects A_dirty → re-sync
    const now = new Date();
    fs.utimesSync(giantPath, now, now);

    // Should eventually reach synced (after re-copy if needed)
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        return g != null && g.status === "synced";
      },
      180_000
    );

    const spacesPath = path.join(SPACES, "giant-file.dat");
    expect(fs.existsSync(spacesPath)).toBe(true);
    expect(fs.statSync(spacesPath).size).toBe(1024 * 1024 * 1024);
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(5000);
  });

  test("select 1GB → rapid toggle 5x → final select wins → synced", async ({
    page,
  }) => {
    const giantPath = path.join(ARCHIVES, "giant-file.dat");
    if (!fs.existsSync(giantPath)) {
      const fd = fs.openSync(giantPath, "w");
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 1024; i++) {
        fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd);
      await new Promise((r) => setTimeout(r, 2000));
    }

    const jwt = await loginAndWait(page);
    await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "giant-file.dat"),
      30_000
    );

    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Select — starts copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Rapid toggle 5 times — NO waiting between calls
    // Each push re-queues, causing hasQueued() abort if copy is in progress
    for (let i = 0; i < 5; i++) {
      await apiDeselect(page, jwt, [giant.inode]);
      await apiSelect(page, jwt, [giant.inode]);
    }

    // Final state: selected=true → should eventually sync
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        return g != null && g.status === "synced";
      },
      180_000
    );

    expect(fs.existsSync(path.join(SPACES, "giant-file.dat"))).toBe(true);
    expect(fs.statSync(path.join(SPACES, "giant-file.dat")).size).toBe(
      1024 * 1024 * 1024
    );
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(5000);
  });
});

test.describe.serial("Operations during 1GB copy", () => {
  // These tests fire the 1GB select, then perform OTHER operations
  // while the worker is busy copying. The worker is sequential —
  // other queue items accumulate and are processed after the copy.

  test("select 1GB + select small files simultaneously → all converge", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");
    const smalls = data.items
      .filter((e: any) => e.name.startsWith("small-"))
      .slice(0, 5);
    expect(smalls.length).toBe(5);

    // Select giant + 5 smalls in one batch — worker processes sequentially
    const allInodes = [giant.inode, ...smalls.map((s: any) => s.inode)];
    expect(await apiSelect(page, jwt, allInodes)).toBe(200);

    // All 6 should eventually reach synced
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const syncedSmalls = items.filter(
          (i: any) =>
            i.name.startsWith("small-") && i.status === "synced"
        );
        return g != null && g.status === "synced" && syncedSmalls.length >= 5;
      },
      180_000
    );

    // Verify disk
    expect(fs.existsSync(path.join(SPACES, "giant-file.dat"))).toBe(true);
    for (const s of smalls) {
      expect(fs.existsSync(path.join(SPACES, s.name))).toBe(true);
    }
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, allInodes);
    await page.waitForTimeout(5000);
  });

  test("select 1GB → deselect different small file during copy", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");
    const small1 = data.items.find((e: any) => e.name === "small-1.txt");

    // Pre-sync small-1
    expect(await apiSelect(page, jwt, [small1.inode])).toBe(200);
    await pollUntil(
      page,
      jwt,
      (items) =>
        items.some(
          (i: any) => i.name === "small-1.txt" && i.status === "synced"
        ),
      30_000
    );

    // Start 1GB copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Immediately deselect small-1 while worker is busy with giant
    expect(await apiDeselect(page, jwt, [small1.inode])).toBe(200);

    // Both should converge: giant=synced, small-1=archived
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const s = items.find((i: any) => i.name === "small-1.txt");
        return (
          g != null &&
          g.status === "synced" &&
          s != null &&
          s.status === "archived"
        );
      },
      180_000
    );

    expect(fs.existsSync(path.join(SPACES, "giant-file.dat"))).toBe(true);
    expect(fs.existsSync(path.join(SPACES, "small-1.txt"))).toBe(false);
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(5000);
  });

  test("select 1GB → create new file in Archives during copy → detected", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Start 1GB copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Create a new file in Archives while worker is busy
    fs.writeFileSync(
      path.join(ARCHIVES, "during-copy.txt"),
      "created during 1GB copy"
    );

    // Both should converge: giant=synced, new file registered as archived
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const dc = items.find((i: any) => i.name === "during-copy.txt");
        return (
          g != null && g.status === "synced" && dc != null && dc.status === "archived"
        );
      },
      180_000
    );

    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(3000);
    fs.unlinkSync(path.join(ARCHIVES, "during-copy.txt"));
    await page.waitForTimeout(3000);
  });

  test("select 1GB → delete different Archives file during copy → entry removed", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);

    // Create a temp file to delete later
    fs.writeFileSync(path.join(ARCHIVES, "to-delete.txt"), "will be deleted");
    await page.waitForTimeout(2000);
    await pollUntil(
      page,
      jwt,
      (items) => items.some((i: any) => i.name === "to-delete.txt"),
      15_000
    );

    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Start 1GB copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Delete a different file while worker is busy copying giant
    fs.unlinkSync(path.join(ARCHIVES, "to-delete.txt"));

    // Giant should sync, deleted file should be removed from entries
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const td = items.find((i: any) => i.name === "to-delete.txt");
        return g != null && g.status === "synced" && td == null;
      },
      180_000
    );

    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(5000);
  });

  test("select 1GB → create Spoke file in Spaces during copy → recovered", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Start 1GB copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Simulate Spoke creating a file in Spaces while worker is busy
    fs.writeFileSync(
      path.join(SPACES, "spoke-during-copy.txt"),
      "spoke created this"
    );

    // Giant should sync, Spoke file should be recovered (P0: S→A, P1: register sel=1)
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const sp = items.find((i: any) => i.name === "spoke-during-copy.txt");
        return (
          g != null &&
          g.status === "synced" &&
          sp != null &&
          sp.status === "synced"
        );
      },
      180_000
    );

    // Both should exist in Archives (recovered) and Spaces
    expect(fs.existsSync(path.join(ARCHIVES, "spoke-during-copy.txt"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(SPACES, "spoke-during-copy.txt"))).toBe(
      true
    );
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    const finalData = await fetchEntries(page, jwt);
    const spokeEntry = finalData.items.find(
      (e: any) => e.name === "spoke-during-copy.txt"
    );
    if (spokeEntry) await apiDeselect(page, jwt, [spokeEntry.inode]);
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(3000);
    if (fs.existsSync(path.join(ARCHIVES, "spoke-during-copy.txt")))
      fs.unlinkSync(path.join(ARCHIVES, "spoke-during-copy.txt"));
  });

  test("select 1GB → synced → delete Spaces copy → pipeline re-copies", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");

    // Sync the giant file first
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        return g != null && g.status === "synced";
      },
      180_000
    );

    // Now delete the Spaces copy — pipeline should detect S_disk=0
    // and re-copy from Archives (sel=1, A_disk=1, S_disk=0 → P3: SafeCopy A→S)
    const spacesGiant = path.join(SPACES, "giant-file.dat");
    expect(fs.existsSync(spacesGiant)).toBe(true);
    fs.unlinkSync(spacesGiant);

    // Wait for re-copy to complete
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        return g != null && g.status === "synced";
      },
      180_000
    );

    expect(fs.existsSync(spacesGiant)).toBe(true);
    expect(fs.statSync(spacesGiant).size).toBe(1024 * 1024 * 1024);
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode]);
    await page.waitForTimeout(5000);
  });

  test("select 1GB → API burst (10 different files) during copy → all processed", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");
    const smalls = data.items
      .filter((e: any) => e.name.startsWith("small-"))
      .slice(0, 10);

    // Start 1GB copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Fire 10 concurrent select calls for different files while worker is busy
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
      { jwt, inodes: smalls.map((s: any) => s.inode) }
    );

    // Some may fail due to SQLite contention — retry failed
    const failed = smalls.filter((_: any, i: number) => results[i] !== 200);
    for (const s of failed) {
      await apiSelect(page, jwt, [s.inode]);
    }

    // All 11 should eventually sync (giant + 10 smalls)
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const syncedSmalls = items.filter(
          (i: any) =>
            i.name.startsWith("small-") && i.status === "synced"
        );
        return g != null && g.status === "synced" && syncedSmalls.length >= 10;
      },
      180_000
    );

    expect(noTmpFiles()).toBe(true);

    // Cleanup
    const allInodes = [
      giant.inode,
      ...smalls.map((s: any) => s.inode),
    ];
    await apiDeselect(page, jwt, allInodes);
    await page.waitForTimeout(5000);
  });

  test("select 1GB → select folder during copy → children queued after", async ({
    page,
  }) => {
    const jwt = await loginAndWait(page);
    const data = await fetchEntries(page, jwt);
    const giant = data.items.find((e: any) => e.name === "giant-file.dat");
    const testDir = data.items.find((e: any) => e.name === "test-dir");
    expect(testDir).toBeTruthy();

    // Start 1GB copy
    expect(await apiSelect(page, jwt, [giant.inode])).toBe(200);

    // Select folder while worker is busy copying giant
    expect(await apiSelect(page, jwt, [testDir.inode])).toBe(200);

    // Both should converge: giant=synced, test-dir + all children=synced
    await pollUntil(
      page,
      jwt,
      (items) => {
        const g = items.find((i: any) => i.name === "giant-file.dat");
        const td = items.find((i: any) => i.name === "test-dir");
        return (
          g != null &&
          g.status === "synced" &&
          td != null &&
          td.status === "synced"
        );
      },
      180_000
    );

    // Verify children
    const children = await fetchEntries(page, jwt, {
      parentIno: testDir.inode,
    });
    expect(
      children.items.every((c: any) => c.status === "synced")
    ).toBe(true);

    for (let i = 1; i <= 10; i++) {
      expect(
        fs.existsSync(
          path.join(SPACES, "test-dir", `child-${i}.txt`)
        )
      ).toBe(true);
    }
    expect(noTmpFiles()).toBe(true);

    // Cleanup
    await apiDeselect(page, jwt, [giant.inode, testDir.inode]);
    await page.waitForTimeout(5000);
  });
});
