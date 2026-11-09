import { env } from "cloudflare:test";
import { setupD1 } from "../src/croco/pg";

await setupD1(env.DB);
