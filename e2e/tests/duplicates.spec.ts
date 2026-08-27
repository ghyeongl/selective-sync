/**
 * Duplicate-sibling report — GET /api/sync/duplicates.
 *
 * Reproduces the rename-collision shape from
 * docs/issues/rename-collision-duplicates.md: two sibling directories under
 * one parent holding byte-identical subtrees. Asserts the report groups them,
 * and that a sibling with the same file count but different bytes is excluded
 * (the doc's warning that name/count similarity alone yields false positives).
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const ARCHIVES = process.env.E2E_ARCHIVES_DIR ?? path.join(TEST_DIR, "Archives");

// Watcher debounce is 300ms; the catalog needs a moment to register the tree.
const SETTLE = 45000;

async function apiLogin(page: Page): Promise<string> {
  let jwt = await page.evaluate(() => localStorage.getItem("jwt") ?? "");
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

function writeTree(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

test("reports identical sibling subtrees and skips byte-different ones", async ({
  page,
}) => {
  const parent = path.join(ARCHIVES, "dupe-probe");
  fs.rmSync(parent, { recursive: true, force: true });

  // `original` and `renamed` are byte-identical; `different` matches on file
  // count but not on bytes, so it must not be grouped with them.
  const contents = { "a.txt": "alpha", "b.txt": "bravo" };
  writeTree(path.join(parent, "original"), contents);
  writeTree(path.join(parent, "renamed"), contents);
  writeTree(path.join(parent, "different"), {
    "a.txt": "alpha",
    "b.txt": "bravo-but-longer",
  });

  await page.goto("/");
  const jwt = await apiLogin(page);

  // The watcher debounces and the catalog registration is asynchronous; on a
  // loaded Pi a fixed wait is not enough, so poll until the group appears.
  const fetchDupes = async () =>
    page.evaluate(async (jwt) => {
      const resp = await fetch("/api/sync/duplicates?min_files=2", {
        headers: { "X-Auth": jwt },
      });
      if (!resp.ok) throw new Error(`duplicates failed: ${resp.status}`);
      return resp.json();
    }, jwt);

  let body = await fetchDupes();
  const deadline = Date.now() + SETTLE;
  while (
    Date.now() < deadline &&
    !body.groups?.some((g: { parentPath: string }) => g.parentPath === "dupe-probe")
  ) {
    await page.waitForTimeout(2000);
    body = await fetchDupes();
  }

  expect(Array.isArray(body.groups)).toBe(true);
  expect(typeof body.reclaimable).toBe("number");

  const group = body.groups.find(
    (g: { parentPath: string }) => g.parentPath === "dupe-probe"
  );
  expect(group, `no group for dupe-probe in ${JSON.stringify(body.groups)}`)
    .toBeTruthy();

  expect(group.names).toEqual(["original", "renamed"]);
  expect(group.names).not.toContain("different");
  expect(group.fileCount).toBe(2);

  // names[i] must identify inodes[i] — a caller trims by inode.
  expect(group.inodes).toHaveLength(group.names.length);
  expect(new Set(group.inodes).size).toBe(group.inodes.length);
});
