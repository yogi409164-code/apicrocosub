import { serve } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index";
import type { EngineBindings } from "./croco/source";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const index = trimmed.indexOf("=");
		if (index < 0) continue;
		out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
	}
	return out;
}

function loadEnv(): EngineBindings {
	const wrangler = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8")) as { vars?: Record<string, string> };
	const secretsPath = path.join(root, ".dev.vars");
	const secrets = fs.existsSync(secretsPath) ? parseEnvFile(fs.readFileSync(secretsPath, "utf8")) : {};
	return { ...(wrangler.vars ?? {}), ...secrets } as EngineBindings;
}

const env = loadEnv();
const port = Number(process.env.PORT || 8787);
const hostname = process.env.HOST || "127.0.0.1";
const ctx: ExecutionContext = {
	waitUntil(promise) {
		void Promise.resolve(promise).catch((error) => console.error(error));
	},
	passThroughOnException() {},
	props: {},
};

serve(
	{
		fetch: (request) => worker.fetch(request, env, ctx),
		hostname,
		port,
	},
	() => {
		console.log(`CrocoSip API (Node, DigitalOcean Postgres) http://${hostname}:${port}`);
		console.log(`Docs http://${hostname}:${port}/docs`);
	},
);
