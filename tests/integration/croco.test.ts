import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const base = "http://local.test";

async function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	if (init.token) headers.Authorization = `Bearer ${init.token}`;
	const response = await SELF.fetch(`${base}${path}`, {
		method: init.method ?? "GET",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(identifier: string, password: string): Promise<string> {
	const { status, body } = await call("/auth/login", { method: "POST", body: { identifier, password } });
	expect(status).toBe(200);
	return body.access_token;
}

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("Crocosip API", () => {
	it("answers health and service info", async () => {
		expect((await call("/health")).body).toMatchObject({ status: "ok", schema: "crocosub" });
		expect((await call("/")).body).toMatchObject({ docs: "/docs", api: "/api" });
		expect((await call("/api/health")).status).toBe(200);
	});

	it("lists the salad menu at /juices and /api/juices", async () => {
		const direct = await call("/juices");
		expect(direct.status).toBe(200);
		expect(direct.body.length).toBeGreaterThanOrEqual(12);
		expect(direct.body.some((row: { image_url: string }) => row.image_url.startsWith("/uploads/juices/salad-"))).toBe(true);
		const prefixed = await call("/api/juices");
		expect(prefixed.body.length).toBe(direct.body.length);
		expect((await call("/plans")).body.length).toBeGreaterThan(0);
		expect((await call("/store")).status).toBe(200);
		expect((await call("/juices/categories")).body.names.length).toBeGreaterThan(0);
	});

	it("serves the OpenAPI document with the ported routes", async () => {
		const { status, body } = await call("/openapi.json");
		expect(status).toBe(200);
		expect(body.paths["/admin/plan-requests/{requestId}/accept"]).toBeDefined();
		expect(body.paths["/api/create-order"]).toBeDefined();
	});

	it("returns FastAPI style errors", async () => {
		const bad = await call("/auth/login", { method: "POST", body: { identifier: "demo", password: "wrong" } });
		expect(bad.status).toBe(401);
		expect(bad.body.detail).toBe("Invalid username, email, or password.");
		const missing = await call("/auth/login", { method: "POST", body: {} });
		expect(missing.status).toBe(422);
		expect(missing.body.detail[0].loc).toEqual(["body", "identifier"]);
		expect((await call("/auth/me")).status).toBe(401);
	});

	it("runs the customer and admin flows", async () => {
		const demo = await login("demo", "Demo12345");
		const me = await call("/auth/me", { token: demo });
		expect(me.body.username).toBe("demo");

		const store = (await call("/store")).body;
		const located = await call("/auth/me/location", {
			method: "PATCH",
			token: demo,
			body: { latitude: store.latitude, longitude: store.longitude, address: "Road 1, near the store", locality: "Store area" },
		});
		expect(located.status).toBe(200);

		const juices = (await call("/juices")).body;
		const order = await call("/orders", {
			method: "POST",
			token: demo,
			body: { items: [{ id: juices[0].id, name: juices[0].name, qty: 1, price: juices[0].price }], delivery_type: "slot" },
		});
		expect(order.status).toBe(201);
		expect(order.body.payment_method).toBe("COD");
		expect((await call("/orders/me", { token: demo })).body.length).toBe(1);

		const plan = (await call("/plans")).body[0];
		const request = await call("/plans/requests", {
			method: "POST",
			token: demo,
			body: { plan_id: plan.id, plan_name: plan.name, days: 7, items: [{ id: juices[0].id, name: juices[0].name, qty: 1 }] },
		});
		expect(request.status).toBe(201);
		expect(request.body.status).toBe("pending");

		const admin = await login("admin", "1234");
		const pending = await call("/admin/plan-requests?status_filter=pending", { token: admin });
		expect(pending.body.some((row: { id: string }) => row.id === request.body.id)).toBe(true);
		const accepted = await call(`/admin/plan-requests/${request.body.id}/accept`, { method: "POST", token: admin, body: {} });
		expect(accepted.status).toBe(200);
		expect(accepted.body.status).toBe("accepted");
		const again = await call(`/admin/plan-requests/${request.body.id}/accept`, { method: "POST", token: admin, body: {} });
		expect(again.status).toBe(409);

		const ticket = await call("/support/tickets", {
			method: "POST",
			token: demo,
			body: { kind: "order", order_id: order.body.id, message: "My juice was late." },
		});
		expect(ticket.status).toBe(201);
		expect(ticket.body.status).toBe("pending");
		const adminTickets = await call("/admin/support-tickets", { token: admin });
		expect(adminTickets.body.some((row: { id: string }) => row.id === ticket.body.id)).toBe(true);

		const stats = await call("/admin/stats", { token: admin });
		expect(stats.status).toBe(200);
		expect((await call("/admin/users", { token: demo })).status).toBe(403);
	});

	it("stores uploads in D1 and serves them back", async () => {
		const admin = await login("admin", "1234");
		const uploaded = await call("/admin/juices/upload", { method: "POST", token: admin, body: { data_url: PNG } });
		expect(uploaded.status).toBe(200);
		expect(uploaded.body.url).toMatch(/^\/uploads\/juices\/.+\.png$/);
		const file = await SELF.fetch(`${base}${uploaded.body.url}`);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("image/png");
		expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});
});
