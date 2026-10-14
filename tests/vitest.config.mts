import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const pgSchema = process.env.CROCO_PG_SCHEMA ?? "crocosip_worker_test";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: "./wrangler.jsonc",
			},
			miniflare: {
				compatibilityFlags: ["experimental", "nodejs_compat"],
				bindings: {
					DB_SCHEMA: pgSchema,
				},
			},
		}),
	],
	esbuild: {
		target: "esnext",
	},
	test: {
		setupFiles: ["./tests/apply-migrations.ts"],
		testTimeout: 120_000,
		onUnhandledError: (error) => !(error.message === "Stream was cancelled." && error.stack?.includes("postgres/cf/polyfills")),
	},
});
