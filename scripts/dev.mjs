import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseVars(text) {
	return Object.fromEntries(
		text
			.replace(/^\s*\/\/.*$/gm, "")
			.split(/\r?\n/)
			.filter((line) => line.includes("=") && !line.trim().startsWith("{"))
			.map((line) => {
				const i = line.indexOf("=");
				return [line.slice(0, i).trim().replace(/^"+|"+$/g, ""), line.slice(i + 1).trim().replace(/^"|"+$/g, "")];
			})
			.filter(([key]) => key),
	);
}

const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const secrets = parseVars(fs.readFileSync(path.join(root, ".dev.vars"), "utf8"));
const v = config.vars;
const user = encodeURIComponent(v.POSTGRES_USER);
const password = encodeURIComponent(secrets.POSTGRES_PASSWORD ?? "");
const local = `postgresql://${user}:${password}@${v.POSTGRES_HOST}:${v.POSTGRES_PORT}/${v.POSTGRES_DB}?sslmode=${v.POSTGRES_SSLMODE || "require"}`;

const child = spawn("npx", ["wrangler", "dev", "--port", "8787", "--local", "--ip", "127.0.0.1"], {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: {
		...process.env,
		CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: local,
	},
});

child.on("exit", (code) => process.exit(code ?? 1));
