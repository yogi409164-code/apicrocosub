import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { crocoRoutes, registerCroco } from "./croco/app";
import { PgDatabase } from "./croco/pg";

type Bindings = Env & { HYPERDRIVE?: Hyperdrive; DB_SCHEMA?: string };

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// Payment routes already live under /api. Every other /api/* path maps back
// onto the normal route, so /api/juices and /juices both work.
app.use("/api/*", async (c, next) => {
	const path = c.req.path;
	if (path.startsWith("/api/create-order") || path.startsWith("/api/verify-payment")) return next();
	const url = new URL(c.req.url);
	url.pathname = path.slice(4) || "/";
	return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
});

app.onError((err, c) => {
	console.error("Global error handler caught:", err);
	return c.json({ detail: "Internal Server Error" }, 500);
});

app.notFound((c) => c.json({ detail: "Not Found" }, 404));

const openapi = fromHono(app, {
	docs_url: "/docs",
	schema: {
		info: {
			title: "Crocosip API",
			version: "1.0.0",
			description: "CrocoSip subscription API.",
		},
	},
});

registerCroco(app);

openapi.registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });

for (const route of crocoRoutes) {
	const params = [...route.path.matchAll(/:(\w+)/g)].map((match) => match[1]);
	openapi.registry.registerPath({
		method: route.method,
		path: route.path.replace(/:(\w+)/g, "{$1}"),
		tags: [route.tag],
		summary: route.summary,
		security: route.auth ? [{ bearerAuth: [] }] : undefined,
		request: {
			params: params.length ? z.object(Object.fromEntries(params.map((name) => [name, z.string()]))) : undefined,
			query: route.query.length ? z.object(Object.fromEntries(route.query.map((name) => [name, z.string().optional()]))) : undefined,
			body: route.body ? { content: { "application/json": { schema: z.object({}).passthrough() } } } : undefined,
		},
		responses: { 200: { description: "OK" } },
	});
}

// With a Hyperdrive binding the API reads and writes the shared PostgreSQL database
// (the same one FastAPI uses). Without it, the D1 database stays in use.
export default {
	async fetch(request, env, ctx) {
		if (!env.HYPERDRIVE) return app.fetch(request, env, ctx);
		const db = new PgDatabase(env.HYPERDRIVE.connectionString, env.DB_SCHEMA?.trim() || "Crocosip_mobile_app");
		try {
			return await app.fetch(request, { ...env, DB: db as unknown as D1Database }, ctx);
		} finally {
			ctx.waitUntil(db.close());
		}
	},
} satisfies ExportedHandler<Bindings>;
