import postgres from "postgres";

export const DB_SCHEMA = "Crocosip_mobile_app";

export type PostgresEnv = {
	POSTGRES_HOST?: string;
	POSTGRES_PORT?: string;
	POSTGRES_USER?: string;
	POSTGRES_PASSWORD?: string;
	POSTGRES_DB?: string;
	POSTGRES_SSLMODE?: string;
	POSTGRES_CA_CERT?: string;
	DATABASE_URL?: string;
	HYPERDRIVE?: { connectionString: string };
};

type Row = Record<string, unknown>;
type Sql = postgres.Sql | postgres.TransactionSql;
type Result<T> = { results: T[]; success: true; meta: Record<string, never> };

export const APP_TABLES = [
	"roles",
	"users",
	"saved_addresses",
	"juices",
	"juice_categories",
	"store_settings",
	"plans",
	"plan_requests",
	"juice_orders",
	"wallet_entries",
	"support_tickets",
	"support_messages",
	"phone_otps",
	"delivery_marks",
	"uploads",
	"upload_chunks",
];
const TABLE_REF = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)(\\s+)(${APP_TABLES.join("|")})\\b`, "gi");
const INSERT_OR_IGNORE = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi;
// int8 and numeric arrive as strings from postgres.js.
const NUMERIC_TYPES = new Set([20, 1700]);
const BOOL_TYPE = 16;
const BOOL_KEYS = new Set([
	"archived",
	"in_poster",
	"in_plans",
	"popular",
	"special_access",
	"started",
	"show_delivery_instant",
	"show_delivery_slot",
]);

function asBool(value: unknown): boolean {
	if (value === true || value === 1) return true;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return normalized === "1" || normalized === "t" || normalized === "true" || normalized === "yes" || normalized === "on";
	}
	return false;
}

export function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** Turns the app's SQLite-flavoured SQL into PostgreSQL with schema-qualified tables. */
export function toPostgres(sql: string, schema: string): string {
	const prefix = `${quoteIdent(schema)}.`;
	let ignore = false;
	let index = 0;
	const body = sql
		.split(/('(?:[^']|'')*')/)
		.map((part, position) => {
			if (position % 2 === 1) return part;
			return part
				.replace(INSERT_OR_IGNORE, () => {
					ignore = true;
					return "INSERT INTO";
				})
				.replace(TABLE_REF, (_match, keyword: string, space: string, table: string) => `${keyword}${space}${prefix}${table}`)
				.replace(/\?/g, () => `$${++index}`);
		})
		.join("");
	return ignore ? `${body} ON CONFLICT DO NOTHING` : body;
}

function normalize(result: postgres.RowList<Row[]>): Row[] {
	const columns = result.columns ?? [];
	const numeric = columns.filter((column) => NUMERIC_TYPES.has(column.type)).map((column) => column.name);
	const flags = columns.filter((column) => column.type === BOOL_TYPE).map((column) => column.name);
	return result.map((row) => {
		for (const [key, value] of Object.entries(row)) {
			if (value instanceof Date) row[key] = Number.isNaN(value.getTime()) ? null : value.toISOString();
		}
		for (const name of numeric) {
			if (row[name] !== null && row[name] !== undefined) row[name] = Number(row[name]);
		}
		const boolNames = new Set([...flags, ...Object.keys(row).filter((key) => BOOL_KEYS.has(key))]);
		for (const name of boolNames) {
			if (row[name] !== null && row[name] !== undefined) row[name] = asBool(row[name]);
		}
		return row;
	});
}

class PgStatement {
	constructor(
		private readonly db: PgDatabase,
		readonly query: string,
		readonly params: unknown[] = [],
	) {}

	bind(...params: unknown[]): PgStatement {
		return new PgStatement(this.db, this.query, params);
	}

	async all<T = Row>(): Promise<Result<T>> {
		return { results: (await this.db.execute(this.query, this.params)) as T[], success: true, meta: {} };
	}

	async first<T = Row>(column?: string): Promise<T | null> {
		const [row] = await this.db.execute(this.query, this.params);
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}

	async run(): Promise<Result<never>> {
		await this.db.execute(this.query, this.params);
		return { results: [], success: true, meta: {} };
	}
}

function pemFromEnv(value?: string): string | undefined {
	if (!value?.trim()) return undefined;
	let pem = value.trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
	if (pem.includes("BEGIN CERTIFICATE") && !pem.includes("\n")) {
		pem = pem.replace("-----BEGIN CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\n").replace("-----END CERTIFICATE-----", "\n-----END CERTIFICATE-----");
	}
	if (!pem.includes("BEGIN CERTIFICATE")) {
		try {
			const decoded = Buffer.from(pem, "base64").toString("utf8");
			if (decoded.includes("BEGIN CERTIFICATE")) pem = decoded;
		} catch {
			return undefined;
		}
	}
	return pem.includes("BEGIN CERTIFICATE") ? pem : undefined;
}

function sslFor(env: PostgresEnv, sslmode: string): false | { ca?: string; rejectUnauthorized: boolean } {
	if (sslmode === "disable") return false;
	const ca = pemFromEnv(env.POSTGRES_CA_CERT);
	if (ca) return { ca, rejectUnauthorized: true };
	return { rejectUnauthorized: false };
}

const CLIENT = {
	max: 1,
	fetch_types: false,
	prepare: false,
	connect_timeout: 8,
	idle_timeout: 20,
	max_lifetime: 600,
	onnotice: () => undefined,
} as const;

function connectPostgres(env: PostgresEnv): postgres.Sql {
	const hyperdrive = env.HYPERDRIVE?.connectionString?.trim();
	if (hyperdrive) {
		return postgres(hyperdrive, CLIENT);
	}
	const sslmode = env.POSTGRES_SSLMODE?.trim() || "require";
	const ssl = sslFor(env, sslmode);
	const url = env.DATABASE_URL?.trim();
	if (url?.startsWith("postgresql")) {
		return postgres(url, { ...CLIENT, ssl });
	}
	const host = env.POSTGRES_HOST?.trim();
	const password = env.POSTGRES_PASSWORD ?? "";
	if (!host) {
		throw new Error("POSTGRES_HOST is not set on this Worker.");
	}
	if (!password) {
		throw new Error("POSTGRES_PASSWORD is not set. Add it as a Cloudflare Worker secret (not .dev.vars). Dashboard: Workers → apicrocosub → Settings → Variables and Secrets → Add POSTGRES_PASSWORD (Secret). Or: npx wrangler secret put POSTGRES_PASSWORD");
	}
	return postgres({
		host,
		port: Number(env.POSTGRES_PORT || 25060),
		database: env.POSTGRES_DB?.trim() || "defaultdb",
		username: env.POSTGRES_USER?.trim() || "doadmin",
		password,
		ssl,
		...CLIENT,
	});
}

/** D1-shaped access to PostgreSQL. Tables are schema-qualified in every statement. */
export class PgDatabase {
	readonly dialect = "postgresql";
	private readonly sql: postgres.Sql;

	constructor(env: PostgresEnv, readonly schema: string) {
		this.sql = connectPostgres(env);
	}

	prepare(query: string): PgStatement {
		return new PgStatement(this, toPostgres(query, this.schema));
	}

	async execute(query: string, params: unknown[], sql: Sql = this.sql): Promise<Row[]> {
		return normalize(await sql.unsafe<Row[]>(query, params as postgres.ParameterOrJSON<never>[]));
	}

	async batch(statements: PgStatement[]): Promise<Result<Row>[]> {
		return (await this.sql.begin(async (tx) => {
			const results: Result<Row>[] = [];
			for (const statement of statements) results.push({ results: await this.execute(statement.query, statement.params, tx), success: true, meta: {} });
			return results;
		})) as Result<Row>[];
	}

	/** Creates the schema and any missing tables. Matches the FastAPI models, plus the Worker's upload tables. */
	async setup(): Promise<string[]> {
		const before = await this.tables();
		await createSchema(this.sql, this.schema);
		const after = await this.tables();
		return after.filter((name) => !before.includes(name));
	}

	tables(): Promise<string[]> {
		return schemaTables(this.sql, this.schema);
	}

	close(): Promise<void> {
		return this.sql.end({ timeout: 5 });
	}
}

export async function schemaTables(sql: Sql, schema: string): Promise<string[]> {
	const rows = await sql.unsafe<Row[]>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name", [schema]);
	return rows.map((row) => String(row.table_name));
}

export async function createSchema(sql: Sql, schema: string): Promise<void> {
	await sql.unsafe(schemaSql(schema)).simple();
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.plans ADD COLUMN IF NOT EXISTS items TEXT NOT NULL DEFAULT ''`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.store_settings ADD COLUMN IF NOT EXISTS show_delivery_instant BOOLEAN NOT NULL DEFAULT TRUE`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.store_settings ADD COLUMN IF NOT EXISTS show_delivery_slot BOOLEAN NOT NULL DEFAULT TRUE`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.store_settings ADD COLUMN IF NOT EXISTS delivery_slots TEXT NOT NULL DEFAULT '[]'`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.juice_orders ADD COLUMN IF NOT EXISTS rating INTEGER`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.juice_orders ADD COLUMN IF NOT EXISTS payment_id VARCHAR(64)`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.juice_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(24)`);
	await sql.unsafe(`ALTER TABLE ${quoteIdent(schema)}.users ADD COLUMN IF NOT EXISTS wallet_balance DOUBLE PRECISION NOT NULL DEFAULT 0`);
}

function schemaSql(schema: string): string {
	const s = quoteIdent(schema);
	return `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.roles (
  name VARCHAR(32) PRIMARY KEY,
  description VARCHAR(240) NOT NULL DEFAULT '',
  pages TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(255) UNIQUE,
  email VARCHAR(255) UNIQUE,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(20),
  photo TEXT,
  password_hash VARCHAR(255),
  google_id VARCHAR(255) UNIQUE,
  provider VARCHAR(32) NOT NULL DEFAULT 'password',
  role VARCHAR(32) NOT NULL DEFAULT 'customer',
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  location_address TEXT,
  location_locality VARCHAR(160),
  special_access BOOLEAN NOT NULL DEFAULT FALSE,
  special_lat DOUBLE PRECISION,
  special_lng DOUBLE PRECISION,
  wallet_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.saved_addresses (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  label VARCHAR(80) NOT NULL DEFAULT '',
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  address TEXT NOT NULL,
  locality VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.juices (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'Juices',
  sku VARCHAR(80),
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  description VARCHAR(500),
  image_url TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  in_poster BOOLEAN NOT NULL DEFAULT FALSE,
  in_plans BOOLEAN NOT NULL DEFAULT TRUE,
  offer_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  ml INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.juice_categories (
  name VARCHAR(80) PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${s}.store_settings (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(160) NOT NULL DEFAULT 'CrocoSip Store',
  address TEXT NOT NULL DEFAULT '',
  locality VARCHAR(160) NOT NULL DEFAULT '',
  latitude DOUBLE PRECISION NOT NULL DEFAULT 12.9716,
  longitude DOUBLE PRECISION NOT NULL DEFAULT 77.5946,
  distance_km DOUBLE PRECISION NOT NULL DEFAULT 10,
  custom_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 20,
  cart_min_order DOUBLE PRECISION NOT NULL DEFAULT 0,
  show_delivery_instant BOOLEAN NOT NULL DEFAULT TRUE,
  show_delivery_slot BOOLEAN NOT NULL DEFAULT TRUE,
  delivery_slots TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS ${s}.plans (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  duration VARCHAR(32) NOT NULL,
  unit VARCHAR(32) NOT NULL DEFAULT 'days',
  price VARCHAR(32) NOT NULL,
  period VARCHAR(64) NOT NULL DEFAULT '',
  description VARCHAR(400) NOT NULL DEFAULT '',
  color VARCHAR(16) NOT NULL DEFAULT '#FF7A00',
  image TEXT NOT NULL DEFAULT '',
  bottles VARCHAR(64) NOT NULL DEFAULT '',
  popular BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ${s}.plan_requests (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(64) NOT NULL,
  plan_name VARCHAR(160) NOT NULL,
  price VARCHAR(32) NOT NULL DEFAULT '',
  period VARCHAR(64) NOT NULL DEFAULT '',
  bottles VARCHAR(64) NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  days INTEGER,
  items TEXT NOT NULL DEFAULT '',
  upgrade_mode VARCHAR(20) NOT NULL DEFAULT '',
  starts_on VARCHAR(10),
  ends_on VARCHAR(10),
  skipped_dates TEXT NOT NULL DEFAULT '[]',
  item_swaps TEXT NOT NULL DEFAULT '{}',
  slot_order TEXT NOT NULL DEFAULT '[]',
  delivery_lat DOUBLE PRECISION,
  delivery_lng DOUBLE PRECISION,
  delivery_address TEXT,
  delivery_locality VARCHAR(160),
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ${s}.juice_orders (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
  delivery_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  payment_method VARCHAR(24) NOT NULL DEFAULT 'COD',
  status VARCHAR(20) NOT NULL DEFAULT 'placed',
  delivery_lat DOUBLE PRECISION,
  delivery_lng DOUBLE PRECISION,
  delivery_address TEXT,
  delivery_locality VARCHAR(160),
  delivery_date VARCHAR(10),
  delivery_window VARCHAR(40) NOT NULL DEFAULT '6:00 AM – 10:00 AM',
  delivery_type VARCHAR(16) NOT NULL DEFAULT 'slot',
  proof_image TEXT,
  rating INTEGER,
  payment_id VARCHAR(64),
  payment_status VARCHAR(24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.wallet_entries (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'credit',
  source VARCHAR(24) NOT NULL DEFAULT 'admin',
  note VARCHAR(240),
  order_id VARCHAR(64),
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.support_tickets (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  order_id VARCHAR(64),
  plan_request_id VARCHAR(64),
  subject VARCHAR(240) NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  reason VARCHAR(80),
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  started BOOLEAN NOT NULL DEFAULT FALSE,
  rating INTEGER,
  closed_at TIMESTAMPTZ,
  assignee_id VARCHAR(64),
  assignee_name VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.support_messages (
  id VARCHAR(64) PRIMARY KEY,
  ticket_id VARCHAR(64) NOT NULL,
  sender VARCHAR(16) NOT NULL,
  sender_name VARCHAR(120),
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.phone_otps (
  phone VARCHAR(20) PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${s}.delivery_marks (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  delivery_date VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_marks_user_date UNIQUE (user_id, delivery_date)
);
CREATE TABLE IF NOT EXISTS ${s}.uploads (
  path VARCHAR(255) PRIMARY KEY,
  mime VARCHAR(64) NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.upload_chunks (
  path VARCHAR(255) NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (path, idx)
);
`;
}
