import { defineConfig } from "@playwright/test";
import { defineE2eConfig } from "./src/test.js";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.e2e.ts",
  ...defineE2eConfig({
    backend: {
      command: "bun test/fixture/e2e-main.ts",
      url: "http://127.0.0.1:3100/health/ready",
    },
    frontend: {
      command: "bun test/fixture/frontend/serve.ts",
      url: "http://127.0.0.1:3200/",
    },
  }),
});
