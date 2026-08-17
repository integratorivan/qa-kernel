import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const outputDirectory = process.env.QA_REPLAY_OUTPUT_DIR ? resolve(process.env.QA_REPLAY_OUTPUT_DIR) : resolve(".qa/replays/direct");

export default defineConfig({
  testDir: ".",
  testMatch: /spec\.ts$/,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: resolve(outputDirectory, "test-results"),
  reporter: [["list"], ["html", { outputFolder: resolve(outputDirectory, "report"), open: "never" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    baseURL: undefined,
  },
});
