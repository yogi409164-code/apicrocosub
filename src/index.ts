import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { crocoRoutes, registerCroco } from "./croco/app";
import { Source, type EngineBindings } from "./croco/source";

const app = new Hono<{ Bindings: EngineBindings }>();

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
			body: route.body
				? {
						content: {
							"application/json": {
								schema: route.bodyFields.length
									? z.object(Object.fromEntries(route.bodyFields.map((name) => [name, z.string()])))
									: z.object({}).passthrough(),
							},
						},
					}
				: undefined,
		},
		responses: { 200: { description: "OK" } },
	});
}

const OPEN_PATHS = new Set(["/", "/health", "/docs", "/openapi.json", "/openapi.yaml", "/redocs"]);

function needsDatabase(pathname: string): boolean {
	return !OPEN_PATHS.has(pathname);
}

export default {
	async fetch(request, env, ctx) {
		try {
			if (!needsDatabase(new URL(request.url).pathname)) {
				return await app.fetch(request, env, ctx);
			}
			const source = Source.open(env);
			return await app.fetch(request, { ...env, DB: source.db as unknown as D1Database }, ctx);
		} catch (error) {
			console.error("Worker fetch failed:", error);
			const detail = error instanceof Error ? error.message.split("\n")[0] : "Worker threw an exception";
			return Response.json({ detail }, { status: 503, headers: { "access-control-allow-origin": "*" } });
		}
	},
} satisfies ExportedHandler<EngineBindings>;
