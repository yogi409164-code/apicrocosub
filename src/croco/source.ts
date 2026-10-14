import { PgDatabase } from "./pg";

export const DATABASE_URL =
	"postgresql://doadmin:AVNS_vYwTZHZZpPbenuXnZEa@dbaas-db-1025064-do-user-46253107-0.e.db.ondigitalocean.com:25060/defaultdb?sslmode=require";
export const DB_SCHEMA = "Crocosip_mobile_app";

export type EngineBindings = Env & {
	HYPERDRIVE?: Hyperdrive;
	DB_SCHEMA?: string;
};

export function postgresConnection(env: EngineBindings): string {
	return env.HYPERDRIVE?.connectionString?.trim() || DATABASE_URL;
}

export class Source {
	private constructor(readonly db: PgDatabase) {}

	static open(env: EngineBindings): Source {
		return new Source(new PgDatabase(postgresConnection(env), env.DB_SCHEMA?.trim() || DB_SCHEMA));
	}

	close(): Promise<void> {
		return this.db.close();
	}
}
