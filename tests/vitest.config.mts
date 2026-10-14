import fs from "node:fs";
import path from "node:path";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = path.join(__dirname, "..", "migrations");
const migrations = await readD1Migrations(migrationsPath);

// CROCO_PG=1 runs the suite against PostgreSQL (POSTGRES_* from wrangler.jsonc and .dev.vars)
// through a local Hyperdrive binding, inside a throwaway schema. Otherwise the tests use local D1.
const pgSchema = process.env.CROCO_PG_SCHEMA ?? "crocosip_worker_test";
const pgUrl = process.env.CROCO_PG === "1" ? postgresUrl() : undefined;

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
					MIGRATIONS: migrations,
					...(pgUrl ? { DB_SCHEMA: pgSchema } : {}),
				},
				...(pgUrl ? { hyperdrives: { HYPERDRIVE: pgUrl } } : {}),
			},
		}),
	],
	esbuild: {
		target: "esnext",
	},
	test: {
		setupFiles: ["./tests/apply-migrations.ts"],
		// Every request opens a fresh TLS connection to the remote database.
		testTimeout: pgUrl ? 120_000 : 5_000,
	},
});
