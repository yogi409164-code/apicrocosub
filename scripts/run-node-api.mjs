import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const portable = path.join(root, ".tools", "node22", "node.exe");
const node = fs.existsSync(portable) ? portable : process.execPath;
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(node, [tsx, "src/node.ts", ...process.argv.slice(2)], {
	cwd: root,
	stdio: "inherit",
	env: {
		...process.env,
		PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
	},
});
child.on("exit", (code) => process.exit(code ?? 1));
