import fs from "node:fs";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const pgSchema = process.env.CROCO_PG_SCHEMA ?? "crocosip_worker_test";
const source = fs.readFileSync(path.join(__dirname, "..", "src/croco/source.ts"), "utf8");
const pgUrl = source.match(/export const DATABASE_URL =\s*"([^"]+)"/)?.[1] ?? "";

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
				hyperdrives: { HYPERDRIVE: pgUrl },
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
