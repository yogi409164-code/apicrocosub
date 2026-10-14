import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/croco/source.ts"), "utf8");
const local = source.match(/export const DATABASE_URL =\s*"([^"]+)"/)?.[1];
if (!local) throw new Error("DATABASE_URL is missing from src/croco/source.ts");

const stateDir = path.join(root, ".wrangler");
fs.mkdirSync(stateDir, { recursive: true });
const localConfig = path.join(stateDir, "dev.jsonc");
const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
fs.writeFileSync(
	localConfig,
	JSON.stringify(
		{
			...config,
			hyperdrive: [{ binding: "HYPERDRIVE", id: "00000000000000000000000000000001", localConnectionString: local }],
		},
		null,
		2,
	),
);

const child = spawn("npx", ["wrangler", "dev", "--config", localConfig, "--port", "8787", "--local", "--ip", "127.0.0.1"], {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: {
		...process.env,
		CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: local,
	},
});

child.on("exit", (code) => process.exit(code ?? 1));
