import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/onedrive-shared/",
  test: { include: ["src/**/*.test.ts"] },
});
