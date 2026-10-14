import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "crocosip-db";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function passwordFromSource() {
	const source = fs.readFileSync(path.join(root, "src/croco/source.ts"), "utf8");
	const match = source.match(/const POSTGRES_PASSWORD = "([^"]+)"/);
	if (!match) throw new Error("POSTGRES_PASSWORD is missing from src/croco/source.ts");
	return match[1];
}

function wranglerConfig() {
	return JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

function redact(text, password) {
	return password ? text.split(password).join("(hidden)") : text;
}

function wrangler(args, password) {
	const result = spawnSync("npx", ["wrangler", ...args], {
		cwd: root,
		encoding: "utf8",
		shell: true,
		env: process.env,
	});
	const out = redact(`${result.stdout || ""}\n${result.stderr || ""}`, password);
	return { status: result.status ?? 1, out };
}

function existingId(password) {
	const listed = wrangler(["hyperdrive", "list"], password);
	const named = listed.out.split(/\r?\n/).find((line) => line.includes(NAME));
	const fromName = named?.match(UUID)?.[0];
	if (fromName) return fromName;
	const configured = wranglerConfig().hyperdrive?.[0]?.id;
	if (configured && UUID.test(configured) && !configured.startsWith("00000000")) return configured;
	return null;
}

function createId(config, password) {
	const created = wrangler(
		[
			"hyperdrive",
			"create",
			NAME,
			"--caching-disabled",
			"--sslmode",
			"require",
			"--origin-scheme",
			"postgresql",
			"--host",
			config.vars.POSTGRES_HOST,
			"--port",
			String(config.vars.POSTGRES_PORT),
			"--database",
			config.vars.POSTGRES_DB,
			"--user",
			config.vars.POSTGRES_USER,
			"--password",
			password,
			"--binding",
			"HYPERDRIVE",
		],
		password,
	);
	const id = created.out.match(UUID)?.[0];
	if (created.status === 0 && id) return id;
	const again = existingId(password);
	if (again) return again;
	console.error(created.out.trim());
	throw new Error(
		"Could not create Hyperdrive. The Cloudflare build token needs Hyperdrive edit permission, and DigitalOcean Trusted Sources must allow Cloudflare.",
	);
}

function writeHyperdriveId(id) {
	const file = path.join(root, "wrangler.jsonc");
	const config = wranglerConfig();
	config.hyperdrive = [{ binding: "HYPERDRIVE", id }];
	fs.writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`);
}

const password = passwordFromSource();
const config = wranglerConfig();
const id = existingId(password) || createId(config, password);
console.log(`Using Hyperdrive ${NAME} (${id})`);
writeHyperdriveId(id);

const deployed = wrangler(["deploy"], password);
process.stdout.write(deployed.out);
process.exit(deployed.status);
