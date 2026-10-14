import { DB_SCHEMA, PgDatabase, type PostgresEnv } from "./pg";

export type EngineBindings = Env & PostgresEnv & {
	DB_SCHEMA?: string;
};

export class Source {
	private constructor(readonly db: PgDatabase) {}

	static open(env: EngineBindings): Source {
		return new Source(new PgDatabase(env, env.DB_SCHEMA?.trim() || DB_SCHEMA));
	}

	close(): Promise<void> {
		return this.db.close();
	}
}
