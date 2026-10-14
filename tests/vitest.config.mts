import fs from "node:fs";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests use DigitalOcean PostgreSQL through a local Hyperdrive binding, in a throwaway schema.
const pgSchema = process.env.CROCO_PG_SCHEMA ?? "crocosip_worker_test";
const pgUrl = postgresUrl();

function postgresUrl(): string {
	const root = path.join(__dirname, "..");
	const config = JSON.parse(
		fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
	) as { vars: Record<string, string> };
	const secrets = Object.fromEntries(
		fs
			.readFileSync(path.join(root, ".dev.vars"), "utf8")
			.split(/\r?\n/)
			.filter((line) => line.includes("="))
			.map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
	);
	const v = config.vars;
	const user = encodeURIComponent(v.POSTGRES_USER);
	const password = encodeURIComponent(secrets.POSTGRES_PASSWORD ?? "");
	return `postgresql://${user}:${password}@${v.POSTGRES_HOST}:${v.POSTGRES_PORT}/${v.POSTGRES_DB}?sslmode=${v.POSTGRES_SSLMODE || "require"}`;
}

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
