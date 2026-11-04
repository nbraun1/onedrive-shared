import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://localhost:5174/onedrive-shared/" },
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    url: "http://localhost:5174/onedrive-shared/",
    reuseExistingServer: false,
    env: { VITE_CLIENT_ID: "" }, // forces the "not configured" path unless a test token is injected
  },
});
