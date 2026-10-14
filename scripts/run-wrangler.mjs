import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const portable = path.join(root, ".tools", "node22", "node.exe");
const node = fs.existsSync(portable) ? portable : process.execPath;
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const args = process.argv.slice(2);
const child = spawn(node, [wrangler, ...args], {
	cwd: root,
	stdio: "inherit",
	env: {
		...process.env,
		PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
	},
});
child.on("exit", (code) => process.exit(code ?? 1));
