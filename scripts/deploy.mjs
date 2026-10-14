import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "crocosip-db";
const CA_NAME = "crocosip-do-ca";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const wranglerJs = path.join(root, "node_modules/wrangler/bin/wrangler.js");

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
	const result = spawnSync(process.execPath, [wranglerJs, ...args], {
		cwd: root,
		encoding: "utf8",
		env: process.env,
	});
	const out = redact(`${result.stdout || ""}\n${result.stderr || ""}`, password);
	return { status: result.status ?? 1, out };
}

function requireOk(step, result) {
	if (result.status === 0) return result;
	console.error(result.out.trim() || `(no output from ${step})`);
	throw new Error(`${step} failed`);
}

function namedId(output, name) {
	const line = output.split(/\r?\n/).find((row) => row.includes(name));
	return line?.match(UUID)?.[0] ?? null;
}

function ensureCa(password) {
	const listed = wrangler(["cert", "list"], password);
	console.log(listed.out.trim());
	const existing = namedId(listed.out, CA_NAME);
	if (existing) return existing;
	const uploaded = requireOk(
		"wrangler cert upload",
		wrangler(["cert", "upload", "certificate-authority", "--ca-cert", "certs/digitalocean-ca.pem", "--name", CA_NAME], password),
	);
	console.log(uploaded.out.trim());
	const id = uploaded.out.match(UUID)?.[0] || namedId(wrangler(["cert", "list"], password).out, CA_NAME);
	if (!id) throw new Error("CA certificate uploaded but no id was returned");
	return id;
}

function ensureHyperdrive(config, password, caId) {
	const listed = wrangler(["hyperdrive", "list"], password);
	console.log(listed.out.trim());
	const existing = namedId(listed.out, NAME);
	if (existing) return existing;
	const created = wrangler(
		[
			"hyperdrive",
			"create",
			NAME,
			"--caching-disabled",
			"--sslmode",
			"verify-full",
			"--ca-certificate-id",
			caId,
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
	console.log(created.out.trim());
	const id = created.status === 0 ? created.out.match(UUID)?.[0] : namedId(wrangler(["hyperdrive", "list"], password).out, NAME);
	if (!id) {
		throw new Error(
			"Could not create Hyperdrive. Grant the apicrocosub build token Hyperdrive and Certificate edit, and allow Cloudflare in DigitalOcean Trusted Sources.",
		);
	}
	return id;
}

function writeHyperdriveId(id) {
	const file = path.join(root, "wrangler.jsonc");
	const config = wranglerConfig();
	config.hyperdrive = [{ binding: "HYPERDRIVE", id }];
	fs.writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`);
}

const password = passwordFromSource();
const config = wranglerConfig();
const caId = ensureCa(password);
console.log(`Using CA ${CA_NAME} (${caId})`);
const id = ensureHyperdrive(config, password, caId);
console.log(`Using Hyperdrive ${NAME} (${id})`);
writeHyperdriveId(id);

const deployed = wrangler(["deploy"], password);
process.stdout.write(deployed.out);
process.exit(deployed.status);
