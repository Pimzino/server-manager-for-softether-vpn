import { defineConfig } from "@playwright/test";
import { BASE_URL } from "./env.ts";

export default defineConfig({
  testDir: "./tests",
  // exFAT/SMB volumes on macOS create AppleDouble "._*" companions next to every file
  testIgnore: "**/._*",
  outputDir: "./artifacts/test-results",
  globalSetup: "./global-setup.ts",
  // Tests share one environment and build on each other's state (servers added in 01 are used later).
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "./artifacts/report", open: "never" }],
    ["json", { outputFile: "./artifacts/results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "on",
    trace: "retain-on-failure",
  },
});
