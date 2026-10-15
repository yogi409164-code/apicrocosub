import { DB_SCHEMA, PgDatabase, type PostgresEnv } from "./pg";

export type EngineBindings = Env & PostgresEnv & {
	DB_SCHEMA?: string;
};

let shared: PgDatabase | undefined;
let sharedKey = "";

function envKey(env: EngineBindings): string {
	return [env.HYPERDRIVE?.connectionString, env.POSTGRES_HOST, env.POSTGRES_PORT, env.POSTGRES_USER, env.POSTGRES_DB, env.DB_SCHEMA, String(env.POSTGRES_PASSWORD?.length ?? 0), String(env.POSTGRES_CA_CERT?.length ?? 0)].join("|");
}

export class Source {
	private constructor(readonly db: PgDatabase) {}

	static open(env: EngineBindings): Source {
		const key = envKey(env);
		if (!shared || sharedKey !== key) {
			void shared?.close();
			shared = new PgDatabase(env, env.DB_SCHEMA?.trim() || DB_SCHEMA);
			sharedKey = key;
		}
		return new Source(shared);
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}
