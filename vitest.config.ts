import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// Four projects: the Worker under workerd, the Merit agent and the admin
// scripts under plain Node, and the web front end under happy-dom.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => {
            const root = fileURLToPath(new URL(".", import.meta.url));
            const migrations = await readD1Migrations(root + "migrations");
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  ENV: "dev",
                  MERIT_SECRET: "dev-merit-secret",
                  CODE_PEPPER: "dev-code-pepper",
                  RESEND_API_KEY: "test-resend-key",
                  // Tests turn the TEMPORARY test bypass on themselves; the deployed value must not leak in.
                  TEST_LOGINS: "off",
                  PHOTO_LINK_KEY: "test-photo-link-key",
                },
              },
            };
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      {
        test: {
          name: "agent",
          include: ["merit-agent/**/*.test.mjs"],
          environment: "node",
        },
      },
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [preact()],
        test: {
          name: "web",
          include: ["web/test/**/*.test.tsx", "web/test/**/*.test.ts"],
          environment: "happy-dom",
        },
      },
    ],
  },
});
