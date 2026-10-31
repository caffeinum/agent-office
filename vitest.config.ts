import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // the City DO runs on the v2 fixture in tests
      miniflare: { bindings: { ADMIN_KEY: "test-admin-key-0123456789abcdef", CITY_SF_ASSETS: "/city/fixture/" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
