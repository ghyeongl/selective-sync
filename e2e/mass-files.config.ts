import { defineConfig } from "@playwright/test";
import path from "path";

const PORT = Number(process.env.TEST_PORT ?? 8188);
const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const MASS_FILE_COUNT = Number(process.env.MASS_FILE_COUNT ?? 10_000);
const BINARY =
  process.env.BINARY ??
  path.resolve(__dirname, "../filebrowser/filebrowser-darwin-arm64");
const SETUP_SCRIPT = path.resolve(__dirname, "setup-and-run.sh");

export default defineConfig({
  testDir: "./tests",
  testMatch: "mass-files.spec.ts",
  timeout: 900_000, // 15 min per test — mass operations are slow
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    actionTimeout: 10_000,
  },
  webServer: {
    command: [
      `TEST_DIR=${TEST_DIR}`,
      `MASS_FILE_COUNT=${MASS_FILE_COUNT}`,
      `bash ${SETUP_SCRIPT}`,
      BINARY,
      "--noauth",
      `-a 127.0.0.1`,
      `-p ${PORT}`,
      `-d ${TEST_DIR}/filebrowser.db`,
      `--archivesPath ${TEST_DIR}/Archives`,
      `--spacesPath ${TEST_DIR}/Spaces`,
      `--root ${TEST_DIR}`,
    ].join(" "),
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000, // 2 min — mass file creation takes time
    stdout: "pipe",
    stderr: "pipe",
  },
});
