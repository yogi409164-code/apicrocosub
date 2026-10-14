import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = "dbaas-db-1025064-do-user-46253107-0.e.db.ondigitalocean.com";
const port = 25060;
const out = path.join(root, "certs", "digitalocean-ca.pem");

function toPem(der) {
	const body = Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
	return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

await new Promise((resolve, reject) => {
	const socket = net.connect({ host, port }, () => {
		const request = Buffer.alloc(8);
		request.writeInt32BE(8, 0);
		request.writeInt32BE(80877103, 4);
		socket.write(request);
	});
	socket.once("error", reject);
	socket.once("data", (chunk) => {
		if (chunk.toString("utf8") !== "S") {
			reject(new Error("PostgreSQL did not accept SSL"));
			return;
		}
		const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
			const pems = [];
			let cert = secure.getPeerCertificate(true);
			const seen = new Set();
			while (cert?.raw && !seen.has(cert.fingerprint256)) {
				seen.add(cert.fingerprint256);
				pems.push(toPem(cert.raw));
				const next = cert.issuerCertificate;
				cert = next && next !== cert ? next : null;
			}
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, pems.slice(1).join("\n") || pems.join("\n"));
			console.log(`Wrote CA chain to certs/digitalocean-ca.pem (${pems.length} certs, using ${Math.max(pems.length - 1, 1)})`);
			secure.end();
			resolve();
		});
		secure.once("error", reject);
	});
});
