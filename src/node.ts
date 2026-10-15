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

function loadFile(name: string): Record<string, string> {
	const file = path.join(root, name);
	return fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, "utf8")) : {};
}

function loadEnv(): EngineBindings {
	const wrangler = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8")) as { vars?: Record<string, string> };
	const fromProcess: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) fromProcess[key] = value;
	}
	const env = { ...(wrangler.vars ?? {}), ...loadFile(".dev.vars"), ...loadFile(".env"), ...fromProcess } as EngineBindings;
	const certFile = path.join(root, "certs", "digitalocean-ca.pem");
	if (!env.POSTGRES_CA_CERT?.trim() && fs.existsSync(certFile)) {
		env.POSTGRES_CA_CERT = fs.readFileSync(certFile, "utf8");
	}
	return env;
}

const env = loadEnv();
const port = Number(process.env.PORT || 8787);
const hostname = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
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
