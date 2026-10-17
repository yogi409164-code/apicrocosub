import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DB_SCHEMA, PgDatabase } from "./pg";

type App = Hono<{ Bindings: Env }>;
type Ctx = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;
type Body = Record<string, unknown>;
type Method = "get" | "post" | "put" | "patch" | "delete";

export type CrocoRoute = {
	method: Method;
	path: string;
	tag: string;
	summary: string;
	auth: boolean;
	query: string[];
	body: boolean;
	bodyFields: string[];
};

export const crocoRoutes: CrocoRoute[] = [];

const ADMIN_PAGES = [
	"dashboard",
	"juices",
	"plans",
	"requests",
	"orders",
	"payments",
	"tickets",
	"delivery",
	"slots",
	"data",
	"maps",
	"settings",
];
const SYSTEM_ROLES = ["admin", "customer"];
const ROLE_NAME = /^[a-z][a-z0-9_]{1,31}$/;
const DELIVERY_WINDOW = "6:00 AM – 10:00 AM";
const ORDER_STATUSES = ["placed", "confirmed", "delivered", "cancelled"];
const MARK_STATUSES = ["pending", "picked", "delivered", "not_delivered"];
const TICKET_KINDS = ["order", "subscription", "other"];
const UPGRADE_MODES = ["", "after_end", "from_flow"];
const MAX_SAVED_ADDRESSES = 10;
const SPECIAL_ACCESS_METERS = 100;
const OTP_MINUTES = 5;
const RESEND_SECONDS = 30;
// Same scheme as the FastAPI service (pbkdf2_sha256$salt$digest), so both accept each other's users.
const PBKDF2_ROUNDS = 120_000;
const IST_OFFSET_MS = 330 * 60_000;
const STORE_ID = "default";
const WELCOME_BONUS = 50;
const BONUS_SOURCE = "bonus";
const BONUS_NOTE = "₹50 welcome bonus";
const DEFAULT_LAT = 12.9716;
const DEFAULT_LNG = 77.5946;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
// D1 caps a single value at 2 MB, so uploads are stored as base64 slices.
const UPLOAD_CHUNK = 1_400_000;
const IMAGE_TYPES: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
};
const DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,(.+)$/is;
const NOMINATIM = "https://nominatim.openstreetmap.org";
const DEFAULT_GOOGLE_IDS = [
	"1028343714410-l4nab6f0io43tr73svdnd3i67lp5fk8g.apps.googleusercontent.com",
	"1028343714410-g6fg3lop4r0kte460sgnu3lq8h7gd1r1.apps.googleusercontent.com",
	"1028343714410-bravnjrjce1u6pt8jlrom7320qgdtqgd.apps.googleusercontent.com",
];

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly detail: unknown,
	) {
		super(typeof detail === "string" ? detail : "Request failed.");
	}
}

class RazorpayAuthError extends Error {}
class RazorpayRequestError extends Error {}

function invalid(field: string, msg: string, input: unknown = null): never {
	throw new HttpError(422, [{ type: "value_error", loc: ["body", field], msg, input }]);
}

function setting(env: Env, key: string, fallback = ""): string {
	const value = (env as unknown as Record<string, unknown>)[key];
	return (typeof value === "string" ? value : fallback).trim();
}

function secretKey(env: Env): string {
	return setting(env, "SECRET_KEY") || "dev-only-change-me";
}

// ---- time ----

let lastStamp = 0;

function nowIso(): string {
	let stamp = Date.now();
	if (stamp <= lastStamp) stamp = lastStamp + 1;
	lastStamp = stamp;
	return new Date(stamp).toISOString();
}

function istDate(ms = Date.now()): string {
	return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function todayIso(): string {
	return istDate();
}

function toMs(value: unknown): number {
	if (typeof value !== "string" || !value) return Number.NaN;
	const text = value.includes("T") ? value : value.replace(" ", "T");
	return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
}

function addDays(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function parseDate(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	const day = value.slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
	const date = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
	return day;
}

// ---- values ----

function bool(value: unknown): boolean {
	if (value === true || value === 1) return true;
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return bool(value.toString("utf8"));
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return normalized === "1" || normalized === "t" || normalized === "true" || normalized === "yes" || normalized === "on";
	}
	return false;
}

function sqlBool(value: boolean): "TRUE" | "FALSE" {
	return value ? "TRUE" : "FALSE";
}

function num(value: unknown, fallback = 0): number {
	if (value === null || value === undefined || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function numOrNull(value: unknown): number | null {
	return value === null || value === undefined ? null : num(value);
}

function text(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

function blank(value: string | null): string | null {
	if (value === null) return null;
	const stripped = value.trim();
	return stripped || null;
}

function jsonList(raw: unknown): Row[] {
	if (typeof raw !== "string" || !raw) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Row[]) : [];
	} catch {
		return [];
	}
}

function jsonValue<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== "string" || !raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function int(value: unknown, fallback: number): number {
	const parsed = Math.trunc(num(value, fallback));
	return Number.isFinite(parsed) ? parsed : fallback;
}

// ---- request body ----

async function bodyOf(c: Ctx): Promise<Body> {
	const value = await c.req.json().catch(() => null);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: value }]);
	}
	return value as Body;
}

function lengthCheck(field: string, value: string, min: number, max: number): string {
	if (value.length < min) invalid(field, `String should have at least ${min} character${min === 1 ? "" : "s"}`, value);
	if (value.length > max) invalid(field, `String should have at most ${max} characters`, value);
	return value;
}

function reqStr(body: Body, field: string, min = 0, max = Number.POSITIVE_INFINITY): string {
	const value = body[field];
	if (value === undefined || value === null) invalid(field, "Field required");
	if (typeof value !== "string") invalid(field, "Input should be a valid string", value);
	return lengthCheck(field, value, min, max);
}

function optStr(body: Body, field: string, max = Number.POSITIVE_INFINITY, fallback: string | null = null, min = 0): string | null {
	const value = body[field];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "string") invalid(field, "Input should be a valid string", value);
	return lengthCheck(field, value, min, max);
}

function numberValue(field: string, value: unknown, integer: boolean): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) invalid(field, integer ? "Input should be a valid integer" : "Input should be a valid number", value);
	if (integer && !Number.isInteger(parsed)) invalid(field, "Input should be a valid integer", value);
	return parsed;
}

function rangeCheck(field: string, value: number, ge?: number, le?: number): number {
	if (ge !== undefined && value < ge) invalid(field, `Input should be greater than or equal to ${ge}`, value);
	if (le !== undefined && value > le) invalid(field, `Input should be less than or equal to ${le}`, value);
	return value;
}

function reqNum(body: Body, field: string, opts: { ge?: number; le?: number; integer?: boolean } = {}): number {
	const value = body[field];
	if (value === undefined || value === null) invalid(field, "Field required");
	return rangeCheck(field, numberValue(field, value, !!opts.integer), opts.ge, opts.le);
}

function optNum(body: Body, field: string, opts: { ge?: number; le?: number; integer?: boolean; fallback?: number | null } = {}): number | null {
	const value = body[field];
	if (value === undefined || value === null) return opts.fallback ?? null;
	return rangeCheck(field, numberValue(field, value, !!opts.integer), opts.ge, opts.le);
}

function optBool(body: Body, field: string): boolean | null {
	const value = body[field];
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	invalid(field, "Input should be a valid boolean", value);
}

function literal(body: Body, field: string, allowed: string[], fallback?: string): string {
	const value = body[field];
	if ((value === undefined || value === null) && fallback !== undefined) return fallback;
	if (value === undefined || value === null) invalid(field, "Field required");
	if (typeof value !== "string" || !allowed.includes(value)) {
		const options = allowed.map((item) => `'${item}'`);
		const last = options.pop();
		invalid(field, `Input should be ${options.length ? `${options.join(", ")} or ${last}` : last}`, value);
	}
	return value;
}

function listField(body: Body, field: string, fallback?: unknown[]): unknown[] {
	const value = body[field];
	if ((value === undefined || value === null) && fallback !== undefined) return fallback;
	if (value === undefined || value === null) invalid(field, "Field required");
	if (!Array.isArray(value)) invalid(field, "Input should be a valid list", value);
	return value;
}

function queryNum(c: Ctx, field: string): number {
	const raw = c.req.query(field);
	if (raw === undefined) throw new HttpError(422, [{ type: "missing", loc: ["query", field], msg: "Field required", input: null }]);
	const parsed = Number(raw);
	if (!raw.trim() || !Number.isFinite(parsed)) {
		throw new HttpError(422, [{ type: "float_parsing", loc: ["query", field], msg: "Input should be a valid number, unable to parse string as a number", input: raw }]);
	}
	return parsed;
}

// ---- database ----

function postgresOf(db: D1Database): PgDatabase | null {
	const value = db as unknown;
	return value instanceof PgDatabase ? value : null;
}

function bindAll(statement: D1PreparedStatement, binds: unknown[]): D1PreparedStatement {
	return binds.length ? statement.bind(...binds.map((value) => (value === undefined ? null : value))) : statement;
}

function prep(db: D1Database, sql: string, ...binds: unknown[]): D1PreparedStatement {
	return bindAll(db.prepare(sql), binds);
}

async function one(db: D1Database, sql: string, ...binds: unknown[]): Promise<Row | null> {
	return prep(db, sql, ...binds).first<Row>();
}

async function many(db: D1Database, sql: string, ...binds: unknown[]): Promise<Row[]> {
	const result = await prep(db, sql, ...binds).all<Row>();
	return result.results ?? [];
}

async function run(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
	await prep(db, sql, ...binds).run();
}

function uuid(): string {
	return crypto.randomUUID();
}

function uuidHex(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

// ---- crypto ----

function bytesToHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: string, rounds: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: rounds, hash: "SHA-256" }, key, 256);
	return bytesToHex(bits);
}

async function hashPassword(password: string): Promise<string> {
	const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
	return `pbkdf2_sha256$${salt}$${await pbkdf2(password, salt, PBKDF2_ROUNDS)}`;
}

async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	if (!stored) return false;
	const parts = stored.split("$");
	if (parts[0] !== "pbkdf2_sha256") return false;
	if (parts.length === 3) return safeEqual(await pbkdf2(password, parts[1], PBKDF2_ROUNDS), parts[2]);
	// Older Worker hashes carry their round count: pbkdf2_sha256$rounds$salt$digest.
	if (parts.length !== 4) return false;
	const rounds = Number(parts[1]);
	if (!Number.isInteger(rounds) || rounds < 1 || rounds > PBKDF2_ROUNDS) return false;
	return safeEqual(await pbkdf2(password, parts[2], rounds), parts[3]);
}

function safeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return diff === 0;
}

function b64url(bytes: Uint8Array): string {
	let binary = "";
	bytes.forEach((byte) => {
		binary += String.fromCharCode(byte);
	});
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(value: string): Uint8Array {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function hmacHex(secret: string, value: string): Promise<string> {
	return bytesToHex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(value)));
}

async function createAccessToken(env: Env, subject: string): Promise<string> {
	const minutes = int(setting(env, "ACCESS_TOKEN_EXPIRE_MINUTES"), 60 * 24 * 7) || 60 * 24 * 7;
	const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
	const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: subject, exp: Math.floor(Date.now() / 1000) + minutes * 60 })}`;
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secretKey(env), "sign"), new TextEncoder().encode(data)));
	return `${data}.${b64url(signature)}`;
}

async function decodeAccessToken(env: Env, token: string): Promise<string | null> {
	const [header, payload, signature] = token.split(".");
	if (!header || !payload || !signature) return null;
	try {
		const ok = await crypto.subtle.verify("HMAC", await hmacKey(secretKey(env), "verify"), fromB64url(signature), new TextEncoder().encode(`${header}.${payload}`));
		if (!ok) return null;
		const head = JSON.parse(new TextDecoder().decode(fromB64url(header))) as { alg?: string };
		if (head.alg !== "HS256") return null;
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { sub?: unknown; exp?: unknown };
		if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) return null;
		return typeof claims.sub === "string" ? claims.sub : null;
	} catch {
		return null;
	}
}

// ---- seed ----

let seeded: Promise<void> | null = null;

function ensureSeed(db: D1Database): Promise<void> {
	if (!seeded) {
		seeded = seedAll(db).catch((error) => {
			seeded = null;
			throw error;
		});
	}
	return seeded;
}

async function seedAll(db: D1Database): Promise<void> {
	const pg = postgresOf(db);
	if (pg) await pg.setup();
	await seedRoles(db);
	if (!(await findUser(db, "demo"))) {
		await run(db, "INSERT OR IGNORE INTO users (id, username, email, name, password_hash, provider, role, special_access, created_at) VALUES ('demo-user', 'demo', 'demo@crocosip.app', 'Demo', ?, 'password', 'customer', FALSE, ?)", await hashPassword("Demo12345"), nowIso());
	}
	if (!(await findUser(db, "admin"))) {
		await run(db, "INSERT OR IGNORE INTO users (id, username, email, name, password_hash, provider, role, special_access, created_at) VALUES ('admin-user', 'admin', 'admin@crocosip.app', 'Admin', ?, 'password', 'admin', FALSE, ?)", await hashPassword("1234"), nowIso());
	}
	await syncCategories(db);
	await storeRow(db);
	await grantWelcomeBonusAll(db);
}

// ---- roles and users ----

function readPages(raw: unknown): string[] {
	const value = jsonValue<unknown>(typeof raw === "string" ? raw : "[]", []);
	if (!Array.isArray(value)) return [];
	const seen: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && ADMIN_PAGES.includes(item) && !seen.includes(item)) seen.push(item);
	}
	return seen;
}

function rolePages(row: Row | null, name: string): string[] {
	if (name === "admin") return [...ADMIN_PAGES];
	return row ? readPages(row.pages) : [];
}

async function seedRoles(db: D1Database): Promise<void> {
	await db.batch([
		prep(db, "INSERT OR IGNORE INTO roles (name, description, pages, created_at) VALUES ('admin', 'Full admin access to the store.', ?, ?)", JSON.stringify(ADMIN_PAGES), nowIso()),
		prep(db, "INSERT OR IGNORE INTO roles (name, description, pages, created_at) VALUES ('customer', 'Customer account for plans and orders.', '[]', ?)", nowIso()),
		prep(db, "UPDATE roles SET pages = ? WHERE name = 'admin'", JSON.stringify(ADMIN_PAGES)),
	]);
}

async function pagesFor(db: D1Database, user: Row): Promise<string[]> {
	const name = String(user.role ?? "customer").trim().toLowerCase() || "customer";
	if (name === "admin" || user.username === "admin") return [...ADMIN_PAGES];
	return rolePages(await one(db, "SELECT * FROM roles WHERE name = ?", name), name);
}

async function countUsers(db: D1Database, role: string): Promise<number> {
	return num((await one(db, "SELECT COUNT(*) AS total FROM users WHERE role = ?", role))?.total);
}

async function roleOut(db: D1Database, row: Row) {
	const name = String(row.name);
	return {
		name,
		description: String(row.description ?? ""),
		user_count: await countUsers(db, name),
		system: SYSTEM_ROLES.includes(name),
		pages: rolePages(row, name),
	};
}

function addressOut(row: Row) {
	return {
		id: String(row.id),
		label: String(row.label ?? ""),
		latitude: num(row.latitude),
		longitude: num(row.longitude),
		address: String(row.address ?? ""),
		locality: text(row.locality),
	};
}

async function savedAddresses(db: D1Database, userId: unknown): Promise<Row[]> {
	return many(db, "SELECT * FROM saved_addresses WHERE user_id = ? ORDER BY created_at DESC", userId);
}

async function userOut(db: D1Database, user: Row) {
	return {
		id: String(user.id),
		name: String(user.name ?? ""),
		email: text(user.email),
		username: text(user.username),
		phone: text(user.phone),
		photo: text(user.photo),
		provider: user.provider === "google" ? "google" : "password",
		role: String(user.role || "customer"),
		pages: await pagesFor(db, user),
		location_lat: numOrNull(user.location_lat),
		location_lng: numOrNull(user.location_lng),
		location_address: text(user.location_address),
		location_locality: text(user.location_locality),
		special_access: bool(user.special_access),
		special_lat: numOrNull(user.special_lat),
		special_lng: numOrNull(user.special_lng),
		saved_addresses: (await savedAddresses(db, user.id)).map(addressOut),
		wallet_balance: Math.round(num(user.wallet_balance) * 100) / 100,
	};
}

function moneyOf(value: unknown) {
	return Math.round(num(value) * 100) / 100;
}

function walletEntryOut(row: Row, user: Row | null = null) {
	return {
		id: String(row.id),
		user_id: String(row.user_id),
		user_name: user ? String(user.name ?? "") : null,
		user_phone: user ? text(user.phone) : null,
		user_email: user ? text(user.email) : null,
		amount: moneyOf(row.amount),
		kind: String(row.kind || "credit"),
		source: String(row.source || "admin"),
		note: text(row.note),
		order_id: text(row.order_id),
		balance: user ? moneyOf(user.wallet_balance) : null,
		created_at: text(row.created_at),
	};
}

async function findWalletUser(db: D1Database, identifier: string): Promise<Row | null> {
	const value = identifier.trim();
	if (!value) return null;
	const digits = value.replace(/\D/g, "");
	return one(
		db,
		"SELECT * FROM users WHERE email = ? OR username = ? OR id = ? OR phone = ? OR phone = ? LIMIT 1",
		value,
		value,
		value,
		value,
		digits.length >= 10 ? digits.slice(-10) : value,
	);
}

async function grantWelcomeBonus(db: D1Database, user: Row): Promise<Row> {
	const existing = await one(db, "SELECT id FROM wallet_entries WHERE user_id = ? AND source = ? LIMIT 1", user.id, BONUS_SOURCE);
	if (existing) return user;
	const rupees = moneyOf(WELCOME_BONUS);
	const next = moneyOf(num(user.wallet_balance) + rupees);
	await run(db, "UPDATE users SET wallet_balance = ? WHERE id = ?", next, user.id);
	await run(
		db,
		"INSERT INTO wallet_entries (id, user_id, amount, kind, source, note, order_id, created_by, created_at) VALUES (?, ?, ?, 'credit', ?, ?, NULL, NULL, ?)",
		uuid(),
		user.id,
		rupees,
		BONUS_SOURCE,
		BONUS_NOTE,
		nowIso(),
	);
	return (await userById(db, String(user.id))) ?? user;
}

async function grantWelcomeBonusAll(db: D1Database) {
	const users = await many(db, "SELECT * FROM users");
	for (const user of users) await grantWelcomeBonus(db, user);
}

async function creditWallet(db: D1Database, identifier: string, amount: number, note: string | null, createdBy: string | null) {
	const rupees = moneyOf(amount);
	if (rupees <= 0) throw new HttpError(400, "Enter an amount greater than zero.");
	const user = await findWalletUser(db, identifier);
	if (!user) throw new HttpError(400, "No customer matches that phone, email, or ID.");
	const next = moneyOf(num(user.wallet_balance) + rupees);
	await run(db, "UPDATE users SET wallet_balance = ? WHERE id = ?", next, user.id);
	const id = uuid();
	await run(
		db,
		"INSERT INTO wallet_entries (id, user_id, amount, kind, source, note, order_id, created_by, created_at) VALUES (?, ?, ?, 'credit', 'admin', ?, NULL, ?, ?)",
		id,
		user.id,
		rupees,
		note,
		createdBy,
		nowIso(),
	);
	const updated = (await userById(db, user.id)) ?? user;
	const row = (await one(db, "SELECT * FROM wallet_entries WHERE id = ?", id))!;
	return walletEntryOut(row, updated);
}

function rupeesFromPrice(price: string) {
	const n = Number(String(price).replace(/[^\d.]/g, ""));
	return moneyOf(Number.isFinite(n) ? n : 0);
}

async function debitWallet(
	db: D1Database,
	user: Row,
	amount: number,
	note: string | null,
	orderId: string | null,
	source = "order",
) {
	const rupees = moneyOf(amount);
	const current = moneyOf(user.wallet_balance);
	if (current + 1e-9 < rupees) throw new HttpError(400, "Not enough wallet money.");
	const next = moneyOf(current - rupees);
	await run(db, "UPDATE users SET wallet_balance = ? WHERE id = ?", next, user.id);
	await run(
		db,
		"INSERT INTO wallet_entries (id, user_id, amount, kind, source, note, order_id, created_by, created_at) VALUES (?, ?, ?, 'debit', ?, ?, ?, NULL, ?)",
		uuid(),
		user.id,
		-rupees,
		source.slice(0, 24) || "order",
		note,
		orderId,
		nowIso(),
	);
}

async function adminUserOut(db: D1Database, user: Row) {
	return { ...(await userOut(db, user)), role: String(user.role || "customer"), created_at: text(user.created_at) };
}

async function findUser(db: D1Database, identifier: string): Promise<Row | null> {
	const value = identifier.trim();
	return one(db, "SELECT * FROM users WHERE email = ? OR username = ? OR id = ? OR phone = ? LIMIT 1", value, value, value, value);
}

async function userById(db: D1Database, id: unknown): Promise<Row | null> {
	return one(db, "SELECT * FROM users WHERE id = ?", id);
}

async function reloadUser(db: D1Database, user: Row): Promise<Row> {
	return (await userById(db, user.id)) ?? user;
}

function personName(user: Row | null): string {
	if (!user) return "";
	return String(user.name || user.username || user.email || "").trim();
}

function normalizePhone(value: string): string {
	const raw = value.trim();
	const digits = raw.replace(/\D/g, "");
	if (digits.length < 10 || digits.length > 13) throw new HttpError(400, "Enter a valid phone number (10 digits).");
	return raw.startsWith("+") ? `+${digits}` : digits;
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const radius = 6371000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
	return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function specialAccessFields(user: Row, enabled: boolean): { special_access: number; special_lat: number | null; special_lng: number | null } {
	if (!enabled) return { special_access: 0, special_lat: null, special_lng: null };
	if (user.location_lat == null || user.location_lng == null) throw new HttpError(400, "Save this user's location first, then grant special access.");
	return { special_access: 1, special_lat: num(user.location_lat), special_lng: num(user.location_lng) };
}

async function currentUser(c: Ctx): Promise<Row> {
	const header = c.req.header("authorization");
	if (!header || !header.toLowerCase().startsWith("bearer ")) throw new HttpError(401, "Sign in required.");
	const userId = await decodeAccessToken(c.env, header.split(" ").slice(1).join(" "));
	if (!userId) throw new HttpError(401, "Session expired. Sign in again.");
	const user = await findUser(c.env.DB, userId);
	if (!user) throw new HttpError(401, "Account not found.");
	return grantWelcomeBonus(c.env.DB, user);
}

async function currentAdmin(c: Ctx): Promise<Row> {
	const user = await currentUser(c);
	if (!(await pagesFor(c.env.DB, user)).length) throw new HttpError(403, "Admin access required.");
	return user;
}

async function authResponse(c: Ctx, user: Row) {
	const credited = await grantWelcomeBonus(c.env.DB, user);
	return { access_token: await createAccessToken(c.env, String(credited.id)), token_type: "bearer", user: await userOut(c.env.DB, credited) };
}

// ---- catalog ----

function mlFromName(name: string): number | null {
	const match = /(\d+)\s*ml/i.exec(name);
	return match ? Number(match[1]) : null;
}

function juiceOut(row: Row, flags?: { in_poster?: boolean; in_plans?: boolean; archived?: boolean }) {
	return {
		id: String(row.id),
		name: String(row.name ?? ""),
		category: String(row.category ?? "Juices"),
		sku: text(row.sku),
		price: num(row.price),
		description: text(row.description),
		image_url: text(row.image_url),
		archived: flags?.archived ?? bool(row.archived),
		in_poster: flags?.in_poster ?? bool(row.in_poster ?? row.inPoster),
		in_plans: flags?.in_plans ?? (row.in_plans == null && row.inPlans == null ? true : bool(row.in_plans ?? row.inPlans)),
		offer_percent: num(row.offer_percent),
		ml: row.ml == null ? mlFromName(String(row.name ?? "")) : num(row.ml),
		created_at: text(row.created_at),
	};
}

async function listJuices(db: D1Database, archived: boolean | null): Promise<Row[]> {
	const rows = archived === null ? await many(db, "SELECT * FROM juices ORDER BY created_at DESC") : await many(db, "SELECT * FROM juices WHERE archived = ? ORDER BY created_at DESC", archived ? 1 : 0);
	for (const row of rows) {
		const url = String(row.image_url ?? "");
		if (!url.startsWith("data:")) continue;
		try {
			const stored = await normalizeStoredImage(db, url);
			if (stored && stored !== url) {
				await run(db, "UPDATE juices SET image_url = ? WHERE id = ?", stored, row.id);
				row.image_url = stored;
			}
		} catch {
			// Leave the inline image when it cannot be stored.
		}
	}
	return rows;
}

async function juiceById(db: D1Database, id: string): Promise<Row> {
	const row = await one(db, "SELECT * FROM juices WHERE id = ?", id);
	if (!row) throw new HttpError(404, "Juice not found.");
	return row;
}

async function applyCategoryOrder(db: D1Database, names: string[]): Promise<string[]> {
	await syncCategories(db);
	const rows = await many(db, "SELECT * FROM juice_categories");
	const known = new Map(rows.map((row) => [String(row.name), num(row.position)]));
	const cleaned = names.map((name) => name.trim()).filter(Boolean);
	const ordered = cleaned.filter((name, index) => known.has(name) && cleaned.indexOf(name) === index);
	const leftover = [...known.keys()].filter((name) => !ordered.includes(name)).sort((a, b) => known.get(a)! - known.get(b)! || a.localeCompare(b));
	const final = [...ordered, ...leftover];
	if (final.length) await db.batch(final.map((name, index) => prep(db, "UPDATE juice_categories SET position = ? WHERE name = ?", index, name)));
	return final;
}

function menuJuice(raw: unknown, index: number): {
	id: string;
	name: string;
	category: string;
	sku: string | null;
	price: number;
	description: string | null;
	image_url: string | null;
	archived: boolean;
	in_poster: boolean;
	in_plans: boolean;
	offer_percent: number;
	created_at: string | null;
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`juices.${index}`, "Input should be a valid object", raw);
	const row = raw as Body;
	const name = String(row.name ?? "").trim() || "Untitled juice";
	const offer = Number(row.offer_percent ?? 0);
	return {
		id: String(row.id ?? "").trim(),
		name,
		category: String(row.category ?? "Juices").trim() || "Juices",
		sku: String(row.sku ?? "").trim() || null,
		price: Number(row.price ?? 0) || 0,
		description: String(row.description ?? "").trim() || null,
		image_url: typeof row.image_url === "string" ? row.image_url : null,
		archived: Boolean(row.archived),
		in_poster: bool(row.in_poster),
		in_plans: row.in_plans == null ? true : bool(row.in_plans),
		offer_percent: Number.isFinite(offer) ? Math.min(Math.max(offer, 0), 90) : 0,
		created_at: typeof row.created_at === "string" ? row.created_at : null,
	};
}

async function syncCategories(db: D1Database): Promise<void> {
	const existing = new Set((await many(db, "SELECT name FROM juice_categories")).map((row) => String(row.name)));
	const names = [...new Set((await many(db, "SELECT category FROM juices")).map((row) => String(row.category ?? "Juices").trim() || "Juices"))].sort();
	let position = num((await one(db, "SELECT MAX(position) AS top FROM juice_categories"))?.top, -1);
	for (const name of names) {
		if (existing.has(name)) continue;
		position += 1;
		await run(db, "INSERT OR IGNORE INTO juice_categories (name, position) VALUES (?, ?)", name, position);
	}
}

async function ensureCategory(db: D1Database, name: string): Promise<void> {
	const cleaned = name.trim() || "Juices";
	await run(db, "INSERT OR IGNORE INTO juice_categories (name, position) VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM juice_categories))", cleaned);
}

async function categoryNames(db: D1Database): Promise<string[]> {
	await syncCategories(db);
	return (await many(db, "SELECT name FROM juice_categories ORDER BY position ASC, name ASC")).map((row) => String(row.name));
}

function planItemId(item: unknown): string {
	if (item && typeof item === "object" && !Array.isArray(item) && "id" in item) {
		return String((item as { id?: unknown }).id ?? "").trim();
	}
	return typeof item === "string" || typeof item === "number" ? String(item).trim() : "";
}

function planItemQty(item: unknown): number {
	if (item && typeof item === "object" && !Array.isArray(item) && "qty" in item) {
		const qty = Number((item as { qty?: unknown }).qty);
		if (Number.isFinite(qty)) return Math.max(1, Math.min(99, Math.round(qty)));
	}
	return 1;
}

function parsePlanRows(raw: unknown): { id: string; qty: number }[] {
	let parsed: unknown = raw;
	if (typeof raw === "string" && raw.trim()) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return raw.split(",").map((item) => item.trim()).filter(Boolean).map((id) => ({ id, qty: 1 }));
		}
	}
	if (!Array.isArray(parsed)) return [];
	const rows: { id: string; qty: number }[] = [];
	for (const item of parsed) {
		const id = planItemId(item);
		if (id) rows.push({ id, qty: planItemQty(item) });
	}
	return rows;
}

function parsePlanItems(raw: unknown): string[] {
	return parsePlanRows(raw).map((item) => item.id);
}

function parsePlanQtys(raw: unknown): Record<string, number> {
	return Object.fromEntries(parsePlanRows(raw).map((item) => [item.id, item.qty]));
}

function encodePlanItems(ids: string[], qtys: Record<string, number>): string {
	return JSON.stringify(
		ids.map((id) => {
			const qty = Number(qtys[id]);
			return { id, qty: Number.isFinite(qty) ? Math.max(1, Math.min(99, Math.round(qty))) : 1 };
		}),
	);
}

function planOut(row: Row) {
	return {
		id: String(row.id),
		name: String(row.name ?? ""),
		duration: String(row.duration ?? ""),
		unit: String(row.unit ?? "days"),
		price: String(row.price ?? ""),
		period: String(row.period ?? ""),
		description: String(row.description ?? ""),
		color: String(row.color ?? "#FF7A00"),
		image: String(row.image ?? ""),
		bottles: String(row.bottles ?? ""),
		popular: bool(row.popular),
		position: num(row.position),
		items: parsePlanItems(row.items),
		item_qtys: parsePlanQtys(row.items),
	};
}

async function listPlans(db: D1Database): Promise<Row[]> {
	return many(db, "SELECT * FROM plans ORDER BY position ASC, name ASC");
}

const SLOT_LEAD_HOURS = 5;
const SLOT_KINDS = ["instant", "today", "next_day", "pre", "holiday", "book"] as const;
const SLOT_META: Record<string, { label: string; offset: number; window: string }> = {
	instant: { label: "Instant", offset: 0, window: "Instant" },
	today: { label: "Today", offset: 0, window: DELIVERY_WINDOW },
	next_day: { label: "Next day", offset: 1, window: DELIVERY_WINDOW },
	pre: { label: "Pre-order", offset: 2, window: DELIVERY_WINDOW },
	holiday: { label: "Next day holiday", offset: 1, window: "Holiday" },
	book: { label: "Next day book", offset: 1, window: DELIVERY_WINDOW },
};

function defaultDeliverySlots(showInstant = true, showSlot = true): Row[] {
	return [
		{ id: "instant", kind: "instant", label: SLOT_META.instant.label, offset_days: 0, window: SLOT_META.instant.window, visible: showInstant },
		{ id: "today", kind: "today", label: SLOT_META.today.label, offset_days: 0, window: SLOT_META.today.window, visible: showSlot },
		{ id: "next_day", kind: "next_day", label: SLOT_META.next_day.label, offset_days: 1, window: SLOT_META.next_day.window, visible: showSlot },
	];
}

function normalizeDeliverySlots(raw: unknown, showInstant = true, showSlot = true): Row[] {
	const rows = typeof raw === "string" ? jsonList(raw) : Array.isArray(raw) ? (raw as Row[]) : [];
	const seen = new Set<string>();
	const slots: Row[] = [];
	for (const item of rows) {
		if (!item || typeof item !== "object") continue;
		const kind = String(item.kind || "");
		if (!SLOT_KINDS.includes(kind as (typeof SLOT_KINDS)[number])) continue;
		const meta = SLOT_META[kind];
		const id = String(item.id || "").trim().slice(0, 64) || `${kind}_${slots.length}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const offsetRaw = Math.trunc(num(item.offset_days, meta.offset));
		const offset = kind === "instant" || kind === "today" ? 0 : Math.max(0, Math.min(14, Number.isFinite(offsetRaw) ? offsetRaw : meta.offset));
		slots.push({
			id,
			kind,
			label: String(item.label || meta.label).trim().slice(0, 80) || meta.label,
			offset_days: offset,
			window: String(item.window || meta.window).trim().slice(0, 80) || meta.window,
			visible: item.visible !== false,
		});
	}
	return slots.length ? slots : defaultDeliverySlots(showInstant, showSlot);
}

function slotsForStore(row: Row): Row[] {
	const showInstant = row.show_delivery_instant == null ? true : bool(row.show_delivery_instant);
	const showSlot = row.show_delivery_slot == null ? true : bool(row.show_delivery_slot);
	const slots = normalizeDeliverySlots(row.delivery_slots, showInstant, showSlot);
	if (slots.some((item) => item.kind === "today" || (num(item.offset_days) === 0 && item.kind !== "instant"))) return slots;
	const today = defaultDeliverySlots(showInstant, showSlot).find((item) => item.kind === "today");
	if (!today) return slots;
	const instantAt = slots.findIndex((item) => item.kind === "instant");
	slots.splice(instantAt >= 0 ? instantAt + 1 : 0, 0, today);
	return slots;
}

function parseClock(part: string): { hour: number; minute: number } | null {
	const match = part.trim().toUpperCase().replace(/\s+/g, " ").match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
	if (!match) return null;
	let hour = Number(match[1]);
	const minute = Number(match[2] || 0);
	const period = match[3];
	if (period === "AM") hour = hour === 12 ? 0 : hour;
	else if (period === "PM") hour = hour === 12 ? 12 : hour + 12;
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

function parseSlotWindow(window: string) {
	const raw = String(window || "").trim();
	if (!raw || raw.toLowerCase() === "instant" || raw.toLowerCase() === "holiday") return { startHour: 6, startMinute: 0, endHour: 10, endMinute: 0 };
	const parts = raw.split(/\s*[–—-]\s*/);
	const start = parseClock(parts[0] || "");
	const end = parseClock(parts[1] || parts[0] || "");
	if (!start || !end) return { startHour: 6, startMinute: 0, endHour: 10, endMinute: 0 };
	return { startHour: start.hour, startMinute: start.minute, endHour: end.hour, endMinute: end.minute };
}

function slotBounds(slot: Row): { start: number; end: number } {
	const day = addDays(todayIso(), Math.trunc(num(slot.offset_days)));
	const [year, month, date] = day.split("-").map(Number);
	const window = parseSlotWindow(String(slot.window || ""));
	let start = Date.UTC(year, (month || 1) - 1, date || 1, window.startHour, window.startMinute) - IST_OFFSET_MS;
	let end = Date.UTC(year, (month || 1) - 1, date || 1, window.endHour, window.endMinute) - IST_OFFSET_MS;
	if (end <= start) end += 24 * 60 * 60 * 1000;
	return { start, end };
}

function slotIsLive(slot: Row, at = Date.now()): boolean {
	if (slot.visible === false) return false;
	const { start, end } = slotBounds(slot);
	return at >= start - SLOT_LEAD_HOURS * 60 * 60 * 1000 && at < end;
}

function liveCartSlots(slots: Row[], at = Date.now()): Row[] {
	const live = slots.filter((item) => slotIsLive(item, at));
	if (live.length) return live;
	const upcoming = slots
		.filter((item) => item.visible !== false && slotBounds(item).end > at)
		.sort((left, right) => slotBounds(left).start - slotBounds(right).start);
	if (!upcoming.length) return [];
	const firstStart = slotBounds(upcoming[0]).start;
	return upcoming.filter((item) => slotBounds(item).start === firstStart);
}

function resolveDeliverySlot(store: Row, deliveryType: string): Row {
	const slots = slotsForStore(store);
	const wanted = String(deliveryType || "slot").trim();
	let match = slots.find((item) => String(item.id) === wanted);
	if (!match && wanted === "slot") {
		match = slots.find((item) => slotIsLive(item) && ["today", "next_day", "pre", "book"].includes(String(item.kind)));
	}
	if (!match && wanted === "instant") {
		match = slots.find((item) => String(item.kind) === "instant");
	}
	if (!match) throw new HttpError(400, "Choose a delivery slot.");
	if (match.visible === false) throw new HttpError(400, `${match.label} is not available.`);
	if (String(match.kind) === "holiday") throw new HttpError(400, `${match.label} is a holiday. Pick another day.`);
	if (!liveCartSlots(slots).some((item) => String(item.id) === String(match.id))) {
		throw new HttpError(400, `${match.label} opens ${SLOT_LEAD_HOURS} hours before the window.`);
	}
	return match;
}

function storeOut(row: Row) {
	const slots = slotsForStore(row);
	return {
		id: String(row.id),
		name: String(row.name ?? "CrocoSip Store"),
		address: String(row.address ?? ""),
		locality: String(row.locality ?? ""),
		latitude: num(row.latitude),
		longitude: num(row.longitude),
		distance_km: num(row.distance_km) || 10,
		custom_discount_percent: row.custom_discount_percent == null ? 20 : num(row.custom_discount_percent),
		cart_min_order: row.cart_min_order == null ? 0 : num(row.cart_min_order),
		show_delivery_instant: slots.some((item) => item.visible !== false && item.kind === "instant"),
		show_delivery_slot: slots.some((item) => item.visible !== false && ["today", "next_day", "pre", "book"].includes(String(item.kind))),
		delivery_slots: slots,
	};
}

async function storeRow(db: D1Database): Promise<Row> {
	let row = await one(db, "SELECT * FROM store_settings WHERE id = ?", STORE_ID);
	if (!row) {
		await run(db, "INSERT OR IGNORE INTO store_settings (id, name, address, locality, latitude, longitude, distance_km, custom_discount_percent, cart_min_order) VALUES (?, 'CrocoSip Store', '', '', ?, ?, 10, 20, 0)", STORE_ID, DEFAULT_LAT, DEFAULT_LNG);
		row = (await one(db, "SELECT * FROM store_settings WHERE id = ?", STORE_ID))!;
	}
	return row;
}

// ---- uploads ----

async function saveImage(db: D1Database, base64: string, mime: string): Promise<string> {
	let data = base64.replace(/[^A-Za-z0-9+/]/g, "");
	const size = Math.floor((data.length * 3) / 4);
	if (size > MAX_IMAGE_BYTES) throw new HttpError(400, "Image is too large. Use a file under 100 MB.");
	if (mime === "image/jpg") mime = "image/jpeg";
	if (!(mime in IMAGE_TYPES)) throw new HttpError(400, "Upload a JPG, PNG, WEBP, or GIF image.");
	if (data.length % 4 === 1) data = data.slice(0, -1);
	data += "=".repeat((4 - (data.length % 4)) % 4);
	const path = `/uploads/juices/${uuidHex()}${IMAGE_TYPES[mime]}`;
	const chunks: string[] = [];
	for (let start = 0; start < data.length; start += UPLOAD_CHUNK) chunks.push(data.slice(start, start + UPLOAD_CHUNK));
	await db.batch([
		prep(db, "INSERT INTO uploads (path, mime, size, chunks, created_at) VALUES (?, ?, ?, ?, ?)", path, mime, size, chunks.length, nowIso()),
		...chunks.map((chunk, index) => prep(db, "INSERT INTO upload_chunks (path, idx, data) VALUES (?, ?, ?)", path, index, chunk)),
	]);
	return path;
}

async function normalizeStoredImage(db: D1Database, value: unknown): Promise<string | null> {
	if (value === null || value === undefined) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/uploads/")) return trimmed;
	const match = DATA_URL_RE.exec(trimmed.replaceAll("\n", "").replaceAll(" ", ""));
	if (!match) throw new HttpError(400, "Image must be a URL or a JPG, PNG, WEBP, or GIF upload.");
	return saveImage(db, match[2], match[1].toLowerCase());
}

async function serveUpload(c: Ctx): Promise<Response> {
	const path = decodeURIComponent(c.req.path);
	const meta = await one(c.env.DB, "SELECT * FROM uploads WHERE path = ?", path);
	if (!meta) return c.json({ detail: "Not Found" }, 404);
	const chunks = await many(c.env.DB, "SELECT data FROM upload_chunks WHERE path = ? ORDER BY idx ASC", path);
	const parts = chunks.map((row) => Uint8Array.from(atob(String(row.data)), (char) => char.charCodeAt(0)));
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return new Response(bytes, { headers: { "Content-Type": String(meta.mime), "Cache-Control": "public, max-age=31536000, immutable" } });
}

// ---- plan requests ----

function parseSkipped(raw: unknown): string[] {
	const value = jsonValue<unknown>(typeof raw === "string" ? raw : "", []);
	if (!Array.isArray(value)) return [];
	const dates = value.map((item) => parseDate(item == null ? null : String(item))).filter((item): item is string => !!item);
	return [...new Set(dates)].sort();
}

function skippedSet(row: Row): Set<string> {
	return new Set(parseSkipped(row.skipped_dates));
}

function placedEnd(start: string, planned: number, skipped: Set<string>): string {
	let remaining = Math.max(1, planned);
	let cursor = start;
	let last = start;
	const limit = planned + skipped.size + 400;
	for (let guard = 0; remaining > 0 && guard < limit; guard += 1) {
		if (!skipped.has(cursor)) {
			last = cursor;
			remaining -= 1;
		}
		cursor = addDays(cursor, 1);
	}
	return last;
}

function planDays(row: Row): number {
	const counts: number[] = [];
	if (row.days != null && num(row.days) > 0) counts.push(Math.trunc(num(row.days)));
	const itemDays = jsonList(row.items).reduce((sum, item) => sum + Math.trunc(num(item.days)), 0);
	if (itemDays > 0) counts.push(itemDays);
	const digits = String(row.period ?? "").replace(/\D/g, "");
	if (digits) counts.push(Math.max(1, Number(digits)));
	return counts.length ? Math.max(...counts) : 30;
}

function planWindow(row: Row): [string, string] {
	let start: string;
	if (row.starts_on) {
		start = parseDate(row.starts_on) ?? addDays(todayIso(), 1);
	} else {
		const decided = toMs(row.decided_at);
		start = addDays(Number.isNaN(decided) ? todayIso() : istDate(decided), 1);
	}
	const skipped = skippedSet(row);
	const natural = placedEnd(start, planDays(row), skipped);
	const stored = parseDate(row.ends_on);
	let end = natural;
	if (row.status === "cancelled_admin" && stored) end = stored;
	else if (stored && stored >= natural) end = stored;
	if (end < start) end = start;
	return [start, end];
}

function deliversOn(row: Row, target: string): boolean {
	const [start, end] = planWindow(row);
	if (target < start || target > end) return false;
	const skipped = skippedSet(row);
	if (skipped.has(target)) return false;
	let remaining = planDays(row);
	let cursor = start;
	while (remaining > 0 && cursor <= end) {
		if (!skipped.has(cursor)) {
			if (cursor === target) return true;
			remaining -= 1;
		}
		cursor = addDays(cursor, 1);
	}
	return false;
}

function parseSwaps(raw: unknown): Record<string, unknown> {
	const value = jsonValue<unknown>(typeof raw === "string" ? raw : "", {});
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (!item || typeof item !== "object") continue;
		const swap = item as Row;
		const id = String(swap.id ?? "").trim();
		const name = String(swap.name ?? "").trim();
		if (!id || !name) continue;
		out[key] = { id: id.slice(0, 64), name: name.slice(0, 160), qty: Math.max(1, Math.min(int(swap.qty, 1) || 1, 20)), image: swap.image ?? null };
	}
	return out;
}

function slotOrder(row: Row, planned: number): number[] {
	const identity = Array.from({ length: Math.max(1, planned) }, (_, index) => index);
	const value = jsonValue<unknown>(typeof row.slot_order === "string" ? row.slot_order : "", null);
	if (!Array.isArray(value)) return identity;
	const order: number[] = [];
	for (const item of value) {
		const parsed = Number(item);
		if (!Number.isInteger(parsed)) return identity;
		order.push(parsed);
	}
	const sorted = [...order].sort((a, b) => a - b);
	if (order.length !== identity.length || sorted.some((value, index) => value !== identity[index])) return identity;
	return order;
}

function slotIndexOn(row: Row, target: string): number | null {
	const start = parseDate(row.starts_on) ?? planWindow(row)[0];
	const skipped = skippedSet(row);
	const planned = planDays(row);
	let cursor = start;
	let guard = 0;
	for (let index = 0; index < planned; index += 1) {
		while (skipped.has(cursor) && guard < planned + skipped.size + 400) {
			cursor = addDays(cursor, 1);
			guard += 1;
		}
		if (cursor === target) return index;
		cursor = addDays(cursor, 1);
		guard += 1;
	}
	return null;
}

function requestItems(raw: unknown) {
	return jsonList(raw).map((item) => ({
		id: String(item.id ?? ""),
		name: String(item.name ?? ""),
		qty: int(item.qty, 1) || 1,
		days: int(item.days, 0),
		image: item.image == null ? null : String(item.image),
	}));
}

function requestOut(row: Row) {
	const [start, end] = planWindow(row);
	return {
		id: String(row.id),
		user_id: String(row.user_id),
		plan_id: String(row.plan_id),
		plan_name: String(row.plan_name ?? ""),
		price: String(row.price ?? ""),
		period: String(row.period ?? ""),
		bottles: String(row.bottles ?? ""),
		details: String(row.details ?? ""),
		days: row.days == null ? null : Math.trunc(num(row.days)),
		items: requestItems(row.items),
		upgrade_mode: String(row.upgrade_mode ?? ""),
		starts_on: start,
		ends_on: end,
		skipped_dates: parseSkipped(row.skipped_dates),
		item_swaps: parseSwaps(row.item_swaps),
		slot_order: slotOrder(row, planDays(row)),
		status: String(row.status ?? "pending"),
		created_at: text(row.created_at),
		decided_at: text(row.decided_at),
		delivery_lat: numOrNull(row.delivery_lat),
		delivery_lng: numOrNull(row.delivery_lng),
		delivery_address: text(row.delivery_address),
		delivery_locality: text(row.delivery_locality),
	};
}

function adminRequestOut(row: Row, user: Row | null) {
	return {
		...requestOut(row),
		user_name: user ? String(user.name ?? "") : "Unknown user",
		user_email: user ? text(user.email) : null,
		user_username: user ? text(user.username) : null,
		user_phone: user ? text(user.phone) : null,
		user_locality: text(row.delivery_locality) || (user ? text(user.location_locality) : null),
		user_address: text(row.delivery_address) || (user ? text(user.location_address) : null),
		user_lat: row.delivery_lat != null ? num(row.delivery_lat) : user ? numOrNull(user.location_lat) : null,
		user_lng: row.delivery_lng != null ? num(row.delivery_lng) : user ? numOrNull(user.location_lng) : null,
	};
}

async function latestRequest(db: D1Database, userId: unknown, status: string): Promise<Row | null> {
	return one(db, "SELECT * FROM plan_requests WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1", userId, status);
}

async function activatePaidRequest(db: D1Database, row: Row): Promise<void> {
	const current = await latestRequest(db, row.user_id, "accepted");
	const mode = String(row.upgrade_mode || "");
	const tomorrow = addDays(todayIso(), 1);
	let start = parseDate(row.starts_on) ?? tomorrow;
	if (current) {
		const [currentStart, currentEnd] = planWindow(current);
		if (mode === "after_end") start = parseDate(row.starts_on) ?? addDays(currentEnd, 1);
		else if (mode === "from_flow" && start < currentStart) start = currentStart;
	}
	await run(
		db,
		"UPDATE plan_requests SET starts_on = ?, ends_on = ?, status = 'accepted', decided_at = ? WHERE id = ?",
		start,
		addDays(start, planDays(row) - 1),
		nowIso(),
		row.id,
	);
}

async function acceptedRows(db: D1Database, userId: unknown): Promise<Row[]> {
	return many(db, "SELECT * FROM plan_requests WHERE user_id = ? AND status = 'accepted' ORDER BY created_at ASC", userId);
}

async function myRequests(db: D1Database, userId: unknown) {
	const pending = await latestRequest(db, userId, "pending");
	const accepted = await acceptedRows(db, userId);
	const today = todayIso();
	const covering = accepted.filter((row) => {
		const [start, end] = planWindow(row);
		return start <= today && today <= end;
	});
	const future = accepted.filter((row) => planWindow(row)[0] > today).sort((a, b) => planWindow(a)[0].localeCompare(planWindow(b)[0]));
	const past = accepted.filter((row) => planWindow(row)[1] < today).sort((a, b) => planWindow(a)[1].localeCompare(planWindow(b)[1]));
	const active = covering.at(-1) ?? future[0] ?? past.at(-1) ?? null;
	let upcoming = future.find((row) => !active || row.id !== active.id) ?? null;
	if (!upcoming && covering.length > 1 && active) upcoming = covering.find((row) => row.id !== active.id) ?? null;
	return {
		active: active ? requestOut(active) : null,
		upcoming: upcoming ? requestOut(upcoming) : null,
		plans: accepted.map(requestOut),
		pending: pending ? requestOut(pending) : null,
	};
}

function guardSkipDate(value: string, undo: boolean): string {
	const target = parseDate(value);
	if (!target) throw new HttpError(400, "Pick a valid date.");
	const today = todayIso();
	if (target < today) throw new HttpError(400, `Past dates cannot be ${undo ? "unskipped" : "skipped"}.`);
	if (target === today) throw new HttpError(400, "Today's delivery cannot be skipped.");
	return target;
}

function guardSwapDate(value: string): string {
	const target = parseDate(value);
	if (!target) throw new HttpError(400, "Pick a valid date.");
	if (target <= todayIso()) throw new HttpError(400, "Only future dates can be swapped.");
	if (Date.parse(`${target}T06:00:00+05:30`) - Date.now() < 6 * 3600_000) throw new HttpError(400, "Swap is closed within 6 hours of that delivery.");
	return target;
}

async function writeSkipped(db: D1Database, row: Row, skipped: Set<string>): Promise<void> {
	const start = parseDate(row.starts_on) ?? planWindow(row)[0];
	await run(db, "UPDATE plan_requests SET skipped_dates = ?, ends_on = ? WHERE id = ?", JSON.stringify([...skipped].sort()), placedEnd(start, planDays(row), skipped), row.id);
}

async function requestCounts(db: D1Database) {
	const rows = await many(db, "SELECT * FROM plan_requests");
	const today = todayIso();
	const accepted = rows.filter((row) => row.status === "accepted");
	return {
		pending_requests: rows.filter((row) => row.status === "pending").length,
		accepted_plans: accepted.length,
		active_plans: accepted.filter((row) => {
			const [start, end] = planWindow(row);
			return start <= today && today <= end;
		}).length,
		rejected_requests: rows.filter((row) => row.status === "rejected").length,
	};
}

// ---- orders ----

function orderItems(raw: unknown) {
	const items = typeof raw === "string" ? jsonList(raw) : Array.isArray(raw) ? (raw.filter((item) => item && typeof item === "object") as Row[]) : [];
	return items
		.filter((row) => row.id && row.name)
		.map((row) => ({
			id: String(row.id),
			name: String(row.name).slice(0, 160),
			size_label: String(row.size_label || row.sizeLabel || ""),
			price: Math.max(0, num(row.price)),
			qty: Math.max(1, int(row.qty, 1) || 1),
			image: row.image ? String(row.image) : null,
		}));
}

function validOrderItems(body: Body, field: string, required: boolean): Row[] {
	const items = listField(body, field, required ? undefined : []);
	if (required && !items.length) invalid(field, "List should have at least 1 item after validation, not 0", items);
	return items.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`${field}.${index}`, "Input should be a valid dictionary or object to extract fields from", raw);
		const item = raw as Body;
		return {
			id: reqStr(item, "id", 1, 64),
			name: reqStr(item, "name", 1, 160),
			size_label: optStr(item, "size_label", 40, ""),
			price: reqNum(item, "price", { ge: 0 }),
			qty: reqNum(item, "qty", { ge: 1, le: 99, integer: true }),
			image: optStr(item, "image"),
		};
	});
}

function orderOut(row: Row) {
	return {
		id: String(row.id),
		user_id: String(row.user_id),
		items: orderItems(row.items),
		subtotal: num(row.subtotal),
		delivery_fee: num(row.delivery_fee),
		total: num(row.total),
		payment_method: String(row.payment_method || "COD"),
		status: String(row.status || "placed"),
		delivery_lat: numOrNull(row.delivery_lat),
		delivery_lng: numOrNull(row.delivery_lng),
		delivery_address: text(row.delivery_address),
		delivery_locality: text(row.delivery_locality),
		delivery_date: text(row.delivery_date),
		delivery_window: String(row.delivery_window || DELIVERY_WINDOW),
		delivery_type: String(row.delivery_type || "slot"),
		proof_image: text(row.proof_image),
		rating: numOrNull(row.rating),
		payment_id: text(row.payment_id),
		payment_status: String(row.payment_status || (String(row.payment_method || "").toUpperCase() === "UPI" ? "paid" : "cod")),
		created_at: text(row.created_at),
	};
}

function refundStatusFromRefund(refundStatus: string, payment?: Row | null) {
	const state = String(refundStatus || "").toLowerCase();
	if (state === "failed") return "refund_failed";
	if (state === "created" || state === "pending") return "refund_pending";
	if (String(payment?.refund_status || "").toLowerCase() === "partial") return "partial_refund";
	return "refunded";
}

function refundStatusFromPayment(payment: Row | null | undefined) {
	if (!payment) return null;
	const payState = String(payment.status || "").toLowerCase();
	const flag = String(payment.refund_status || "").toLowerCase();
	const amountRefunded = Math.trunc(num(payment.amount_refunded));
	if (payState === "refunded" || flag === "full") return "refunded";
	if (flag === "partial" || amountRefunded > 0) return "partial_refund";
	return null;
}

async function markOrdersRefundStatus(db: D1Database, paymentId: string, status: string) {
	const id = paymentId.trim();
	const next = status.trim();
	if (!id || !next) return;
	await run(db, "UPDATE juice_orders SET payment_status = ? WHERE payment_id = ?", next, id);
}

async function syncOrderRefunds(env: Env, rows: Row[]) {
	const ids = new Set(rows.map((row) => text(row.payment_id)).filter((id): id is string => Boolean(id?.startsWith("pay_"))));
	if (!ids.size) return rows;
	try {
		const result = await razorpay(env, "/payments?count=100");
		if (!result.ok) return rows;
		const byId = new Map((Array.isArray(result.data.items) ? (result.data.items as Row[]) : []).map((item) => [String(item.id ?? ""), item]));
		for (const row of rows) {
			const paymentId = text(row.payment_id);
			if (!paymentId) continue;
			const next = refundStatusFromPayment(byId.get(paymentId));
			if (next && next !== String(row.payment_status || "")) {
				row.payment_status = next;
				await markOrdersRefundStatus(env.DB, paymentId, next);
			}
		}
	} catch {
		// Keep the order list if Razorpay is unavailable.
	}
	return rows;
}

function adminOrderOut(row: Row, user: Row | null) {
		return {
		...orderOut(row),
		user_name: user ? String(user.name ?? "") : "Customer",
		user_email: user ? text(user.email) : null,
		user_username: user ? text(user.username) : null,
		user_phone: user ? text(user.phone) : null,
	};
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
	return distanceMeters(lat1, lng1, lat2, lng2) / 1000;
}

async function prepareOrder(db: D1Database, user: Row, items: Row[], deliveryType: string) {
	const cleaned = orderItems(items);
	if (!cleaned.length) throw new HttpError(400, "Add items before placing an order.");
	if (user.location_lat == null || user.location_lng == null) throw new HttpError(400, "Add your delivery location before placing an order.");
	if (!String(user.location_address || user.location_locality || "").trim()) throw new HttpError(400, "Add your delivery location before placing an order.");
	const store = await storeRow(db);
	if (distanceKm(num(store.latitude), num(store.longitude), num(user.location_lat), num(user.location_lng)) > (num(store.distance_km) || 10)) {
		throw new HttpError(400, "Choose an address inside the delivery range.");
	}
	const subtotal = Math.round(cleaned.reduce((sum, item) => sum + item.price * item.qty, 0) * 100) / 100;
	const minimum = num(store.cart_min_order);
	if (subtotal < minimum) throw new HttpError(400, `Minimum order is ₹${minimum}.`);
	const slot = resolveDeliverySlot(store, deliveryType);
	const kind = String(slot.kind) === "instant" ? "instant" : String(slot.kind);
	return {
		cleaned,
		subtotal,
		kind,
		slotDate: addDays(todayIso(), Math.trunc(num(slot.offset_days))),
		slotWindow: kind === "instant" ? "Instant" : String(slot.window || DELIVERY_WINDOW),
	};
}

const COD_UNLOCK_ORDERS = 3;

async function completedOrderCount(db: D1Database, userId: string): Promise<number> {
	const rows = await many(db, "SELECT status FROM juice_orders WHERE user_id = ?", userId);
	return rows.filter((row) => String(row.status) !== "cancelled").length;
}

async function createOrder(db: D1Database, user: Row, items: Row[], deliveryType: string, paymentMethod: string, paymentId?: string | null): Promise<Row> {
	const method = String(paymentMethod || "COD").toUpperCase();
	if (method === "COD") {
		const done = await completedOrderCount(db, String(user.id));
		if (done < COD_UNLOCK_ORDERS) {
			const left = COD_UNLOCK_ORDERS - done;
			throw new HttpError(400, `Pay with UPI for your first ${COD_UNLOCK_ORDERS} orders. COD unlocks after that (${left} more).`);
		}
	}
	const prepared = await prepareOrder(db, user, items, deliveryType);
	if (method === "WALLET" && moneyOf(user.wallet_balance) + 1e-9 < prepared.subtotal) {
		throw new HttpError(400, "Not enough wallet money.");
	}
	const id = uuid();
	await run(
		db,
		`INSERT INTO juice_orders (id, user_id, items, subtotal, delivery_fee, total, payment_method, status, delivery_lat, delivery_lng, delivery_address, delivery_locality, delivery_date, delivery_window, delivery_type, payment_id, payment_status, created_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		user.id,
		JSON.stringify(prepared.cleaned),
		prepared.subtotal,
		prepared.subtotal,
		method,
		user.location_lat,
		user.location_lng,
		user.location_address,
		user.location_locality,
		prepared.slotDate,
		prepared.slotWindow,
		prepared.kind,
		paymentId ? String(paymentId) : method === "WALLET" ? `wallet_${id}` : null,
		method === "UPI" || method === "WALLET" ? "paid" : "cod",
		nowIso(),
	);
	if (method === "WALLET") {
		try {
			await debitWallet(db, user, prepared.subtotal, `Order ${id}`, id);
		} catch (error) {
			await run(db, "DELETE FROM juice_orders WHERE id = ?", id);
			throw error;
		}
	}
	return (await one(db, "SELECT * FROM juice_orders WHERE id = ?", id))!;
}

// ---- support ----

function ticketOut(row: Row, user: Row | null) {
	return {
		id: String(row.id),
		user_id: String(row.user_id),
		user_name: user ? String(user.name ?? "") : "",
		kind: String(row.kind),
		order_id: text(row.order_id),
		plan_request_id: text(row.plan_request_id),
		subject: String(row.subject ?? ""),
		message: String(row.message ?? ""),
		reason: String(row.reason || ""),
		status: String(row.status),
		started: bool(row.started),
		rating: numOrNull(row.rating),
		closed_at: text(row.closed_at),
		assignee_id: text(row.assignee_id),
		assignee_name: String(row.assignee_name || ""),
		created_at: text(row.created_at),
	};
}

function messageOut(row: Row) {
	const sender = ["customer", "support", "system"].includes(String(row.sender)) ? String(row.sender) : "customer";
	return {
		id: String(row.id),
		ticket_id: String(row.ticket_id),
		sender,
		sender_name: String(row.sender_name || ""),
		body: String(row.body ?? ""),
		created_at: text(row.created_at),
	};
}

async function ticketDetail(db: D1Database, ticket: Row, user: Row | null) {
	const existing = await one(db, "SELECT id FROM support_messages WHERE ticket_id = ? LIMIT 1", ticket.id);
	const opening = String(ticket.message ?? "").trim();
	if (!existing && opening) {
		await run(db, "INSERT INTO support_messages (id, ticket_id, sender, sender_name, body, created_at) VALUES (?, ?, 'customer', '', ?, ?)", uuidHex(), ticket.id, opening, text(ticket.created_at) ?? nowIso());
	}
	const messages = await many(db, "SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC, id ASC", ticket.id);
	return { ...ticketOut(ticket, user), messages: messages.map(messageOut) };
}

async function getTicket(db: D1Database, ticketId: string): Promise<Row> {
	const row = await one(db, "SELECT * FROM support_tickets WHERE id = ?", ticketId);
	if (!row) throw new HttpError(404, "That chat was not found.");
	return row;
}

async function getOwnedTicket(db: D1Database, ticketId: string, userId: unknown): Promise<Row> {
	const row = await getTicket(db, ticketId);
	if (row.user_id !== userId) throw new HttpError(404, "That chat was not found.");
	return row;
}

function systemMessage(db: D1Database, ticketId: unknown, body: string): D1PreparedStatement {
	return prep(db, "INSERT INTO support_messages (id, ticket_id, sender, sender_name, body, created_at) VALUES (?, ?, 'system', 'CrocoSip', ?, ?)", uuidHex(), ticketId, body, nowIso());
}

async function addMessage(db: D1Database, ticket: Row, sender: "customer" | "support", body: string, senderUser: Row): Promise<Row> {
	if (!bool(ticket.started)) throw new HttpError(400, "This chat has not started yet.");
	if (ticket.status !== "open") throw new HttpError(400, "This chat is closed.");
	const message = body.trim();
	if (!message) throw new HttpError(400, "Write a message.");
	const name = personName(senderUser) || (sender === "support" ? "Support" : "Customer");
	if (sender === "support" && !ticket.assignee_id) {
		await run(db, "UPDATE support_tickets SET assignee_id = ?, assignee_name = ? WHERE id = ?", senderUser.id, name, ticket.id);
	}
	const id = uuidHex();
	await run(db, "INSERT INTO support_messages (id, ticket_id, sender, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, ticket.id, sender, name, message.slice(0, 1000), nowIso());
	return (await one(db, "SELECT * FROM support_messages WHERE id = ?", id))!;
}

async function closeTicket(db: D1Database, ticket: Row): Promise<Row> {
	if (ticket.status !== "closed") {
		await db.batch([prep(db, "UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE id = ?", nowIso(), ticket.id), systemMessage(db, ticket.id, "This chat has ended")]);
	}
	return (await one(db, "SELECT * FROM support_tickets WHERE id = ?", ticket.id))!;
}

function notFoundOr400(error: unknown): never {
	if (error instanceof HttpError && typeof error.detail === "string") {
		throw new HttpError(error.detail.includes("not found") ? 404 : 400, error.detail);
	}
	throw error;
}

// ---- outside services ----

function indiaMobile(number: string): string {
	return `91${number.replace(/\D/g, "").slice(-10)}`;
}

function smsDetail(payload: unknown, raw: string): string {
	if (payload && typeof payload === "object") {
		for (const key of ["message", "msg", "error", "description"] as const) {
			const value = (payload as Row)[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return raw.trim();
}

function smsOk(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const status = String((payload as Row).status ?? (payload as Row).type ?? "").trim().toLowerCase();
	return status === "success" || status === "ok" || status === "1";
}

async function sendSms(env: Env, number: string, message: string): Promise<void> {
	const key = setting(env, "APITXT_API_KEY") || setting(env, "APITXT_KEY");
	if (!key) throw new HttpError(400, "SMS is not configured.");
	const otp = message.match(/\b(\d{6})\b/)?.[1];
	if (!otp) throw new HttpError(400, "Could not send the verification code.");
	let response: Response;
	try {
		response = await fetch("https://www.apitxt.com/api/sendOTP", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				authkey: key,
				mobile: indiaMobile(number),
				otp,
				channel: "sms",
			}),
		});
	} catch {
		throw new HttpError(400, "Could not send the verification code.");
	}
	const raw = await response.text();
	let payload: unknown = null;
	try {
		payload = JSON.parse(raw);
	} catch {
		payload = null;
	}
	if (!response.ok || !smsOk(payload)) {
		throw new HttpError(400, smsDetail(payload, raw) || "Could not send the verification code.");
	}
}

function otpDigits(phone: string): string {
	const digits = normalizePhone(phone).replace(/\D/g, "");
	if (digits.length < 10) throw new HttpError(400, "Enter a valid phone number (10 digits).");
	return digits.slice(-10);
}

async function phoneTaken(db: D1Database, phone: string, ignoreUserId = ""): Promise<boolean> {
	const rows = await many(db, "SELECT id, phone FROM users WHERE phone IS NOT NULL");
	return rows.some((row) => String(row.id) !== ignoreUserId && String(row.phone ?? "").replace(/\D/g, "").endsWith(phone));
}

async function storeAndSendOtp(c: Ctx, number: string): Promise<void> {
	const db = c.env.DB;
	const now = Date.now();
	const row = await one(db, "SELECT * FROM phone_otps WHERE phone = ?", number);
	if (row && row.sent_at && now - toMs(row.sent_at) < RESEND_SECONDS * 1000) throw new HttpError(400, "Wait a few seconds before requesting another code.");
	const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
	await run(
		db,
		"INSERT INTO phone_otps (phone, code_hash, expires_at, sent_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at, attempts = 0",
		number,
		await hmacHex(secretKey(c.env), `${number}:${code}`),
		new Date(now + OTP_MINUTES * 60_000).toISOString(),
		new Date(now).toISOString(),
	);
	try {
		await sendSms(c.env, number, `Your CrocoSip verification code is ${code}. It is valid for ${OTP_MINUTES} minutes.`);
	} catch (error) {
		await run(db, "DELETE FROM phone_otps WHERE phone = ?", number);
		throw error;
	}
}

async function verifyPhoneOtp(c: Ctx, phone: string, otp: string, ignoreUserId = ""): Promise<string> {
	const db = c.env.DB;
	const number = otpDigits(phone);
	if (await phoneTaken(db, number, ignoreUserId)) throw new HttpError(400, "This mobile number is already registered.");
	const code = otp.replace(/\D/g, "");
	const row = await one(db, "SELECT * FROM phone_otps WHERE phone = ?", number);
	if (!row || toMs(row.expires_at) < Date.now()) throw new HttpError(400, "That code has expired. Request a new one.");
	const attempts = num(row.attempts) + 1;
	if (attempts > 5) {
		await run(db, "DELETE FROM phone_otps WHERE phone = ?", number);
		throw new HttpError(400, "Too many tries. Request a new code.");
	}
	if (!safeEqual(String(row.code_hash), await hmacHex(secretKey(c.env), `${number}:${code}`))) {
		await run(db, "UPDATE phone_otps SET attempts = ? WHERE phone = ?", attempts, number);
		throw new HttpError(400, "The verification code is incorrect.");
	}
	await run(db, "DELETE FROM phone_otps WHERE phone = ?", number);
	return number;
}

function googleAudiences(env: Env): string[] {
	const ids = [setting(env, "GOOGLE_WEB_CLIENT_ID", DEFAULT_GOOGLE_IDS[0]), setting(env, "GOOGLE_BROWSER_CLIENT_ID", DEFAULT_GOOGLE_IDS[1]), setting(env, "GOOGLE_ANDROID_CLIENT_ID", DEFAULT_GOOGLE_IDS[2])];
	return ids.filter(Boolean);
}

async function googleJson(url: string, headers: Record<string, string> = {}): Promise<Row> {
	let response: Response;
	try {
		response = await fetch(url, { headers });
	} catch {
		throw new HttpError(401, "Google sign-in could not be verified.");
	}
	const payload = (await response.json().catch(() => null)) as unknown;
	if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(401, "Google sign-in could not be verified.");
	return payload as Row;
}

async function googleClaims(env: Env, body: Body): Promise<Row> {
	const accessToken = optStr(body, "access_token");
	const idToken = optStr(body, "id_token");
	const audiences = googleAudiences(env);
	if (accessToken) {
		const info = await googleJson(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
		if (info.error || info.error_description) throw new HttpError(401, "Google sign-in could not be verified.");
		if (!audiences.includes(String(info.aud || info.azp || ""))) throw new HttpError(401, "Google sign-in is not allowed for this app.");
		const profile = await googleJson("https://www.googleapis.com/oauth2/v3/userinfo", { Authorization: `Bearer ${accessToken}` });
		if (!profile.sub) profile.sub = info.sub;
		if (!profile.email) profile.email = info.email;
		return profile;
	}
	if (idToken) {
		if (!audiences.length) throw new HttpError(401, "Google client IDs are not configured.");
		const claims = await googleJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
		const issuer = String(claims.iss ?? "");
		if (!audiences.includes(String(claims.aud ?? "")) || !["accounts.google.com", "https://accounts.google.com"].includes(issuer) || num(claims.exp) + 10 < Date.now() / 1000) {
			throw new HttpError(401, "Google sign-in could not be verified.");
		}
		return claims;
	}
	throw new HttpError(401, "Google sign-in did not return a token.");
}

function firstOf(address: Row | undefined, keys: string[]): string {
	if (!address) return "";
	for (const key of keys) {
		const value = address[key];
		if (value) return String(value).trim();
	}
	return "";
}

function localityOf(address: Row | undefined, fallback: string): string {
	return (firstOf(address, ["suburb", "neighbourhood", "village", "town", "city_district", "city", "county", "state"]) || fallback).slice(0, 160);
}

function pincodeOf(address: Row | undefined, display: string): string {
	const digits = String(address?.postcode ?? "").trim().replace(/\D/g, "");
	if (digits.length >= 6) return digits.slice(0, 6);
	return /\b(\d{6})\b/.exec(display)?.[1] ?? "";
}

async function nominatim(path: string, params: Record<string, string>): Promise<unknown> {
	const response = await fetch(`${NOMINATIM}${path}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json", "User-Agent": "CrocoSip/1.0 (location picker)" } });
	if (!response.ok) throw new Error("Could not read that location.");
	return response.json();
}

function razorpayKeys(env: Env): { key: string; secret: string } {
	const key = setting(env, "RAZORPAY_KEY_ID");
	const secret = setting(env, "RAZORPAY_KEY_SECRET");
	if (!key || !secret) throw new RazorpayRequestError("Razorpay is not configured.");
	return { key, secret };
}

async function razorpay(env: Env, path: string, method = "GET", payload?: unknown): Promise<{ ok: boolean; status: number; data: Row }> {
	const { key, secret } = razorpayKeys(env);
	let response: Response;
	try {
		response = await fetch(`https://api.razorpay.com/v1${path}`, {
		method,
			headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}`, "Content-Type": "application/json" },
		body: payload === undefined ? undefined : JSON.stringify(payload),
	});
	} catch {
		return { ok: false, status: 0, data: {} };
	}
	const data = ((await response.json().catch(() => ({}))) ?? {}) as Row;
	return { ok: response.ok, status: response.status, data };
}

function razorpayAuthish(result: { status: number; data: Row }): boolean {
	const description = String((result.data.error as Row | undefined)?.description ?? "").toLowerCase();
	return result.status === 401 || description.includes("authentication") || description.includes("unauthorized");
}

function raiseApi(result: { status: number; data: Row }): never {
	if (razorpayAuthish(result)) throw new RazorpayAuthError("Razorpay could not authenticate.");
	throw new RazorpayRequestError("Could not start the payment.");
}

function raiseGateway(result: { status: number; data: Row }, fallback: string): never {
	const message = razorpayAuthish(result) ? "Razorpay could not authenticate." : fallback;
	if (message.toLowerCase().includes("authenticate")) throw new RazorpayAuthError(message);
	throw new RazorpayRequestError(message);
}

function paymentError(error: unknown): never {
	if (error instanceof RazorpayAuthError) throw new HttpError(401, error.message);
	if (error instanceof RazorpayRequestError) throw new HttpError(500, error.message);
	throw error;
}

async function amountPaise(db: D1Database, user: Row, items: Row[], deliveryType: string, amount: number | null): Promise<number> {
	let paise: number;
	if (items.length) paise = Math.round((await prepareOrder(db, user, items, deliveryType)).subtotal * 100);
	else if (amount !== null) paise = Math.trunc(amount);
	else throw new HttpError(400, "Add items before paying.");
	if (paise < 100) throw new HttpError(400, "Minimum payment is ₹1.");
	return paise;
}

function utrOf(acquirer: unknown): string | null {
	if (!acquirer || typeof acquirer !== "object") return null;
	const data = acquirer as Row;
	for (const key of ["rrn", "upi_transaction_id", "bank_transaction_id"]) {
		if (data[key]) return String(data[key]);
	}
	return null;
}

function unixIso(value: unknown): string | null {
	return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function daysBetween(start: number | null, end: number | null): number | null {
	if (start === null || end === null) return null;
	const day = (ms: number) => Date.parse(new Date(ms).toISOString().slice(0, 10));
	return Math.max(0, Math.round((day(end) - day(start)) / 86_400_000));
}

function msOf(value: unknown): number | null {
	return typeof value === "number" ? value * 1000 : null;
}

function isoOf(ms: number | null): string | null {
	return ms === null ? null : new Date(ms).toISOString();
}

function inIst(ms: number) {
	return new Date(ms + IST_OFFSET_MS);
}

function formatIst(ms: number | null) {
	if (ms === null) return null;
	return inIst(ms).toLocaleString("en-IN", {
		weekday: "short",
		day: "2-digit",
		month: "short",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
		timeZone: "UTC",
	});
}

function nextWorkingDay1pm(fromMs: number) {
	const local = inIst(fromMs);
	local.setUTCDate(local.getUTCDate() + 1);
	while (local.getUTCDay() === 0 || local.getUTCDay() === 6) local.setUTCDate(local.getUTCDate() + 1);
	local.setUTCHours(13, 0, 0, 0);
	return local.getTime() - IST_OFFSET_MS;
}

function addWorkingDays(fromMs: number, days: number) {
	const local = inIst(fromMs);
	let added = 0;
	while (added < days) {
		local.setUTCDate(local.getUTCDate() + 1);
		const weekday = local.getUTCDay();
		if (weekday !== 0 && weekday !== 6) added += 1;
	}
	local.setUTCHours(13, 0, 0, 0);
	return local.getTime() - IST_OFFSET_MS;
}

function timelineStep(input: {
	key: string;
	label: string;
	at?: number | null;
	state?: string;
	detail?: string | null;
	amount?: number | null;
	days_after?: number | null;
	children?: Row[];
}) {
	return {
		key: input.key,
		label: input.label,
		at: isoOf(input.at ?? null),
		state: input.state ?? "upcoming",
		detail: input.detail ?? null,
		amount: input.amount ?? null,
		days_after: input.days_after ?? null,
		children: input.children ?? [],
	};
}

async function refundTimeline(env: Env, paymentId: string) {
	const id = paymentId.trim();
	if (!id.startsWith("pay_")) throw new HttpError(400, "This payment cannot be opened.");
	const paymentResult = await razorpay(env, `/payments/${encodeURIComponent(id)}`);
	if (!paymentResult.ok) raiseGateway(paymentResult, "Could not load this refund.");
	const refundsResult = await razorpay(env, `/payments/${encodeURIComponent(id)}/refunds?count=10`);
	if (!refundsResult.ok) raiseGateway(refundsResult, "Could not load this refund.");
	const payment = paymentResult.data;
	const refunds = (Array.isArray(refundsResult.data.items) ? (refundsResult.data.items as Row[]) : []).sort((a, b) => num(a.created_at) - num(b.created_at));
	const refund = refunds.at(-1) ?? null;
	const now = Date.now();
	const createdAt = msOf(payment.created_at);
	const authorizedAt = msOf(payment.authorized_at) ?? createdAt;
	const capturedAt = msOf(payment.captured_at) ?? createdAt;
	const payStatus = String(payment.status ?? "").toLowerCase();
	const captured = Boolean(payment.captured) || payStatus === "captured" || payStatus === "refunded";
	const authorized = captured || payStatus === "authorized" || payStatus === "captured" || payStatus === "refunded";
	const requestedAt = refund ? msOf(refund.created_at) : null;
	const status = String(refund?.status ?? "");
	const speed = String(refund?.speed_processed || refund?.speed_requested || "normal");
	const expectedDays = speed === "instant" || speed === "optimum" ? 1 : 7;
	const elapsed = requestedAt !== null ? (daysBetween(requestedAt, now) ?? 0) : 0;
	const requestGap = daysBetween(createdAt, requestedAt);
	const refundAcquirer = refund && refund.acquirer_data && typeof refund.acquirer_data === "object" ? (refund.acquirer_data as Row) : {};
	const arn = String(refundAcquirer.arn || refundAcquirer.rrn || "") || null;
	const refundAmount = refund ? Math.trunc(num(refund.amount)) : 0;
	let refundState: string;
	let processingState: string;
	let processedState: string;
	let refundLabel: string;
	let processingDetail: string;
	let processedDetail: string;
	if (status === "processed") {
		refundState = "done";
		processingState = "done";
		processedState = "done";
		refundLabel = "Refund (Processed)";
		processingDetail = "Takes 3-5 working days";
		processedDetail = "Amount will be credited to the customer's bank account within 5-7 working days after the refund has processed";
	} else if (status === "failed") {
		refundState = "failed";
		processingState = "failed";
		processedState = "failed";
		refundLabel = "Refund (Failed)";
		processingDetail = "The refund failed";
		processedDetail = "Money was not returned";
	} else if (refund) {
		refundState = "current";
		processingState = "current";
		processedState = "upcoming";
		refundLabel = "Refund (Processing)";
		processingDetail = "Takes 3-5 working days";
		processedDetail = "Amount will be credited to the customer's bank account within 5-7 working days after the refund has processed";
	} else {
		refundState = "upcoming";
		processingState = "upcoming";
		processedState = "upcoming";
		refundLabel = "Refund";
		processingDetail = "Waiting for a refund request";
		processedDetail = "Waiting";
	}
	let settlement: Row | null = null;
	const settlementId = text(payment.settlement_id);
	if (settlementId) {
		const settlementResult = await razorpay(env, `/settlements/${encodeURIComponent(settlementId)}`);
		if (settlementResult.ok) settlement = settlementResult.data;
	}
	let settlementAt = settlement ? msOf(settlement.created_at) : null;
	const settlementStatus = String(settlement?.status ?? "").toLowerCase();
	const settlementDone = settlementStatus === "processed" || settlementStatus === "settled" || Boolean(payment.settled);
	if (capturedAt !== null && settlementAt === null) settlementAt = nextWorkingDay1pm(capturedAt);
	let settlementState: string;
	let settlementLabel: string;
	let settlementDetail: string | null;
	if (settlementDone) {
		settlementState = "done";
		settlementLabel = "Settlement (Processed)";
		settlementDetail = "Deposited";
	} else if (captured) {
		settlementState = "current";
		settlementLabel = "Settlement (To be processed)";
		settlementDetail = settlementAt ? `To be deposited by: ${formatIst(settlementAt)}` : "Waiting for the next settlement cycle";
	} else {
		settlementState = "upcoming";
		settlementLabel = "Settlement";
		settlementDetail = "After the payment is captured";
	}
	const creditAt = requestedAt === null ? null : addWorkingDays(requestedAt, expectedDays === 1 ? 1 : 7);
	const bankDone = Boolean(arn) || (status === "processed" && creditAt !== null && now >= creditAt);
	let bankState: string;
	let bankLabel: string;
	let bankDetail: string;
	if (status === "failed") {
		bankState = "failed";
		bankLabel = "Bank transfer failed";
		bankDetail = "Money was not returned to the original account";
	} else if (!refund) {
		bankState = "upcoming";
		bankLabel = "Credited to your bank";
		bankDetail = "Starts after the refund is processed";
	} else if (bankDone) {
		bankState = "done";
		bankLabel = "Credited to your bank";
		bankDetail = "Refund should now be in the original account";
	} else {
		bankState = "current";
		bankLabel = "Credited to your bank";
		bankDetail = creditAt ? `Usually in the original account by ${formatIst(creditAt)}` : "Usually 5-7 working days after the refund is processed";
	}
	return {
		payment_id: id,
		amount: num(payment.amount),
		refund_amount: refundAmount,
		currency: String(payment.currency || "INR"),
		utr: utrOf(payment.acquirer_data),
		refund_id: refund ? text(refund.id) : null,
		status: status || "none",
		speed: refund ? speed : null,
		days: refund ? elapsed : 0,
		expected_days: refund ? expectedDays : 7,
		arn,
		steps: [
			timelineStep({ key: "created", label: "Payment created", at: createdAt, state: createdAt ? "done" : "upcoming" }),
			timelineStep({ key: "authorized", label: "Payment authorized", at: authorized ? authorizedAt : null, state: authorized ? "done" : "upcoming" }),
			timelineStep({ key: "captured", label: "Payment captured", at: captured ? capturedAt : null, state: captured ? "done" : authorized ? "current" : "upcoming" }),
			timelineStep({
				key: "refund",
				label: refundLabel,
				at: requestedAt,
				state: refundState,
				amount: refundAmount || null,
				detail: requestedAt ? `Issued on ${formatIst(requestedAt)}` : null,
				days_after: requestGap,
				children: [
					timelineStep({ key: "refund_processing", label: "Refund processing", state: processingState, detail: processingDetail, days_after: refund ? elapsed : null }),
					timelineStep({
						key: "refund_processed",
						label: status === "failed" ? "Refund failed" : "Refund processed",
						at: status === "processed" ? requestedAt : null,
						state: processedState,
						detail: processedDetail,
					}),
				],
			}),
			timelineStep({ key: "settlement", label: settlementLabel, at: settlementDone ? settlementAt : null, state: settlementState, detail: settlementDetail }),
			timelineStep({ key: "bank", label: bankLabel, at: bankDone ? creditAt : null, state: bankState, detail: bankDetail }),
		],
	};
}

// ---- routes ----

type RouteOptions = { auth?: boolean; query?: string[]; status?: number; bodyFields?: string[] };
type Handler = (c: Ctx) => Promise<unknown> | unknown;

function routeOn(app: App) {
	return (method: Method, path: string, tag: string, summary: string, handler: Handler, options: RouteOptions = {}) => {
		crocoRoutes.push({ method, path, tag, summary, auth: !!options.auth, query: options.query ?? [], body: method !== "get" && method !== "delete", bodyFields: options.bodyFields ?? [] });
		app[method](path, async (c: Ctx) => {
			try {
				const result = await handler(c);
				if (result instanceof Response) return result;
				return c.json(result as object, (options.status ?? 200) as ContentfulStatusCode);
			} catch (error) {
				if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as ContentfulStatusCode);
				throw error;
			}
		});
	};
}

const OPEN_PATHS = new Set(["/", "/health", "/docs", "/openapi.json", "/openapi.yaml", "/redocs", "/db/check"]);

export function registerCroco(app: App) {
	const route = routeOn(app);

	app.use("*", async (c, next) => {
		if (OPEN_PATHS.has(c.req.path)) return next();
		try {
			await ensureSeed(c.env.DB);
		} catch (error) {
			console.error("Database seed failed:", error);
			const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
			return c.json({ detail: `Database is not ready. ${reason}` }, 503);
		}
		await next();
	});

	app.get("/uploads/*", serveUpload);

	// ---- health ----
	route("get", "/", "health", "Service info", (c) => ({ service: setting(c.env, "APP_NAME", "Crocosip API"), docs: "/docs", api: "/api" }));
	route("get", "/health", "health", "Health check", (c) => ({
		status: "ok",
		service: setting(c.env, "APP_NAME", "Crocosip API"),
		schema: setting(c.env, "DB_SCHEMA", DB_SCHEMA),
		database: "postgresql",
	}));
	route("post", "/db/setup", "health", "Create missing tables and seed data", async (c) => {
		const pg = postgresOf(c.env.DB);
		const created = pg ? await pg.setup() : [];
		seeded = null;
		await ensureSeed(c.env.DB);
		return { status: "ok", schema: setting(c.env, "DB_SCHEMA", DB_SCHEMA), created_tables: created, added_columns: [], errors: [], tables: pg ? await pg.tables() : [] };
	});
	route(
		"post",
		"/db/reset",
		"health",
		"Reset all data",
		async (c) => {
			const body = await bodyOf(c);
			const password = reqStr(body, "password");
			if (password !== "password") throw new HttpError(401, "Wrong password.");
			const pg = postgresOf(c.env.DB);
			if (!pg) throw new HttpError(503, "Database is not ready.");
			const cleared = await pg.reset();
			seeded = null;
			await ensureSeed(c.env.DB);
			return { status: "ok", schema: setting(c.env, "DB_SCHEMA", DB_SCHEMA), cleared_tables: cleared, errors: [] };
		},
		{ bodyFields: ["password"] },
	);
	route("get", "/db/check", "health", "Check the database", async (c) => {
		const pg = postgresOf(c.env.DB);
		const schema = setting(c.env, "DB_SCHEMA", DB_SCHEMA);
		const tables = pg ? await pg.tables() : [];
		const users = tables.includes("users") ? num((await one(c.env.DB, "SELECT COUNT(*) AS total FROM users"))?.total) : 0;
		return {
			status: tables.length ? "ok" : "missing_schema",
			connected: true,
			host: setting(c.env, "POSTGRES_HOST"),
			port: int(setting(c.env, "POSTGRES_PORT"), 25060),
			database: setting(c.env, "POSTGRES_DB"),
			schema,
			schema_exists: tables.length > 0,
			tables,
			user_count: users,
			dialect: "postgresql",
		};
	});

	// ---- catalog ----
	route("get", "/juices", "juices", "List visible juices", async (c) => (await listJuices(c.env.DB, false)).map(juiceOut));
	route("get", "/juices/categories", "juices", "List juice categories", async (c) => ({ names: await categoryNames(c.env.DB) }));
	route("get", "/plans", "plans", "List plans", async (c) => (await listPlans(c.env.DB)).map(planOut));
	route("get", "/store", "store", "Store settings", async (c) => storeOut(await storeRow(c.env.DB)));

	// ---- auth ----
	route("post", "/auth/otp/send", "auth", "Send a phone verification code", async (c) => {
		const body = await bodyOf(c);
		const db = c.env.DB;
		const number = otpDigits(reqStr(body, "phone", 10, 20));
		if (await phoneTaken(db, number)) throw new HttpError(400, "This mobile number is already registered.");
		await storeAndSendOtp(c, number);
		return { sent: true };
	});

	route(
		"post",
		"/auth/register",
		"auth",
		"Create a password account",
		async (c) => {
			const body = await bodyOf(c);
			const identifier = reqStr(body, "identifier");
			const password = reqStr(body, "password");
			const name = optStr(body, "name", 120);
			const phone = reqStr(body, "phone", 10, 20);
			const otp = reqStr(body, "otp", 4, 8);
			const db = c.env.DB;
			const verified = await verifyPhoneOtp(c, phone, otp);
			const normalized = identifier.trim();
			if (normalized.toLowerCase() === "admin") throw new HttpError(400, "That username is reserved.");
			if (await findUser(db, normalized)) throw new HttpError(400, "An account with that username or email already exists.");
			const cleanPhone = verified.trim() ? normalizePhone(verified) : null;
			const email = normalized.includes("@") ? normalized : null;
			const fullName = name?.trim() || (email ? normalized.split("@")[0] : normalized);
			const id = uuid();
			await run(db, "INSERT INTO users (id, username, email, name, phone, password_hash, provider, role, special_access, created_at) VALUES (?, ?, ?, ?, ?, ?, 'password', 'customer', FALSE, ?)", id, email ? null : normalized, email, fullName, cleanPhone, await hashPassword(password), nowIso());
			return authResponse(c, (await userById(db, id))!);
		},
		{ status: 201 },
	);

	route("post", "/auth/login", "auth", "Sign in with a password", async (c) => {
		const body = await bodyOf(c);
		const identifier = reqStr(body, "identifier");
		const password = reqStr(body, "password");
		const user = await findUser(c.env.DB, identifier);
		if (!user || !user.password_hash || !(await verifyPassword(password, text(user.password_hash)))) {
			throw new HttpError(401, "Invalid username, email, or password.");
		}
		return authResponse(c, user);
	});

	route("post", "/auth/google", "auth", "Sign in with Google", async (c) => {
		const body = await bodyOf(c);
		const db = c.env.DB;
		const claims = await googleClaims(c.env, body);
		const googleId = claims.sub ? String(claims.sub) : "";
		if (!googleId) throw new HttpError(401, "Google sign-in could not be verified.");
		const email = claims.email ? String(claims.email) : null;
		const name = String(claims.name || claims.email || "Google user");
		const photo = claims.picture ? String(claims.picture) : null;
		let user = await one(db, "SELECT * FROM users WHERE google_id = ?", googleId);
		if (!user && email) user = await findUser(db, email);
		try {
			if (!user) {
				const id = uuid();
				await run(db, "INSERT INTO users (id, email, name, photo, google_id, provider, role, special_access, created_at) VALUES (?, ?, ?, ?, ?, 'google', 'customer', FALSE, ?)", id, email ? email.toLowerCase() : null, name, photo, googleId, nowIso());
				user = (await userById(db, id))!;
			} else {
				await run(db, "UPDATE users SET google_id = ?, provider = 'google', email = COALESCE(?, email), name = COALESCE(?, name), photo = COALESCE(?, photo) WHERE id = ?", googleId, email ? email.toLowerCase() : null, name || null, photo, user.id);
				user = await reloadUser(db, user);
			}
		} catch (error) {
			if (String(error).includes("UNIQUE")) throw new HttpError(400, "That Google email is already used by another account.");
			throw error;
		}
		return authResponse(c, user);
	});

	route("get", "/auth/me", "auth", "Current user", async (c) => userOut(c.env.DB, await currentUser(c)), { auth: true });

	route("get", "/wallet/me", "wallet", "My wallet", async (c) => {
		const user = await currentUser(c);
		const entries = await many(c.env.DB, "SELECT * FROM wallet_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", user.id);
		return { balance: moneyOf(user.wallet_balance), entries: entries.map((row) => walletEntryOut(row, user)) };
	}, { auth: true });

	route(
		"post",
		"/auth/me/phone/otp",
		"auth",
		"Send a code to verify my phone",
		async (c) => {
			const body = await bodyOf(c);
			const user = await currentUser(c);
			const number = otpDigits(reqStr(body, "phone", 10, 20));
			if (await phoneTaken(c.env.DB, number, String(user.id))) throw new HttpError(400, "This mobile number is already registered.");
			await storeAndSendOtp(c, number);
			return { sent: true };
		},
		{ auth: true },
	);

	route(
		"patch",
		"/auth/me/phone",
		"auth",
		"Save my phone",
		async (c) => {
			const body = await bodyOf(c);
			const phone = reqStr(body, "phone", 10, 20);
			const otp = reqStr(body, "otp", 4, 8);
			const user = await currentUser(c);
			const verified = await verifyPhoneOtp(c, phone, otp, String(user.id));
			await run(c.env.DB, "UPDATE users SET phone = ? WHERE id = ?", normalizePhone(verified), user.id);
			return userOut(c.env.DB, await reloadUser(c.env.DB, user));
		},
		{ auth: true },
	);

	route(
		"patch",
		"/auth/me/location",
		"auth",
		"Save my delivery location",
		async (c) => {
			const body = await bodyOf(c);
			const latitude = reqNum(body, "latitude");
			const longitude = reqNum(body, "longitude");
			const address = reqStr(body, "address", 3, 500);
			const locality = optStr(body, "locality", 160);
			const user = await currentUser(c);
			let special = { special_access: bool(user.special_access) ? 1 : 0, special_lat: numOrNull(user.special_lat), special_lng: numOrNull(user.special_lng) };
			if (bool(user.special_access)) {
				if (user.special_lat == null || user.special_lng == null || distanceMeters(num(user.special_lat), num(user.special_lng), latitude, longitude) > SPECIAL_ACCESS_METERS) {
					special = specialAccessFields(user, false);
				}
			}
			await run(c.env.DB, "UPDATE users SET location_lat = ?, location_lng = ?, location_address = ?, location_locality = ?, special_access = ?, special_lat = ?, special_lng = ? WHERE id = ?", latitude, longitude, address.trim(), locality?.trim() || null, special.special_access, special.special_lat, special.special_lng, user.id);
			return userOut(c.env.DB, await reloadUser(c.env.DB, user));
		},
		{ auth: true },
	);

	const readSavedAddress = (body: Body) => ({
		latitude: reqNum(body, "latitude"),
		longitude: reqNum(body, "longitude"),
		address: reqStr(body, "address", 3, 500),
		locality: optStr(body, "locality", 160),
		label: optStr(body, "label", 80),
	});

	route(
		"post",
		"/auth/me/addresses",
		"auth",
		"Save an address",
		async (c) => {
			const input = readSavedAddress(await bodyOf(c));
			const user = await currentUser(c);
			const db = c.env.DB;
			const rows = await savedAddresses(db, user.id);
			const locality = input.locality?.trim() || null;
			const match = rows.find((row) => Math.abs(num(row.latitude) - input.latitude) < 0.00015 && Math.abs(num(row.longitude) - input.longitude) < 0.00015);
			if (match) {
				await run(db, "UPDATE saved_addresses SET address = ?, locality = ?, label = ? WHERE id = ?", input.address.trim(), locality, input.label?.trim() ? input.label.trim() : match.label, match.id);
			} else {
				if (rows.length >= MAX_SAVED_ADDRESSES) throw new HttpError(400, `You can save up to ${MAX_SAVED_ADDRESSES} addresses.`);
				await run(db, "INSERT INTO saved_addresses (id, user_id, label, latitude, longitude, address, locality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuid(), user.id, (input.label || input.locality || "Saved address").trim().slice(0, 80), input.latitude, input.longitude, input.address.trim(), locality, nowIso());
			}
			return userOut(db, user);
		},
		{ auth: true, status: 201 },
	);

	route(
		"patch",
		"/auth/me/addresses/:addressId",
		"auth",
		"Update a saved address",
		async (c) => {
			const input = readSavedAddress(await bodyOf(c));
			const user = await currentUser(c);
			const db = c.env.DB;
			const row = await one(db, "SELECT * FROM saved_addresses WHERE id = ?", c.req.param("addressId"));
			if (!row || row.user_id !== user.id) throw new HttpError(404, "Address not found.");
			const locality = input.locality?.trim() || null;
			const label = input.label?.trim() ? input.label.trim().slice(0, 80) : locality ? locality.slice(0, 80) : String(row.label ?? "");
			await run(db, "UPDATE saved_addresses SET latitude = ?, longitude = ?, address = ?, locality = ?, label = ? WHERE id = ?", input.latitude, input.longitude, input.address.trim(), locality, label, row.id);
			return userOut(db, user);
		},
		{ auth: true },
	);

	route(
		"delete",
		"/auth/me/addresses/:addressId",
		"auth",
		"Delete a saved address",
		async (c) => {
			const user = await currentUser(c);
			const db = c.env.DB;
			const row = await one(db, "SELECT * FROM saved_addresses WHERE id = ?", c.req.param("addressId"));
			if (!row || row.user_id !== user.id) throw new HttpError(404, "Address not found.");
			await run(db, "DELETE FROM saved_addresses WHERE id = ?", row.id);
			return userOut(db, user);
		},
		{ auth: true },
	);

	route(
		"get",
		"/auth/location/reverse",
		"auth",
		"Read an address from a map pin",
		async (c) => {
			const latitude = queryNum(c, "lat");
			const longitude = queryNum(c, "lng");
			await currentUser(c);
			try {
				const payload = (await nominatim("/reverse", { lat: latitude.toFixed(7), lon: longitude.toFixed(7), format: "json", addressdetails: "1", zoom: "18" })) as Row;
				const display = String(payload?.display_name ?? "").trim();
				if (!display) throw new Error("Could not read that location.");
				const address = payload.address && typeof payload.address === "object" ? (payload.address as Row) : {};
				return {
					latitude,
					longitude,
					address: display.slice(0, 500),
					locality: localityOf(address, display.split(",")[0]),
					street: [firstOf(address, ["road", "pedestrian", "footway", "path"]), firstOf(address, ["neighbourhood", "suburb"])].filter(Boolean).join(", ").slice(0, 200),
					city: firstOf(address, ["city", "town", "village", "county", "state"]).slice(0, 120),
					house: firstOf(address, ["house_number", "building"]).slice(0, 80),
					pincode: pincodeOf(address, display),
				};
			} catch {
				throw new HttpError(400, "Could not read that map location.");
			}
		},
		{ auth: true, query: ["lat", "lng"] },
	);

	route(
		"get",
		"/auth/location/search",
		"auth",
		"Search places",
		async (c) => {
			const query = c.req.query("q");
			if (query === undefined) throw new HttpError(422, [{ type: "missing", loc: ["query", "q"], msg: "Field required", input: null }]);
			await currentUser(c);
			const needle = query.trim();
			if (needle.length < 2) return [];
			try {
				const payload = await nominatim("/search", { q: needle, format: "json", addressdetails: "1", limit: "8", countrycodes: "in" });
				if (!Array.isArray(payload)) return [];
				return (payload as Row[])
					.filter((item) => item && typeof item === "object" && String(item.display_name ?? "").trim())
					.map((item) => {
						const display = String(item.display_name).trim();
						const address = item.address && typeof item.address === "object" ? (item.address as Row) : {};
						return { latitude: num(item.lat), longitude: num(item.lon), address: display.slice(0, 500), locality: localityOf(address, display.split(",")[0]) };
					});
			} catch {
				throw new HttpError(400, "Could not search locations.");
			}
		},
		{ auth: true, query: ["q"] },
	);

	// ---- orders ----
	route("get", "/orders/me", "orders", "My orders", async (c) => {
		const user = await currentUser(c);
		const rows = await many(c.env.DB, "SELECT * FROM juice_orders WHERE user_id = ? ORDER BY created_at DESC", user.id);
		return (await syncOrderRefunds(c.env, rows)).map(orderOut);
	}, { auth: true });

	route("get", "/orders/:orderId/refund", "orders", "Refund status for my order", async (c) => {
		const user = await currentUser(c);
		const row = await one(c.env.DB, "SELECT * FROM juice_orders WHERE id = ? AND user_id = ?", c.req.param("orderId"), user.id);
		if (!row) throw new HttpError(404, "Order not found.");
		const paymentId = text(row.payment_id);
		if (!paymentId?.startsWith("pay_")) throw new HttpError(400, "No refund on this order.");
		try {
			return await refundTimeline(c.env, paymentId);
		} catch (error) {
			paymentError(error);
		}
	}, { auth: true });

	route(
		"post",
		"/orders",
		"orders",
		"Place a cash on delivery order",
		async (c) => {
			const body = await bodyOf(c);
			const items = validOrderItems(body, "items", true);
			const deliveryType = optStr(body, "delivery_type", 64, "slot") ?? "slot";
			const user = await currentUser(c);
			const method = (optStr(body, "payment_method", 24, "COD") ?? "COD").toUpperCase();
			if (!["COD", "WALLET"].includes(method)) throw new HttpError(400, "Choose a valid payment method.");
			return orderOut(await createOrder(c.env.DB, user, items, deliveryType, method));
		},
		{ auth: true, status: 201 },
	);

	route(
		"patch",
		"/orders/:orderId/rating",
		"orders",
		"Rate a juice order",
		async (c) => {
			const rating = reqNum(await bodyOf(c), "rating", { ge: 1, le: 5, integer: true });
			const user = await currentUser(c);
			const row = await one(c.env.DB, "SELECT * FROM juice_orders WHERE id = ? AND user_id = ?", c.req.param("orderId"), user.id);
			if (!row) throw new HttpError(404, "Order not found.");
			if (String(row.status) === "cancelled") throw new HttpError(400, "Cancelled orders cannot be rated.");
			await run(c.env.DB, "UPDATE juice_orders SET rating = ? WHERE id = ?", rating, row.id);
			return orderOut((await one(c.env.DB, "SELECT * FROM juice_orders WHERE id = ?", row.id))!);
		},
		{ auth: true },
	);

	// ---- payments ----
	route(
		"post",
		"/api/create-order",
		"payments",
		"Start a Razorpay payment",
		async (c) => {
			const body = await bodyOf(c);
			const amount = optNum(body, "amount", { ge: 100, integer: true });
			const currency = optStr(body, "currency", undefined, "INR") ?? "INR";
			const receipt = optStr(body, "receipt", 40);
			const items = validOrderItems(body, "items", false);
			const deliveryType = optStr(body, "delivery_type", 64, "slot") ?? "slot";
			const user = await currentUser(c);
			try {
				const paise = await amountPaise(c.env.DB, user, items, deliveryType, amount);
				const code = (receipt || `croco${uuidHex().slice(0, 16)}`).slice(0, 40);
				const result = await razorpay(c.env, "/orders", "POST", { amount: paise, currency: currency || "INR", receipt: code });
				if (!result.ok) raiseApi(result);
				return { order_id: result.data.id, amount: Math.trunc(num(result.data.amount)), currency: String(result.data.currency || "INR"), key_id: setting(c.env, "RAZORPAY_KEY_ID") };
		} catch (error) {
				paymentError(error);
			}
		},
		{ auth: true },
	);

	route(
		"post",
		"/api/verify-payment",
		"payments",
		"Verify a Razorpay payment and place the order",
		async (c) => {
			const body = await bodyOf(c);
			const orderId = reqStr(body, "razorpay_order_id", 1);
			const paymentId = reqStr(body, "razorpay_payment_id", 1);
			const signature = reqStr(body, "razorpay_signature", 1);
			const items = validOrderItems(body, "items", false);
			const deliveryType = optStr(body, "delivery_type", 64, "slot") ?? "slot";
			const user = await currentUser(c);
			try {
				const { secret } = razorpayKeys(c.env);
				if (!safeEqual(await hmacHex(secret, `${orderId}|${paymentId}`), signature)) throw new HttpError(400, "Payment could not be verified.");
				if (!items.length) return { verified: true };
				const expected = await amountPaise(c.env.DB, user, items, deliveryType, null);
				const remote = await razorpay(c.env, `/orders/${encodeURIComponent(orderId)}`);
				if (!remote.ok) raiseApi(remote);
				if (Math.trunc(num(remote.data.amount)) !== expected) throw new HttpError(400, "Payment amount does not match the cart.");
				const row = await createOrder(c.env.DB, user, items, deliveryType, "UPI", paymentId);
				return { verified: true, order: orderOut(row) };
		} catch (error) {
				paymentError(error);
			}
		},
		{ auth: true },
	);

	// ---- plan requests ----
	route("get", "/plans/requests/me", "plans", "My plan requests", async (c) => myRequests(c.env.DB, (await currentUser(c)).id), { auth: true });

	route(
		"post",
		"/plans/requests",
		"plans",
		"Request a plan",
		async (c) => {
			const body = await bodyOf(c);
			const planId = reqStr(body, "plan_id", 1, 64);
			const planName = reqStr(body, "plan_name", 1, 160);
			const price = optStr(body, "price", 32, "") ?? "";
			const period = optStr(body, "period", 64, "") ?? "";
			const bottles = optStr(body, "bottles", 64, "") ?? "";
			const details = optStr(body, "details", 4000, "") ?? "";
			const days = optNum(body, "days", { ge: 1, le: 400, integer: true });
			const rawItems = listField(body, "items", []);
			if (rawItems.length > 100) invalid("items", "List should have at most 100 items after validation", rawItems.length);
			const items = rawItems.map((raw, index) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`items.${index}`, "Input should be a valid dictionary or object to extract fields from", raw);
				const item = raw as Body;
				return {
					id: reqStr(item, "id", 1, 64),
					name: reqStr(item, "name", 1, 160),
					qty: optNum(item, "qty", { ge: 1, le: 20, integer: true, fallback: 1 }),
					days: optNum(item, "days", { ge: 0, le: 400, integer: true, fallback: 0 }),
					image: optStr(item, "image", 2000),
				};
			});
			const upgradeMode = literal(body, "upgrade_mode", UPGRADE_MODES, "");
			const startsOn = optStr(body, "starts_on", 10);
			const methodIn = literal(body, "payment_method", ["UPI", "WALLET", "SPLIT"], "UPI");
			const user = await currentUser(c);
			const db = c.env.DB;
			const hasPin = user.location_lat != null && user.location_lng != null;
			const hasAddress = !!String(user.location_address || user.location_locality || "").trim();
			if (!hasPin || !hasAddress) throw new HttpError(400, "Add your delivery location before requesting a plan.");
			const total = rupeesFromPrice(price);
			const walletInput = optNum(body, "wallet_amount", { ge: 0, le: 100000 });
			let method = methodIn;
			let debit = 0;
			if (method === "WALLET") {
				debit = moneyOf(walletInput ?? total);
				if (total <= 0) throw new HttpError(400, "This plan has no payable amount.");
				if (Math.abs(debit - total) > 1e-6) {
					throw new HttpError(400, "Wallet must cover the full bill, or pay the rest with UPI.");
				}
			} else if (method === "SPLIT") {
				debit = moneyOf(walletInput ?? 0);
				if (total <= 0) throw new HttpError(400, "This plan has no payable amount.");
				if (debit <= 0) throw new HttpError(400, "Choose how much to take from wallet.");
				if (debit + 1e-9 >= total) {
					method = "WALLET";
					debit = total;
				} else if (total - debit + 1e-9 < 1) {
					throw new HttpError(400, "Remaining UPI amount must be at least ₹1.");
				}
			}
			if (debit > 0 && moneyOf(user.wallet_balance) + 1e-9 < debit) {
				throw new HttpError(400, "Not enough wallet money.");
			}
			const paidNote =
				debit > 0 && !/Paid /i.test(details)
					? [
							details.trim(),
							method === "SPLIT"
								? `Paid wallet ₹${debit.toFixed(2)} + UPI`
								: `Paid wallet ₹${debit.toFixed(2)}`,
						]
							.filter(Boolean)
							.join("\n")
					: details.trim();
			const id = uuid();
			await db.batch([
				prep(db, "UPDATE plan_requests SET status = 'cancelled', decided_at = ? WHERE user_id = ? AND status = 'pending'", nowIso(), user.id),
				prep(
					db,
					`INSERT INTO plan_requests (id, user_id, plan_id, plan_name, price, period, bottles, details, days, items, upgrade_mode, starts_on, skipped_dates, item_swaps, slot_order, delivery_lat, delivery_lng, delivery_address, delivery_locality, status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', '[]', ?, ?, ?, ?, 'pending', ?)`,
					id,
					user.id,
					planId,
					planName.trim(),
					price.trim(),
					period.trim(),
					bottles.trim(),
					paidNote,
					days,
					JSON.stringify(items),
					upgradeMode,
					startsOn,
					user.location_lat,
					user.location_lng,
					user.location_address,
					user.location_locality,
					nowIso(),
				),
			]);
			const created = (await one(db, "SELECT * FROM plan_requests WHERE id = ?", id))!;
			if (debit > 0) {
				try {
					await debitWallet(db, user, debit, `Plan ${planName.trim()}`, id, "plan");
				} catch (error) {
					await run(db, "DELETE FROM plan_requests WHERE id = ?", id);
					throw error;
				}
			}
			await activatePaidRequest(db, created);
			return requestOut((await one(db, "SELECT * FROM plan_requests WHERE id = ?", id))!);
		},
		{ auth: true, status: 201 },
	);

	route(
		"delete",
		"/plans/requests/pending",
		"plans",
		"Cancel my pending request",
		async (c) => {
			const user = await currentUser(c);
			await run(c.env.DB, "UPDATE plan_requests SET status = 'cancelled', decided_at = ? WHERE user_id = ? AND status = 'pending'", nowIso(), user.id);
			return { ok: true };
		},
		{ auth: true },
	);

	route(
		"post",
		"/plans/requests/skip",
		"plans",
		"Skip a delivery",
		async (c) => {
			const date = reqStr(await bodyOf(c), "date", 10, 10);
			const user = await currentUser(c);
			const target = guardSkipDate(date, false);
		let touched = 0;
			for (const row of await acceptedRows(c.env.DB, user.id)) {
				if (!deliversOn(row, target)) continue;
				const skipped = skippedSet(row);
				skipped.add(target);
				await writeSkipped(c.env.DB, row, skipped);
			touched += 1;
		}
			if (!touched) throw new HttpError(400, "No delivery on that date to skip.");
			return myRequests(c.env.DB, user.id);
		},
		{ auth: true },
	);

	route(
		"post",
		"/plans/requests/unskip",
		"plans",
		"Undo a skipped delivery",
		async (c) => {
			const date = reqStr(await bodyOf(c), "date", 10, 10);
			const user = await currentUser(c);
			const target = guardSkipDate(date, true);
		let touched = 0;
			for (const row of await acceptedRows(c.env.DB, user.id)) {
				const skipped = skippedSet(row);
				if (!skipped.delete(target)) continue;
				await writeSkipped(c.env.DB, row, skipped);
			touched += 1;
		}
			if (!touched) throw new HttpError(400, "That date is not skipped.");
			return myRequests(c.env.DB, user.id);
		},
		{ auth: true },
	);

	route(
		"post",
		"/plans/requests/change-item",
		"plans",
		"Swap two pending deliveries",
		async (c) => {
			const body = await bodyOf(c);
			const date = reqStr(body, "date", 10, 10);
			const requestId = reqStr(body, "request_id", 1, 64);
			const otherDate = reqStr(body, "other_date", 10, 10);
			const user = await currentUser(c);
			const target = guardSwapDate(date);
			const other = guardSwapDate(otherDate);
			const row = await one(c.env.DB, "SELECT * FROM plan_requests WHERE id = ? AND user_id = ?", requestId, user.id);
			if (!row) throw new HttpError(400, "Plan not found.");
			if (row.status !== "accepted") throw new HttpError(400, "Only an active plan can be changed.");
			const left = slotIndexOn(row, target);
			const right = slotIndexOn(row, other);
			if (left === null || right === null) throw new HttpError(400, "Pick two pending deliveries in this plan.");
			if (left === right) throw new HttpError(400, "Pick a different pending item to swap.");
			const order = slotOrder(row, planDays(row));
			[order[left], order[right]] = [order[right], order[left]];
			await run(c.env.DB, "UPDATE plan_requests SET slot_order = ? WHERE id = ?", JSON.stringify(order), row.id);
			return myRequests(c.env.DB, user.id);
		},
		{ auth: true },
	);

	// ---- support ----
	route("get", "/support/tickets/me", "support", "My support chats", async (c) => {
		const user = await currentUser(c);
		return (await many(c.env.DB, "SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC", user.id)).map((row) => ticketOut(row, user));
	}, { auth: true });

	route(
		"post",
		"/support/tickets",
		"support",
		"Raise a support chat",
		async (c) => {
			const body = await bodyOf(c);
			const kind = literal(body, "kind", TICKET_KINDS);
			const message = reqStr(body, "message", 3, 1000);
			const reason = optStr(body, "reason", 80);
			const orderId = optStr(body, "order_id");
			const planRequestId = optStr(body, "plan_request_id");
			const user = await currentUser(c);
			const db = c.env.DB;
			const textBody = message.trim();
			if (textBody.length < 3) throw new HttpError(400, "Write a short message about the issue.");
			let subject = "Other";
			let savedOrderId: unknown = null;
			let savedPlanId: unknown = null;
			if (kind === "order") {
				if (!orderId) throw new HttpError(400, "Select a recent order.");
				const order = await one(db, "SELECT * FROM juice_orders WHERE id = ?", orderId);
				if (!order || order.user_id !== user.id) throw new HttpError(400, "That order was not found.");
				const names = orderItems(order.items).map((item) => item.name).filter(Boolean).join(", ");
				subject = `Order · ${names || "Juice order"}`.slice(0, 240);
				savedOrderId = order.id;
			} else if (kind === "subscription") {
				if (!planRequestId) throw new HttpError(400, "Select a subscription.");
				const plan = await one(db, "SELECT * FROM plan_requests WHERE id = ?", planRequestId);
				if (!plan || plan.user_id !== user.id) throw new HttpError(400, "That subscription was not found.");
				subject = `Subscription · ${plan.plan_name}`.slice(0, 240);
				savedPlanId = plan.id;
			}
			const reasonText = (reason ?? "").trim().slice(0, 80);
			if (reasonText) subject = `${subject} · ${reasonText}`.slice(0, 240);
			const id = uuidHex();
			const received = reasonText ? `Issue received: ${reasonText}.` : "Issue received.";
			await db.batch([
				prep(db, "INSERT INTO support_tickets (id, user_id, kind, order_id, plan_request_id, subject, message, reason, status, started, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', FALSE, ?)", id, user.id, kind, savedOrderId, savedPlanId, subject, textBody, reasonText || null, nowIso()),
				prep(db, "INSERT INTO support_messages (id, ticket_id, sender, sender_name, body, created_at) VALUES (?, ?, 'customer', ?, ?, ?)", uuidHex(), id, personName(user) || "Customer", textBody, nowIso()),
				systemMessage(db, id, `${received} A support person will join shortly.`),
			]);
			return ticketDetail(db, (await getTicket(db, id))!, user);
		},
		{ auth: true, status: 201 },
	);

	route("get", "/support/tickets/:ticketId", "support", "One of my support chats", async (c) => {
		const user = await currentUser(c);
		return ticketDetail(c.env.DB, await getOwnedTicket(c.env.DB, c.req.param("ticketId"), user.id), user);
	}, { auth: true });

	route(
		"post",
		"/support/tickets/:ticketId/messages",
		"support",
		"Send a message in my chat",
		async (c) => {
			const messageBody = reqStr(await bodyOf(c), "body", 1, 1000);
			const user = await currentUser(c);
			try {
				const ticket = await getOwnedTicket(c.env.DB, c.req.param("ticketId"), user.id);
				return messageOut(await addMessage(c.env.DB, ticket, "customer", messageBody, user));
		} catch (error) {
				notFoundOr400(error);
			}
		},
		{ auth: true, status: 201 },
	);

	route(
		"post",
		"/support/tickets/:ticketId/rate",
		"support",
		"Rate a closed chat",
		async (c) => {
			const rating = reqNum(await bodyOf(c), "rating", { ge: 1, le: 5, integer: true });
			const user = await currentUser(c);
			try {
				const ticket = await getOwnedTicket(c.env.DB, c.req.param("ticketId"), user.id);
				if (ticket.status !== "closed") throw new HttpError(400, "You can rate the help after the chat ends.");
				await run(c.env.DB, "UPDATE support_tickets SET rating = ? WHERE id = ?", rating, ticket.id);
				return ticketDetail(c.env.DB, await getTicket(c.env.DB, String(ticket.id)), user);
		} catch (error) {
				notFoundOr400(error);
			}
		},
		{ auth: true },
	);

	route(
		"post",
		"/support/tickets/:ticketId/close",
		"support",
		"Close my chat",
		async (c) => {
			const user = await currentUser(c);
			const ticket = await getOwnedTicket(c.env.DB, c.req.param("ticketId"), user.id);
			return ticketDetail(c.env.DB, await closeTicket(c.env.DB, ticket), user);
		},
		{ auth: true },
	);

	// ---- admin: users and roles ----
	route("get", "/admin/users", "admin", "All users", async (c) => {
		await currentAdmin(c);
		const rows = await many(c.env.DB, "SELECT * FROM users ORDER BY created_at DESC");
		return Promise.all(rows.map((row) => adminUserOut(c.env.DB, row)));
	}, { auth: true });

	route(
		"patch",
		"/admin/users/:userId",
		"admin",
		"Update a user",
		async (c) => {
			const body = await bodyOf(c);
			const input = {
				name: optStr(body, "name", 120),
				phone: optStr(body, "phone", 20),
				email: optStr(body, "email", 255),
				username: optStr(body, "username", 255),
				role: optStr(body, "role", 32),
				location_address: optStr(body, "location_address", 500),
				location_locality: optStr(body, "location_locality", 160),
				special_access: optBool(body, "special_access"),
			};
			const admin = await currentAdmin(c);
			const db = c.env.DB;
			const user = await userById(db, c.req.param("userId"));
			if (!user) throw new HttpError(404, "User not found.");
			const next: Row = { ...user };
			if (input.name !== null) {
				const value = blank(input.name);
				if (value) next.name = value;
			}
			if (input.phone !== null) {
				const value = blank(input.phone);
				next.phone = value ? normalizePhone(value) : null;
			}
			if (input.email !== null) {
				let value = blank(input.email);
				if (value) {
					value = value.toLowerCase();
					if (await one(db, "SELECT id FROM users WHERE email = ? AND id != ?", value, user.id)) throw new HttpError(400, "That email is already in use.");
				}
				next.email = value;
			}
			if (input.username !== null) {
				const value = blank(input.username);
				if (value && (await one(db, "SELECT id FROM users WHERE username = ? AND id != ?", value, user.id))) throw new HttpError(400, "That username is already in use.");
				next.username = value;
			}
			if (input.role !== null) {
				const current = String(user.role || "customer");
				const role = (blank(input.role) || current).toLowerCase();
				if (!(await one(db, "SELECT name FROM roles WHERE name = ?", role))) throw new HttpError(400, "Choose a role from the Roles tab.");
				if (admin.id === user.id && role !== current) throw new HttpError(400, "You cannot change your own role.");
				if (user.role === "admin" && role !== "admin" && (await countUsers(db, "admin")) <= 1) throw new HttpError(400, "Keep at least one admin.");
				next.role = role;
			}
			if (input.location_address !== null) next.location_address = blank(input.location_address);
			if (input.location_locality !== null) next.location_locality = blank(input.location_locality);
			if (input.special_access !== null) Object.assign(next, specialAccessFields(next, input.special_access));
			await run(
				db,
				"UPDATE users SET name = ?, phone = ?, email = ?, username = ?, role = ?, location_address = ?, location_locality = ?, special_access = ?, special_lat = ?, special_lng = ? WHERE id = ?",
				next.name,
				next.phone,
				next.email,
				next.username,
				next.role,
				next.location_address,
				next.location_locality,
				bool(next.special_access) ? 1 : 0,
				next.special_lat,
				next.special_lng,
				user.id,
			);
			return adminUserOut(db, (await userById(db, user.id))!);
		},
		{ auth: true },
	);

	route("get", "/admin/roles", "admin", "All roles", async (c) => {
		await currentAdmin(c);
		await seedRoles(c.env.DB);
		const rows = await many(c.env.DB, "SELECT * FROM roles ORDER BY name ASC");
		return Promise.all(rows.map((row) => roleOut(c.env.DB, row)));
	}, { auth: true });

	route(
		"post",
		"/admin/roles",
		"admin",
		"Create a role",
		async (c) => {
			const body = await bodyOf(c);
			const name = reqStr(body, "name", 2, 32);
			const description = optStr(body, "description", 240, "") ?? "";
			await currentAdmin(c);
			const key = name.trim().toLowerCase().replaceAll(" ", "_");
			if (!ROLE_NAME.test(key)) throw new HttpError(400, "Use a short role name like delivery or staff.");
			if (await one(c.env.DB, "SELECT name FROM roles WHERE name = ?", key)) throw new HttpError(400, "That role already exists.");
			await run(c.env.DB, "INSERT INTO roles (name, description, pages, created_at) VALUES (?, ?, '[]', ?)", key, description.trim(), nowIso());
			return roleOut(c.env.DB, (await one(c.env.DB, "SELECT * FROM roles WHERE name = ?", key))!);
		},
		{ auth: true, status: 201 },
	);

	route(
		"patch",
		"/admin/roles/:name",
		"admin",
		"Update a role",
		async (c) => {
			const body = await bodyOf(c);
			const description = optStr(body, "description", 240);
			const pages = body.pages === undefined || body.pages === null ? null : listField(body, "pages");
			await currentAdmin(c);
		const name = c.req.param("name");
		const row = await one(c.env.DB, "SELECT * FROM roles WHERE name = ?", name);
			if (!row) throw new HttpError(404, "Role not found.");
			if (description !== null) await run(c.env.DB, "UPDATE roles SET description = ? WHERE name = ?", description.trim(), name);
			if (pages !== null) await run(c.env.DB, "UPDATE roles SET pages = ? WHERE name = ?", JSON.stringify(name === "admin" ? ADMIN_PAGES : readPages(JSON.stringify(pages))), name);
			return roleOut(c.env.DB, (await one(c.env.DB, "SELECT * FROM roles WHERE name = ?", name))!);
		},
		{ auth: true },
	);

	route(
		"delete",
		"/admin/roles/:name",
		"admin",
		"Delete a role",
		async (c) => {
			await currentAdmin(c);
		const name = c.req.param("name");
			if (SYSTEM_ROLES.includes(name)) throw new HttpError(400, "System roles cannot be deleted.");
			if (!(await one(c.env.DB, "SELECT name FROM roles WHERE name = ?", name))) throw new HttpError(404, "Role not found.");
			if (await countUsers(c.env.DB, name)) throw new HttpError(400, "Reassign users before deleting this role.");
		await run(c.env.DB, "DELETE FROM roles WHERE name = ?", name);
			return { ok: true };
		},
		{ auth: true },
	);

	route("get", "/admin/stats", "admin", "Dashboard numbers", async (c) => {
		await currentAdmin(c);
		const db = c.env.DB;
		const users = await many(db, "SELECT role, provider, location_lat FROM users");
		const juices = await many(db, "SELECT archived FROM juices");
		const plans = await one(db, "SELECT COUNT(*) AS total FROM plans");
		const counts = await requestCounts(db);
		const orders = await many(db, "SELECT status FROM juice_orders");
		const marks = await many(db, "SELECT status FROM delivery_marks WHERE delivery_date = ?", todayIso());
		return {
			users: users.length,
			admins: users.filter((row) => row.role === "admin").length,
			customers: users.filter((row) => row.role !== "admin").length,
			google: users.filter((row) => row.provider === "google").length,
			password: users.filter((row) => row.provider !== "google").length,
			with_location: users.filter((row) => row.location_lat != null).length,
			juices: juices.length,
			visible_juices: juices.filter((row) => !bool(row.archived)).length,
			archived_juices: juices.filter((row) => bool(row.archived)).length,
			catalog_plans: num(plans?.total),
			...counts,
			delivered_today: marks.filter((row) => row.status === "delivered").length,
			not_delivered_today: marks.filter((row) => row.status === "not_delivered").length,
			pending_delivery_today: marks.filter((row) => row.status === "pending" || row.status === "picked").length,
			orders: orders.length,
			placed_orders: orders.filter((row) => row.status === "placed").length,
			open_orders: orders.filter((row) => row.status === "placed" || row.status === "confirmed").length,
		};
	}, { auth: true });

	// ---- admin: orders and plan requests ----
	route("get", "/admin/orders", "admin", "All orders", async (c) => {
		await currentAdmin(c);
		const status = c.req.query("status_filter");
		const rows = status && ORDER_STATUSES.includes(status) ? await many(c.env.DB, "SELECT * FROM juice_orders WHERE status = ? ORDER BY created_at DESC", status) : await many(c.env.DB, "SELECT * FROM juice_orders ORDER BY created_at DESC");
		const result = [];
		for (const row of rows) result.push(adminOrderOut(row, await userById(c.env.DB, row.user_id)));
		return result;
	}, { auth: true, query: ["status_filter"] });

	route(
		"patch",
		"/admin/orders/:orderId",
		"admin",
		"Update an order",
		async (c) => {
			const body = await bodyOf(c);
			const status = body.status === undefined || body.status === null ? null : literal(body, "status", ORDER_STATUSES);
			const proofInput = optStr(body, "proof_image");
			await currentAdmin(c);
			const db = c.env.DB;
			const proof = proofInput ? await normalizeStoredImage(db, proofInput) : proofInput;
			const row = await one(db, "SELECT * FROM juice_orders WHERE id = ?", c.req.param("orderId"));
			if (!row) throw new HttpError(404, "Order not found.");
			if (status === null && proof === null) throw new HttpError(400, "Nothing to update.");
			if (status !== null) await run(db, "UPDATE juice_orders SET status = ? WHERE id = ?", status, row.id);
			if (proof !== null) await run(db, "UPDATE juice_orders SET proof_image = ? WHERE id = ?", proof || null, row.id);
			const updated = (await one(db, "SELECT * FROM juice_orders WHERE id = ?", row.id))!;
			return adminOrderOut(updated, await userById(db, updated.user_id));
		},
		{ auth: true },
	);

	route("get", "/admin/plan-requests", "admin", "All plan requests", async (c) => {
		await currentAdmin(c);
		const status = c.req.query("status_filter");
		const rows = status ? await many(c.env.DB, "SELECT * FROM plan_requests WHERE status = ? ORDER BY created_at DESC", status) : await many(c.env.DB, "SELECT * FROM plan_requests ORDER BY created_at DESC");
		const result = [];
		for (const row of rows) result.push(adminRequestOut(row, await userById(c.env.DB, row.user_id)));
		return result;
	}, { auth: true, query: ["status_filter"] });

	const decide = async (c: Ctx, accept: boolean) => {
		await currentAdmin(c);
		const db = c.env.DB;
		const row = await one(db, "SELECT * FROM plan_requests WHERE id = ?", c.req.param("requestId"));
		if (!row) throw new HttpError(404, "Request not found.");
		if (row.status !== "pending") throw new HttpError(409, `Request is already ${row.status}.`);
		if (accept) {
			const current = await latestRequest(db, row.user_id, "accepted");
			const mode = String(row.upgrade_mode || "");
			const tomorrow = addDays(todayIso(), 1);
			let start = parseDate(row.starts_on) ?? tomorrow;
			if (current) {
				const [currentStart, currentEnd] = planWindow(current);
				if (mode === "after_end") start = parseDate(row.starts_on) ?? addDays(currentEnd, 1);
				else if (mode === "from_flow" && start < currentStart) start = currentStart;
			}
			await run(db, "UPDATE plan_requests SET starts_on = ?, ends_on = ?, status = 'accepted', decided_at = ? WHERE id = ?", start, addDays(start, planDays(row) - 1), nowIso(), row.id);
		} else {
			await run(db, "UPDATE plan_requests SET status = 'rejected', decided_at = ? WHERE id = ?", nowIso(), row.id);
		}
		const updated = (await one(db, "SELECT * FROM plan_requests WHERE id = ?", row.id))!;
		return adminRequestOut(updated, await userById(db, updated.user_id));
	};
	route("post", "/admin/plan-requests/:requestId/accept", "admin", "Accept a plan request", (c) => decide(c, true), { auth: true });
	route("post", "/admin/plan-requests/:requestId/reject", "admin", "Reject a plan request", (c) => decide(c, false), { auth: true });
	route(
		"post",
		"/admin/plan-requests/:requestId/cancel",
		"admin",
		"Cancel an active subscription",
		async (c) => {
			await currentAdmin(c);
			const db = c.env.DB;
			const row = await one(db, "SELECT * FROM plan_requests WHERE id = ?", c.req.param("requestId"));
			if (!row) throw new HttpError(404, "Request not found.");
			if (row.status !== "accepted") throw new HttpError(409, "Only an active plan can be cancelled.");
			const today = todayIso();
			const [start] = planWindow(row);
			await run(db, "UPDATE plan_requests SET status = 'cancelled_admin', decided_at = ?, ends_on = ? WHERE id = ?", nowIso(), start <= today ? today : start, row.id);
			const updated = (await one(db, "SELECT * FROM plan_requests WHERE id = ?", row.id))!;
			return adminRequestOut(updated, await userById(db, updated.user_id));
		},
		{ auth: true },
	);

	route("get", "/admin/delivery-marks", "admin", "Delivery marks for dates", async (c) => {
		await currentAdmin(c);
		const wanted = (c.req.query("dates") ?? "").split(",").map((part) => part.trim()).filter(Boolean).map((value) => value.slice(0, 10));
		if (!wanted.length) return [];
		const rows = await many(c.env.DB, `SELECT * FROM delivery_marks WHERE delivery_date IN (${wanted.map(() => "?").join(",")})`, ...wanted);
		return rows.map((row) => ({ id: String(row.id), user_id: String(row.user_id), delivery_date: String(row.delivery_date), status: String(row.status) }));
	}, { auth: true, query: ["dates"] });

	route(
		"post",
		"/admin/delivery-marks",
		"admin",
		"Mark a delivery",
		async (c) => {
			const body = await bodyOf(c);
			const userId = reqStr(body, "user_id", 1, 64);
			const date = reqStr(body, "date", 10, 10).slice(0, 10);
			const status = literal(body, "status", MARK_STATUSES);
			await currentAdmin(c);
			const db = c.env.DB;
			await run(db, "INSERT INTO delivery_marks (id, user_id, delivery_date, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, delivery_date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at", uuid(), userId, date, status, nowIso());
			const row = (await one(db, "SELECT * FROM delivery_marks WHERE user_id = ? AND delivery_date = ?", userId, date))!;
			return { id: String(row.id), user_id: String(row.user_id), delivery_date: String(row.delivery_date), status: String(row.status) };
		},
		{ auth: true },
	);

	// ---- admin: catalog ----
	route("get", "/admin/juices", "admin", "All juices", async (c) => {
		await currentAdmin(c);
		return (await listJuices(c.env.DB, null)).map(juiceOut);
	}, { auth: true });

	const readJuice = (body: Body) => ({
		name: reqStr(body, "name"),
		category: optStr(body, "category", undefined, "Juices") ?? "Juices",
		sku: optStr(body, "sku"),
		price: optNum(body, "price", { fallback: 0 }) ?? 0,
		description: optStr(body, "description"),
		image_url: optStr(body, "image_url"),
		in_poster: optBool(body, "in_poster") ?? false,
		in_plans: optBool(body, "in_plans") ?? true,
		offer_percent: optNum(body, "offer_percent", { ge: 0, le: 90, fallback: 0 }) ?? 0,
	});

	route(
		"post",
		"/admin/juices",
		"admin",
		"Create a juice",
		async (c) => {
			const input = readJuice(await bodyOf(c));
			await currentAdmin(c);
			const db = c.env.DB;
			const name = input.name.trim() || "Untitled juice";
			const category = input.category.trim() || "Juices";
			const id = uuid();
			await run(
				db,
				`INSERT INTO juices (id, name, category, sku, price, description, image_url, archived, in_poster, in_plans, offer_percent, ml, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ${sqlBool(input.in_poster)}, ${sqlBool(input.in_plans)}, ?, ?, ?)`,
				id,
				name,
				category,
				input.sku?.trim() || null,
				input.price,
				input.description?.trim() || null,
				await normalizeStoredImage(db, input.image_url),
				input.offer_percent,
				mlFromName(name),
				nowIso(),
			);
			await ensureCategory(db, category);
			return juiceOut(await juiceById(db, id), { in_poster: input.in_poster, in_plans: input.in_plans });
		},
		{ auth: true, status: 201 },
	);

	route("get", "/admin/juices/export", "admin", "Export the menu", async (c) => {
		await currentAdmin(c);
		return { version: 1, juices: (await listJuices(c.env.DB, null)).map(juiceOut), categories: await categoryNames(c.env.DB) };
	}, { auth: true });

	route("post", "/admin/juices/import", "admin", "Import a menu", async (c) => {
		const body = await bodyOf(c);
		const items = listField(body, "juices");
		if (items.length > 1000) throw new HttpError(400, "Import at most 1000 juices at a time.");
		const categories = listField(body, "categories", []).map((name, index) => {
			if (typeof name !== "string") invalid(`categories.${index}`, "Input should be a valid string", name);
			return name;
		});
		await currentAdmin(c);
		const db = c.env.DB;
		let created = 0;
		let updated = 0;
		for (const [index, item] of items.entries()) {
			const input = menuJuice(item, index);
			const id = input.id || uuid();
			const existing = await one(db, "SELECT id FROM juices WHERE id = ?", id);
			const image = await normalizeStoredImage(db, input.image_url);
			if (existing) {
				await run(
					db,
					`UPDATE juices SET name = ?, category = ?, sku = ?, price = ?, description = ?, image_url = ?, archived = ${sqlBool(input.archived)}, in_poster = ${sqlBool(input.in_poster)}, in_plans = ${sqlBool(input.in_plans)}, offer_percent = ?, ml = ? WHERE id = ?`,
					input.name,
					input.category,
					input.sku,
					input.price,
					input.description,
					image,
					input.offer_percent,
					mlFromName(input.name),
					id,
				);
				updated += 1;
			} else {
				await run(
					db,
					`INSERT INTO juices (id, name, category, sku, price, description, image_url, archived, in_poster, in_plans, offer_percent, ml, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${sqlBool(input.archived)}, ${sqlBool(input.in_poster)}, ${sqlBool(input.in_plans)}, ?, ?, ?)`,
					id,
					input.name,
					input.category,
					input.sku,
					input.price,
					input.description,
					image,
					input.offer_percent,
					mlFromName(input.name),
					input.created_at || nowIso(),
				);
				created += 1;
			}
			await ensureCategory(db, input.category);
		}
		const names = categories.length ? await applyCategoryOrder(db, categories) : await categoryNames(db);
		return { imported: created + updated, created, updated, categories: names };
	}, { auth: true });

	route("post", "/admin/juices/upload", "admin", "Upload a juice image", async (c) => {
		const dataUrl = reqStr(await bodyOf(c), "data_url");
		await currentAdmin(c);
		const url = await normalizeStoredImage(c.env.DB, dataUrl);
		if (url === null) throw new HttpError(400, "Choose an image to upload.");
		return { url };
	}, { auth: true });

	route(
		"patch",
		"/admin/juices/:juiceId",
		"admin",
		"Update a juice",
		async (c) => {
			const input = readJuice(await bodyOf(c));
			await currentAdmin(c);
			const db = c.env.DB;
			const juice = await juiceById(db, c.req.param("juiceId"));
			const name = input.name.trim() || String(juice.name);
			const category = input.category.trim() || "Juices";
			await run(
				db,
				`UPDATE juices SET name = ?, category = ?, sku = ?, price = ?, description = ?, image_url = ?, in_poster = ${sqlBool(input.in_poster)}, in_plans = ${sqlBool(input.in_plans)}, offer_percent = ?, ml = ? WHERE id = ?`,
				name,
				category,
				input.sku?.trim() || null,
				input.price,
				input.description?.trim() || null,
				await normalizeStoredImage(db, input.image_url),
				input.offer_percent,
				mlFromName(name),
				juice.id,
			);
			await ensureCategory(db, category);
			return juiceOut(await juiceById(db, String(juice.id)), { in_poster: input.in_poster, in_plans: input.in_plans });
		},
		{ auth: true },
	);

	route(
		"patch",
		"/admin/juices/:juiceId/options",
		"admin",
		"Update juice price and visibility",
		async (c) => {
			const body = await bodyOf(c);
			const price = optNum(body, "price", { ge: 0 });
			const inPoster = optBool(body, "in_poster");
			const inPlans = optBool(body, "in_plans");
			const offer = optNum(body, "offer_percent", { ge: 0, le: 90 });
			await currentAdmin(c);
			const juice = await juiceById(c.env.DB, c.req.param("juiceId"));
			const nextPoster = inPoster ?? bool(juice.in_poster);
			const nextPlans = inPlans ?? (juice.in_plans == null ? true : bool(juice.in_plans));
			await run(
				c.env.DB,
				`UPDATE juices SET price = ?, in_poster = ${sqlBool(nextPoster)}, in_plans = ${sqlBool(nextPlans)}, offer_percent = ? WHERE id = ?`,
				price ?? juice.price,
				offer ?? juice.offer_percent,
				juice.id,
			);
			return juiceOut(await juiceById(c.env.DB, String(juice.id)), { in_poster: nextPoster, in_plans: nextPlans });
		},
		{ auth: true },
	);

	const setArchived = async (c: Ctx, archived: boolean) => {
		await currentAdmin(c);
		const juice = await juiceById(c.env.DB, c.req.param("juiceId"));
		await run(c.env.DB, "UPDATE juices SET archived = ? WHERE id = ?", archived ? 1 : 0, juice.id);
		return juiceOut(await juiceById(c.env.DB, String(juice.id)));
	};
	route("post", "/admin/juices/:juiceId/archive", "admin", "Hide a juice", (c) => setArchived(c, true), { auth: true });
	route("post", "/admin/juices/:juiceId/restore", "admin", "Show a juice again", (c) => setArchived(c, false), { auth: true });
	route("delete", "/admin/juices/:juiceId", "admin", "Delete a juice", async (c) => {
		await currentAdmin(c);
		const juice = await juiceById(c.env.DB, c.req.param("juiceId"));
		await run(c.env.DB, "DELETE FROM juices WHERE id = ?", juice.id);
		return { ok: true };
	}, { auth: true });

	route("get", "/admin/categories", "admin", "Category order", async (c) => {
		await currentAdmin(c);
		return { names: await categoryNames(c.env.DB) };
	}, { auth: true });

	route("put", "/admin/categories/order", "admin", "Reorder categories", async (c) => {
		const names = listField(await bodyOf(c), "names").map((name, index) => {
			if (typeof name !== "string") invalid(`names.${index}`, "Input should be a valid string", name);
			return name;
		});
		await currentAdmin(c);
		return { names: await applyCategoryOrder(c.env.DB, names) };
	}, { auth: true });

	route("get", "/admin/plans", "admin", "All plans", async (c) => {
		await currentAdmin(c);
		return (await listPlans(c.env.DB)).map(planOut);
	}, { auth: true });

	const readPlan = (body: Body) => {
		const items = listField(body, "items", []).map((item, index) => {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const id = planItemId(item);
				if (!id) invalid(`items.${index}.id`, "Input should be a valid string", item);
				return id;
			}
			if (typeof item !== "string" && typeof item !== "number") invalid(`items.${index}`, "Input should be a valid string", item);
			return String(item).trim();
		}).filter(Boolean);
		const qtysRaw = body.item_qtys;
		const qtys: Record<string, number> = {};
		if (qtysRaw && typeof qtysRaw === "object" && !Array.isArray(qtysRaw)) {
			for (const [id, value] of Object.entries(qtysRaw as Record<string, unknown>)) {
				const qty = Number(value);
				if (id.trim() && Number.isFinite(qty)) qtys[id.trim()] = Math.max(1, Math.min(99, Math.round(qty)));
			}
		}
		return {
			name: reqStr(body, "name"),
			duration: optStr(body, "duration", undefined, "30") ?? "30",
			unit: optStr(body, "unit", undefined, "days") ?? "days",
			price: optStr(body, "price", undefined, "₹0") ?? "₹0",
			period: optStr(body, "period") ?? "",
			description: optStr(body, "description", undefined, "") ?? "",
			color: optStr(body, "color", undefined, "#FF7A00") ?? "#FF7A00",
			image: optStr(body, "image", undefined, "") ?? "",
			bottles: optStr(body, "bottles", undefined, "") ?? "",
			popular: optBool(body, "popular") ?? false,
			position: optNum(body, "position", { integer: true }),
			items,
			itemQtys: qtys,
		};
	};

	route(
		"post",
		"/admin/plans",
		"admin",
		"Create a plan",
		async (c) => {
			const input = readPlan(await bodyOf(c));
			await currentAdmin(c);
			const db = c.env.DB;
			const id = uuid();
			const position = input.position ?? num((await one(db, "SELECT MAX(position) AS top FROM plans"))?.top, -1) + 1;
			await run(
				db,
				"INSERT INTO plans (id, name, duration, unit, price, period, description, color, image, bottles, popular, position, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				input.name.trim() || "Plan",
				input.duration.trim() || "30",
				input.unit.trim() || "days",
				input.price.trim() || "₹0",
				input.period.trim() || `${input.duration} ${input.unit}`,
				input.description.trim(),
				input.color.trim() || "#FF7A00",
				input.image.trim(),
				input.bottles.trim(),
				input.popular ? 1 : 0,
				position,
				encodePlanItems(input.items, input.itemQtys),
			);
			return planOut((await one(db, "SELECT * FROM plans WHERE id = ?", id))!);
		},
		{ auth: true, status: 201 },
	);

	route(
		"patch",
		"/admin/plans/:planId",
		"admin",
		"Update a plan",
		async (c) => {
			const input = readPlan(await bodyOf(c));
			await currentAdmin(c);
			const db = c.env.DB;
			const plan = await one(db, "SELECT * FROM plans WHERE id = ?", c.req.param("planId"));
			if (!plan) throw new HttpError(404, "Plan not found.");
			await run(
				db,
				"UPDATE plans SET name = ?, duration = ?, unit = ?, price = ?, period = ?, description = ?, color = ?, image = ?, bottles = ?, popular = ?, position = ?, items = ? WHERE id = ?",
				input.name.trim() || plan.name,
				input.duration.trim() || plan.duration,
				input.unit.trim() || plan.unit,
				input.price.trim() || plan.price,
				input.period.trim() || plan.period,
				input.description.trim(),
				input.color.trim() || plan.color,
				input.image.trim(),
				input.bottles.trim(),
				input.popular ? 1 : 0,
				input.position ?? plan.position,
				encodePlanItems(input.items, input.itemQtys),
				plan.id,
			);
			return planOut((await one(db, "SELECT * FROM plans WHERE id = ?", plan.id))!);
		},
		{ auth: true },
	);

	route("delete", "/admin/plans/:planId", "admin", "Delete a plan", async (c) => {
		await currentAdmin(c);
		const plan = await one(c.env.DB, "SELECT id FROM plans WHERE id = ?", c.req.param("planId"));
		if (!plan) throw new HttpError(404, "Plan not found.");
		await run(c.env.DB, "DELETE FROM plans WHERE id = ?", plan.id);
		return { ok: true };
	}, { auth: true });

	// ---- admin: store ----
	route("get", "/admin/store", "admin", "Store settings", async (c) => {
		await currentAdmin(c);
		return storeOut(await storeRow(c.env.DB));
	}, { auth: true });

	route("patch", "/admin/store", "admin", "Update the store", async (c) => {
		const body = await bodyOf(c);
		const name = reqStr(body, "name", 1, 160);
		const address = optStr(body, "address", 500, "") ?? "";
		const locality = optStr(body, "locality", 160, "") ?? "";
		const latitude = reqNum(body, "latitude");
		const longitude = reqNum(body, "longitude");
		const distance = optNum(body, "distance_km", { ge: 0.5, le: 200, fallback: 10 }) ?? 10;
		await currentAdmin(c);
		await storeRow(c.env.DB);
		await run(c.env.DB, "UPDATE store_settings SET name = ?, address = ?, locality = ?, latitude = ?, longitude = ?, distance_km = ? WHERE id = ?", name.trim() || "CrocoSip Store", address.trim(), locality.trim(), latitude, longitude, Math.max(0.5, Math.min(200, distance)), STORE_ID);
		return storeOut(await storeRow(c.env.DB));
	}, { auth: true });

	route("patch", "/admin/store/discount", "admin", "Update the custom plan discount", async (c) => {
		const percent = reqNum(await bodyOf(c), "custom_discount_percent", { ge: 0, le: 90 });
		await currentAdmin(c);
		await storeRow(c.env.DB);
		await run(c.env.DB, "UPDATE store_settings SET custom_discount_percent = ? WHERE id = ?", Math.max(0, Math.min(90, percent)), STORE_ID);
		return storeOut(await storeRow(c.env.DB));
	}, { auth: true });

	route("patch", "/admin/store/cart-min", "admin", "Update the minimum cart order", async (c) => {
		const amount = reqNum(await bodyOf(c), "cart_min_order", { ge: 0, le: 10000 });
		await currentAdmin(c);
		await storeRow(c.env.DB);
		await run(c.env.DB, "UPDATE store_settings SET cart_min_order = ? WHERE id = ?", Math.max(0, Math.min(10000, Math.round(amount * 100) / 100)), STORE_ID);
		return storeOut(await storeRow(c.env.DB));
	}, { auth: true });

	route("patch", "/admin/store/delivery-options", "admin", "Show or hide cart delivery options", async (c) => {
		const body = await bodyOf(c);
		const showInstant = optBool(body, "show_delivery_instant");
		const showSlot = optBool(body, "show_delivery_slot");
		await currentAdmin(c);
		const store = await storeRow(c.env.DB);
		const nextInstant = showInstant ?? (store.show_delivery_instant == null ? true : bool(store.show_delivery_instant));
		const nextSlot = showSlot ?? (store.show_delivery_slot == null ? true : bool(store.show_delivery_slot));
		if (!nextInstant && !nextSlot) throw new HttpError(400, "Keep at least one delivery option visible.");
		const slots = slotsForStore(store).map((item) => {
			if (item.kind === "instant") return { ...item, visible: nextInstant };
			if (item.kind === "next_day" && item.id === "next_day") return { ...item, visible: nextSlot };
			return item;
		});
		await run(
			c.env.DB,
			`UPDATE store_settings SET show_delivery_instant = ${sqlBool(nextInstant)}, show_delivery_slot = ${sqlBool(nextSlot)}, delivery_slots = ? WHERE id = ?`,
			JSON.stringify(slots),
			STORE_ID,
		);
		return storeOut(await storeRow(c.env.DB));
	}, { auth: true });

	route("patch", "/admin/store/delivery-slots", "admin", "Create cart delivery slots", async (c) => {
		const body = await bodyOf(c);
		await currentAdmin(c);
		await storeRow(c.env.DB);
		const slots = normalizeDeliverySlots(listField(body, "slots", []));
		const bookable = slots.filter((item) => item.visible !== false && String(item.kind) !== "holiday");
		if (!bookable.length) throw new HttpError(400, "Keep at least one bookable slot visible.");
		const showInstant = slots.some((item) => item.visible !== false && item.kind === "instant");
		const showSlot = slots.some((item) => item.visible !== false && ["today", "next_day", "pre", "book"].includes(String(item.kind)));
		await run(
			c.env.DB,
			`UPDATE store_settings SET show_delivery_instant = ${sqlBool(showInstant)}, show_delivery_slot = ${sqlBool(showSlot)}, delivery_slots = ? WHERE id = ?`,
			JSON.stringify(slots),
			STORE_ID,
		);
		return storeOut(await storeRow(c.env.DB));
	}, { auth: true });

	// ---- admin: payments ----
	route("get", "/admin/wallet/ledger", "admin", "Wallet ledger", async (c) => {
		await currentAdmin(c);
		const rows = await many(c.env.DB, "SELECT * FROM wallet_entries ORDER BY created_at DESC LIMIT 50");
		const users = new Map<string, Row>();
		for (const row of rows) {
			const userId = String(row.user_id);
			if (!users.has(userId)) {
				const person = await userById(c.env.DB, userId);
				if (person) users.set(userId, person);
			}
		}
		return rows.map((row) => walletEntryOut(row, users.get(String(row.user_id)) ?? null));
	}, { auth: true });

	route("post", "/admin/wallet/credit", "admin", "Add wallet money", async (c) => {
		const admin = await currentAdmin(c);
		const body = await bodyOf(c);
		const identifier = reqStr(body, "identifier", 1, 255);
		const amount = reqNum(body, "amount", { ge: 0.01 });
		const note = optStr(body, "note", 240);
		return creditWallet(c.env.DB, identifier, amount, note, String(admin.id));
	}, { auth: true });

	route("get", "/admin/payments", "admin", "Razorpay transactions", async (c) => {
		await currentAdmin(c);
		try {
			const result = await razorpay(c.env, "/payments?count=100");
			if (!result.ok) raiseApi(result);
			let captured = 0;
			const items = (Array.isArray(result.data.items) ? (result.data.items as Row[]) : []).map((row) => {
				const amount = Math.trunc(num(row.amount));
				const status = String(row.status ?? "");
				if (status === "captured") captured += amount;
				const error = row.error_description || row.error_reason;
				return {
					id: String(row.id ?? ""),
					order_id: text(row.order_id),
					utr: utrOf(row.acquirer_data),
					amount,
					currency: String(row.currency || "INR"),
					status,
					method: text(row.method),
					email: text(row.email),
					contact: text(row.contact),
					vpa: text(row.vpa),
					description: text(row.description),
					error: error ? String(error) : null,
					amount_refunded: Math.trunc(num(row.amount_refunded)),
					refund_status: text(row.refund_status),
					created_at: unixIso(row.created_at),
				};
			});
			return { count: items.length, captured_amount: captured, items };
		} catch (error) {
			paymentError(error);
		}
	}, { auth: true });

	route("get", "/admin/payments/:paymentId/refunds", "admin", "Refund timeline", async (c) => {
		await currentAdmin(c);
		try {
			return await refundTimeline(c.env, c.req.param("paymentId"));
		} catch (error) {
			paymentError(error);
		}
	}, { auth: true });

	route("post", "/admin/payments/:paymentId/refund", "admin", "Refund a captured payment", async (c) => {
		await currentAdmin(c);
		try {
			const paymentId = c.req.param("paymentId").trim();
			if (!paymentId.startsWith("pay_")) throw new HttpError(400, "This payment cannot be refunded.");
			const paymentResult = await razorpay(c.env, `/payments/${encodeURIComponent(paymentId)}`);
			if (!paymentResult.ok) raiseGateway(paymentResult, "Could not load this payment.");
			const payment = paymentResult.data;
			const status = String(payment.status ?? "");
			const amount = Math.trunc(num(payment.amount));
			const refunded = Math.trunc(num(payment.amount_refunded));
			if (status === "refunded" || (amount && refunded >= amount)) throw new HttpError(400, "This payment is already refunded.");
			if (status !== "captured") throw new HttpError(400, "Only a captured payment can be refunded.");
			const remaining = amount - refunded;
			if (remaining < 100) throw new HttpError(400, "Nothing is left to refund.");
			const refundResult = await razorpay(c.env, `/payments/${encodeURIComponent(paymentId)}/refund`, "POST", { amount: remaining });
			if (!refundResult.ok) raiseGateway(refundResult, "Could not refund this payment.");
			const refundStatus = String(refundResult.data.status || "processed");
			await markOrdersRefundStatus(c.env.DB, paymentId, refundStatusFromRefund(refundStatus, payment));
			return { id: String(refundResult.data.id ?? ""), payment_id: paymentId, amount: Math.trunc(num(refundResult.data.amount, remaining)), status: refundStatus };
		} catch (error) {
			paymentError(error);
		}
	}, { auth: true });

	// ---- admin: support ----
	route("get", "/admin/support-assignees", "admin", "People who can take chats", async (c) => {
		await currentAdmin(c);
		const people = [];
		for (const row of await many(c.env.DB, "SELECT * FROM users ORDER BY name ASC")) {
			if (!(await pagesFor(c.env.DB, row)).length) continue;
			people.push({ id: String(row.id), name: personName(row) || "Support" });
		}
		return people;
	}, { auth: true });

	route("get", "/admin/support-tickets", "admin", "All support chats", async (c) => {
		await currentAdmin(c);
		const result = [];
		for (const row of await many(c.env.DB, "SELECT * FROM support_tickets ORDER BY created_at DESC")) result.push(ticketOut(row, await userById(c.env.DB, row.user_id)));
		return result;
	}, { auth: true });

	route("get", "/admin/support-tickets/:ticketId", "admin", "One support chat", async (c) => {
		await currentAdmin(c);
		const ticket = await getTicket(c.env.DB, c.req.param("ticketId"));
		return ticketDetail(c.env.DB, ticket, await userById(c.env.DB, ticket.user_id));
	}, { auth: true });

	route(
		"post",
		"/admin/support-tickets/:ticketId/messages",
		"admin",
		"Reply in a support chat",
		async (c) => {
			const messageBody = reqStr(await bodyOf(c), "body", 1, 1000);
			const admin = await currentAdmin(c);
			try {
				const ticket = await getTicket(c.env.DB, c.req.param("ticketId"));
				return messageOut(await addMessage(c.env.DB, ticket, "support", messageBody, admin));
			} catch (error) {
				notFoundOr400(error);
			}
		},
		{ auth: true, status: 201 },
	);

	route("post", "/admin/support-tickets/:ticketId/close", "admin", "Close a support chat", async (c) => {
		await currentAdmin(c);
		const ticket = await closeTicket(c.env.DB, await getTicket(c.env.DB, c.req.param("ticketId")));
		return ticketDetail(c.env.DB, ticket, await userById(c.env.DB, ticket.user_id));
	}, { auth: true });

	const assignee = async (c: Ctx): Promise<Row> => {
		const person = await userById(c.env.DB, reqStr(await bodyOf(c), "user_id", 1, 64));
		if (!person) throw new HttpError(400, "Choose a support person.");
		return person;
	};

	route("post", "/admin/support-tickets/:ticketId/start", "admin", "Start a support chat", async (c) => {
		await currentAdmin(c);
		const db = c.env.DB;
		try {
			const ticket = await getTicket(db, c.req.param("ticketId"));
			const person = await assignee(c);
			if (ticket.status === "closed") throw new HttpError(400, "This chat is closed.");
			if (bool(ticket.started)) throw new HttpError(400, "This chat has already started.");
			if (!(await pagesFor(db, person)).length) throw new HttpError(400, "Choose a support person.");
			const name = personName(person) || "Support";
			await db.batch([
				prep(db, "UPDATE support_tickets SET assignee_id = ?, assignee_name = ?, started = TRUE, status = 'open' WHERE id = ?", person.id, name, ticket.id),
				systemMessage(db, ticket.id, `${name} joined the chat`),
			]);
			const updated = await getTicket(db, String(ticket.id));
			return ticketDetail(db, updated, await userById(db, updated.user_id));
		} catch (error) {
			notFoundOr400(error);
		}
	}, { auth: true });

	route("post", "/admin/support-tickets/:ticketId/assign", "admin", "Hand a chat to someone else", async (c) => {
		await currentAdmin(c);
		const db = c.env.DB;
		try {
			const ticket = await getTicket(db, c.req.param("ticketId"));
			const person = await assignee(c);
			if (ticket.status !== "open") throw new HttpError(400, "This chat is closed.");
			if (!(await pagesFor(db, person)).length) throw new HttpError(400, "Choose a support person.");
			await run(db, "UPDATE support_tickets SET assignee_id = ?, assignee_name = ? WHERE id = ?", person.id, personName(person) || "Support", ticket.id);
			const updated = await getTicket(db, String(ticket.id));
			return ticketDetail(db, updated, await userById(db, updated.user_id));
		} catch (error) {
			notFoundOr400(error);
		}
	}, { auth: true });
}
