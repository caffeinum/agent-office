import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ADMIN_KEY: "test-admin-key-0123456789abcdef" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
