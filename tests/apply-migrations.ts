import { env } from "cloudflare:test";
import { Source } from "../src/croco/source";

const source = Source.open(env);
try {
	await source.db.setup();
} finally {
	await source.close();
}
