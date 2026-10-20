import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Testovi dele stanje demo servera (brojači, log glasova) — redom, ne paralelno.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:18082",
    ...devices["Desktop Chrome"],
  },
});
