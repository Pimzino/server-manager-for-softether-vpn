import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // exFAT volumes on macOS create AppleDouble "._*" companions next to every file
  testIgnore: "**/._*",
  outputDir: "./artifacts/test-results",
  globalSetup: "./global-setup.ts",
  // One Electron app and two SoftEther servers shared by all specs, which build on each other's state
  // (connections added by 00 are reused later; 01 restarts the app on the same data directory).
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "./artifacts/report", open: "never" }],
    ["json", { outputFile: "./artifacts/results.json" }],
  ],
  use: { trace: "off", actionTimeout: 20_000 },
});
