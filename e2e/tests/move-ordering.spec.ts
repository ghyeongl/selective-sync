/**
 * A move whose SOURCE is evaluated before its destination must not duplicate.
 *
 * Both halves of a move arrive in one debounce batch, and the batch was ordered
 * by NAME — so whether a move survived came down to whether the destination
 * happened to sort before the source. Found barefoot on pi3:
 *
 *     mv a-file.txt zz/a-file.txt
 *     Archives: a-file.txt (revived) + zz/a-file.txt
 *     Spaces:   a-file.txt (never moved)
 *     log:      P1 "restored to Archives from Spaces", no move resolved
 *
 * P1 copies the source back from Spaces AND re-keys the row to the resurrected
 * inode — SafeCopy renames a temp into place, so the revived file has a new one.
 * That erases the only link P0 uses, and the destination then reads as an inode
 * the catalog has never seen.
 *
 * The whole 40-test suite passed while this was live, because every other move
 * test happened to use the favourable ordering. The names here are chosen so the
 * source sorts FIRST: "a-move-src.txt" < "zz-move-dst/...".
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = process.env.E2E_ARCHIVES_DIR ?? path.join(TEST_DIR, "Archives");
const SPACES = process.env.E2E_SPACES_DIR ?? path.join(TEST_DIR, "Spaces");

const SRC = "a-move-src.txt";
const DST_DIR = "zz-move-dst";

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

async function listPath(page: Page, jwt: string, rel: string) {
  return page.evaluate(
    async ({ jwt, rel }) => {
      const resp = await fetch(
        `/api/sync/entries?path=${encodeURIComponent(rel)}`,
        { headers: { "X-Auth": jwt } }
      );
      if (!resp.ok) return null;
      const body = await resp.json();
      return body.items as Array<{ inode: number; name: string; selected: boolean; status: string }>;
    },
    { jwt, rel }
  );
}

test.afterAll(() => {
  for (const root of [ARCHIVES, SPACES]) {
    fs.rmSync(path.join(root, SRC), { force: true });
    fs.rmSync(path.join(root, DST_DIR), { recursive: true, force: true });
  }
});

test("a source-first move relocates instead of duplicating", async ({ page }) => {
  fs.mkdirSync(path.join(ARCHIVES, DST_DIR), { recursive: true });
  fs.writeFileSync(path.join(ARCHIVES, SRC), "move ordering fixture");

  await page.goto("/");
  await page.waitForTimeout(3000);
  const jwt = await apiLogin(page);

  // Register, then select so the file is projected into Spaces — the selected
  // case is the one that breaks, because P1 has something to revive from.
  await expect
    .poll(async () => (await listPath(page, jwt, ""))?.some((i) => i.name === SRC), {
      timeout: 30_000,
    })
    .toBe(true);
  const root = await listPath(page, jwt, "");
  const src = root!.find((i) => i.name === SRC)!;
  const resp = await page.evaluate(
    async ({ jwt, inode }) => {
      const r = await fetch("/api/sync/select", {
        method: "POST",
        headers: { "X-Auth": jwt, "Content-Type": "application/json" },
        body: JSON.stringify({ inodes: [inode] }),
      });
      return r.status;
    },
    { jwt, inode: src.inode }
  );
  expect(resp).toBe(200);
  await expect
    .poll(() => fs.existsSync(path.join(SPACES, SRC)), { timeout: 60_000 })
    .toBe(true);

  // The move. Source sorts before the destination, so it is evaluated first.
  fs.renameSync(
    path.join(ARCHIVES, SRC),
    path.join(ARCHIVES, DST_DIR, SRC)
  );

  await expect
    .poll(async () => (await listPath(page, jwt, DST_DIR))?.some((i) => i.name === SRC), {
      timeout: 90_000,
    })
    .toBe(true);

  // The source path must NOT come back. This is the duplicate.
  await expect
    .poll(() => fs.existsSync(path.join(ARCHIVES, SRC)), { timeout: 30_000 })
    .toBe(false);
  expect(fs.existsSync(path.join(ARCHIVES, DST_DIR, SRC))).toBe(true);

  // Spaces must have followed rather than been left at the old path.
  await expect
    .poll(() => fs.existsSync(path.join(SPACES, DST_DIR, SRC)), { timeout: 60_000 })
    .toBe(true);
  expect(fs.existsSync(path.join(SPACES, SRC))).toBe(false);

  // One row, still selected, and nothing left at the source.
  const moved = (await listPath(page, jwt, DST_DIR))!.find((i) => i.name === SRC)!;
  expect(moved.inode).toBe(src.inode); // a move keeps the inode; a re-register would not
  expect(moved.selected).toBe(true);
  const rootAfter = await listPath(page, jwt, "");
  expect(rootAfter!.some((i) => i.name === SRC)).toBe(false);
});

/**
 * Moving a synced FOLDER must relocate the subtree, not re-register it.
 *
 * This is the shape of a bulk reorganisation, and it had no e2e coverage while
 * it was broken. P0 identified directories by mtime, which is never refreshed
 * for a directory row — dirs are deliberately never A_dirty — so the row's
 * mtime is frozen at registration and drifts the moment a child is added.
 * Every real folder move was therefore rejected as "content differs", and:
 *
 *   - p2 relocated the row through its stale-inode path with sel = S_disk,
 *     false at the new location, so the whole subtree lost its selection
 *   - Spaces was never renamed, leaving an orphan at the old path
 *   - P1 promoted that orphan back, producing an empty phantom folder
 *     reporting itself synced
 *
 * The subtree here gains a file AFTER the folder is registered, which is what
 * makes the row's mtime stale. A folder registered with its contents already
 * in place would not reproduce it — the ordinary state of a real folder is the
 * one that breaks.
 */
const F_SRC = "a-dir-src";
const F_DST = "zz-dir-dst";

test.afterAll(() => {
  for (const root of [ARCHIVES, SPACES]) {
    fs.rmSync(path.join(root, F_SRC), { recursive: true, force: true });
    fs.rmSync(path.join(root, F_DST), { recursive: true, force: true });
  }
});

test("moving a synced folder relocates the subtree and keeps selection", async ({
  page,
}) => {
  fs.mkdirSync(path.join(ARCHIVES, F_SRC), { recursive: true });
  fs.mkdirSync(path.join(ARCHIVES, F_DST), { recursive: true });

  await page.goto("/");
  await page.waitForTimeout(3000);
  const jwt = await apiLogin(page);

  // Register the folder FIRST, then add a child — this is what makes the row's
  // recorded mtime stale, and it is the case that used to fail.
  await expect
    .poll(async () => (await listPath(page, jwt, ""))?.some((i) => i.name === F_SRC), {
      timeout: 30_000,
    })
    .toBe(true);
  fs.writeFileSync(path.join(ARCHIVES, F_SRC, "leaf.txt"), "leaf payload");
  await expect
    .poll(async () => (await listPath(page, jwt, F_SRC))?.some((i) => i.name === "leaf.txt"), {
      timeout: 30_000,
    })
    .toBe(true);

  const folder = (await listPath(page, jwt, ""))!.find((i) => i.name === F_SRC)!;
  const leafBefore = (await listPath(page, jwt, F_SRC))!.find((i) => i.name === "leaf.txt")!;

  const status = await page.evaluate(
    async ({ jwt, inode }) => {
      const r = await fetch("/api/sync/select", {
        method: "POST",
        headers: { "X-Auth": jwt, "Content-Type": "application/json" },
        body: JSON.stringify({ inodes: [inode] }),
      });
      return r.status;
    },
    { jwt, inode: folder.inode }
  );
  expect(status).toBe(200);
  await expect
    .poll(() => fs.existsSync(path.join(SPACES, F_SRC, "leaf.txt")), { timeout: 90_000 })
    .toBe(true);

  fs.renameSync(path.join(ARCHIVES, F_SRC), path.join(ARCHIVES, F_DST, F_SRC));

  await expect
    .poll(async () => (await listPath(page, jwt, F_DST))?.some((i) => i.name === F_SRC), {
      timeout: 90_000,
    })
    .toBe(true);

  // No phantom resurrected at the old path, in either root.
  await expect
    .poll(() => fs.existsSync(path.join(ARCHIVES, F_SRC)), { timeout: 30_000 })
    .toBe(false);
  expect(fs.existsSync(path.join(SPACES, F_SRC))).toBe(false);

  // The subtree followed, keeping its identity and its selection — a
  // re-registration would leave a row here too, but with a new inode and
  // selected=false, which is exactly the failure.
  const movedDir = (await listPath(page, jwt, F_DST))!.find((i) => i.name === F_SRC)!;
  expect(movedDir.inode).toBe(folder.inode);

  const movedLeaf = (await listPath(page, jwt, `${F_DST}/${F_SRC}`))!.find(
    (i) => i.name === "leaf.txt"
  )!;
  expect(movedLeaf.inode).toBe(leafBefore.inode);
  expect(movedLeaf.selected).toBe(true);

  await expect
    .poll(() => fs.existsSync(path.join(SPACES, F_DST, F_SRC, "leaf.txt")), {
      timeout: 90_000,
    })
    .toBe(true);
});
