import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const portable = path.join(root, ".tools", "node22", "node.exe");
const node = fs.existsSync(portable) ? portable : process.execPath;
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const certPath = path.join(root, "certs", "digitalocean-ca.pem");
const wranglerConfig = path.join(root, "wrangler.jsonc");
const host = "dbaas-db-1025064-do-user-46253107-0.e.db.ondigitalocean.com";
const port = "25060";
const user = "doadmin";
const database = "defaultdb";
const hyperdriveName = "crocosip-pg";
const caName = "digitalocean-ca";

function parseEnvFile(text) {
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const index = trimmed.indexOf("=");
		if (index < 0) continue;
		out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
	}
	return out;
}

function run(args, { input, hide } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(node, [wrangler, ...args], {
			cwd: root,
			env: {
				...process.env,
				PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (!hide) process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (!hide) process.stderr.write(chunk);
		});
		if (input) child.stdin.end(input);
		child.on("exit", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error((hide ? "wrangler failed" : stderr || stdout).trim() || `wrangler exited ${code}`));
		});
	});
}

function firstId(text) {
	const match = text.match(/\b[0-9a-f]{32}\b/i) || text.match(/\b[0-9a-f-]{36}\b/i);
	return match?.[0];
}

function upsertHyperdriveBinding(id) {
	let text = fs.readFileSync(wranglerConfig, "utf8");
	const binding = `\t"hyperdrive": [\n\t\t{\n\t\t\t"binding": "HYPERDRIVE",\n\t\t\t"id": "${id}"\n\t\t}\n\t],\n`;
	if (/"hyperdrive"\s*:/.test(text)) {
		text = text.replace(/"hyperdrive"\s*:\s*\[[\s\S]*?\]\s*,/, binding.trimEnd() + "\n");
	} else {
		text = text.replace(/(\t"main": "src\/index.ts",\n)/, `$1${binding}`);
	}
	fs.writeFileSync(wranglerConfig, text);
}

const secretsPath = path.join(root, ".dev.vars");
if (!fs.existsSync(secretsPath)) throw new Error("Missing .dev.vars with POSTGRES_PASSWORD");
const password = parseEnvFile(fs.readFileSync(secretsPath, "utf8")).POSTGRES_PASSWORD;
if (!password) throw new Error("POSTGRES_PASSWORD is empty in .dev.vars");

if (!fs.existsSync(certPath)) {
	await new Promise((resolve, reject) => {
		const child = spawn(node, [path.join(root, "scripts", "extract-do-ca.mjs")], { cwd: root, stdio: "inherit" });
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Failed to extract DigitalOcean CA"))));
	});
}

await run(["whoami"]);

const certs = await run(["cert", "list"]);
let caId = /digitalocean-ca[\s\S]{0,200}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(certs.stdout + certs.stderr)?.[1];
if (!caId) {
	const uploaded = await run(["cert", "upload", "certificate-authority", "--ca-cert", certPath, "--name", caName]);
	caId = firstId(uploaded.stdout + uploaded.stderr);
}
if (!caId) throw new Error("Could not read CA certificate id from wrangler");
console.log(`CA certificate id: ${caId}`);

const listed = await run(["hyperdrive", "list"]);
let hyperdriveId = new RegExp(`${hyperdriveName}[\\s\\S]{0,300}?([0-9a-f]{32})`, "i").exec(listed.stdout + listed.stderr)?.[1];
if (!hyperdriveId) {
	const connection = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
	const created = await run(
		["hyperdrive", "create", hyperdriveName, "--connection-string", connection, "--ca-certificate-id", caId, "--sslmode", "verify-full"],
		{ hide: true },
	);
	hyperdriveId = firstId(created.stdout + created.stderr);
	const preview = (created.stdout + created.stderr).replaceAll(password, "***");
	process.stdout.write(preview);
}
if (!hyperdriveId) throw new Error("Could not read Hyperdrive id from wrangler");
console.log(`Hyperdrive id: ${hyperdriveId}`);

upsertHyperdriveBinding(hyperdriveId);
await run(["secret", "put", "POSTGRES_PASSWORD"], { input: `${password}\n`, hide: true });
console.log("Wrote hyperdrive binding and set POSTGRES_PASSWORD Worker secret.");
console.log("Deploy with: npm run deploy");
