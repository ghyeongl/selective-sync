import { defineConfig } from "@playwright/test";
import path from "path";

const PORT = Number(process.env.TEST_PORT ?? 8188);
const TEST_DIR = process.env.TEST_DIR ?? "/tmp/e2e-sync-test";
const BINARY =
  process.env.BINARY ??
  path.resolve(__dirname, "../filebrowser/filebrowser-darwin-arm64");
const SETUP_SCRIPT = path.resolve(__dirname, "setup-and-run.sh");

// Container mode: when E2E_BASE_URL is set the suite runs against an already
// running selective-syncer container (the deployable artefact) instead of a
// locally built binary, so CI tests what actually ships. The caller owns
// starting the container and seeding TEST_DIR via setup-and-run.sh.
const EXTERNAL_URL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1, // sequential — shared server state
  use: {
    baseURL: EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`,
    headless: true,
    actionTimeout: 10_000,
  },
  ...(EXTERNAL_URL ? {} : { webServer: {
    command: [
      `TEST_DIR=${TEST_DIR}`,
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
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  } }),
});
