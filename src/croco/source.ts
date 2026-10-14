import { PgDatabase } from "./pg";

export type EngineBindings = Env & {
	HYPERDRIVE?: Hyperdrive;
	DB_SCHEMA?: string;
	POSTGRES_HOST?: string;
	POSTGRES_PORT?: string;
	POSTGRES_USER?: string;
	POSTGRES_PASSWORD?: string;
	POSTGRES_DB?: string;
	POSTGRES_SSLMODE?: string;
};

const POSTGRES_PASSWORD = "AVNS_vYwTZHZZpPbenuXnZEa";

/** DigitalOcean PostgreSQL URL: Hyperdrive when bound, otherwise POSTGRES_* plus the in-code password. */
export function postgresConnection(env: EngineBindings): string {
	const fromHyperdrive = env.HYPERDRIVE?.connectionString?.trim();
	if (fromHyperdrive) return fromHyperdrive;
	const host = env.POSTGRES_HOST?.trim();
	const password = env.POSTGRES_PASSWORD?.trim() || POSTGRES_PASSWORD;
	if (!host || !password) {
		throw new Error("PostgreSQL is not configured. Set POSTGRES_HOST and POSTGRES_PASSWORD, or bind Hyperdrive.");
	}
	const user = encodeURIComponent(env.POSTGRES_USER?.trim() || "doadmin");
	const pass = encodeURIComponent(password);
	const port = env.POSTGRES_PORT?.trim() || "25060";
	const database = encodeURIComponent(env.POSTGRES_DB?.trim() || "defaultdb");
	const ssl = env.POSTGRES_SSLMODE?.trim() || "require";
	return `postgresql://${user}:${pass}@${host}:${port}/${database}?sslmode=${ssl}`;
}

export class Source {
	private constructor(readonly db: PgDatabase) {}

	static open(env: EngineBindings): Source {
		const schema = env.DB_SCHEMA?.trim() || "Crocosip_mobile_app";
		return new Source(new PgDatabase(postgresConnection(env), schema));
	}

	close(): Promise<void> {
		return this.db.close();
	}
}
