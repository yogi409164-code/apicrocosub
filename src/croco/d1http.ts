import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type QueryResult = { results?: Record<string, unknown>[]; meta?: { changes?: number; last_row_id?: number } };

export type HttpD1Options = {
	databaseId: string;
	accountId?: string;
	token?: string;
};

function statements(sql: string): string[] {
	return sql
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function resolveCloudflareToken(explicit?: string): string {
	const named = [explicit, process.env.CLOUDFLARE_API_TOKEN, process.env.CF_API_TOKEN, process.env.CLOUDFLARE_TOKEN];
	for (const value of named) {
		const token = value?.trim();
		if (token) return token;
	}
	return wranglerToken();
}

function wranglerToken(): string {
	const home = os.homedir();
	const files = [path.join(home, ".wrangler", "config", "default.toml"), path.join(home, "AppData", "Roaming", "xdg.config", ".wrangler", "config", "default.toml")];
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		const match = fs.readFileSync(file, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
		if (match?.[1]) return match[1];
	}
	return "";
}

class HttpStatement {
	constructor(
		private readonly client: HttpD1,
		private readonly sql: string,
		private readonly params: unknown[] = [],
	) {}

	bind(...params: unknown[]): HttpStatement {
		return new HttpStatement(this.client, this.sql, params);
	}

	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
		const { rows, meta } = await this.client.query(this.sql, this.params);
		return { results: rows as T[], success: true, meta };
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const { rows } = await this.client.query(this.sql, this.params);
		const row = rows[0];
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}

	async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
		const { meta } = await this.client.query(this.sql, this.params);
		return { success: true, meta };
	}
}

class HttpD1 {
	private accountId: string;
	private token: string;

	constructor(private readonly options: HttpD1Options) {
		this.accountId = options.accountId?.trim() ?? "";
		this.token = resolveCloudflareToken(options.token);
	}

	prepare(sql: string): HttpStatement {
		return new HttpStatement(this, sql);
	}

	async batch(statementsToRun: HttpStatement[]): Promise<{ results: Record<string, unknown>[]; success: true; meta: Record<string, unknown> }[]> {
		const results = [];
		for (const statement of statementsToRun) results.push(await statement.all());
		return results;
	}

	async exec(sql: string): Promise<{ count: number; duration: number }> {
		const parts = statements(sql);
		for (const part of parts) await this.query(part, []);
		return { count: parts.length, duration: 0 };
	}

	async query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; meta: Record<string, unknown> }> {
		if (!this.options.databaseId.trim()) throw new Error("D1 database id is missing from wrangler.jsonc.");
		if (!this.token) throw new Error("CLOUDFLARE_API_TOKEN is not set. Add it to apicrocosub/.dev.vars, or log in with wrangler.");
		if (!this.accountId) this.accountId = await this.onlyAccount();
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.options.databaseId}/query`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ sql, params: params.map((value) => (value === undefined ? null : value)) }),
			signal: AbortSignal.timeout(30_000),
		});
		const payload = (await response.json()) as { success?: boolean; errors?: { message?: string }[]; result?: QueryResult[] };
		if (!response.ok || payload.success === false) {
			const message = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || `D1 request failed (${response.status})`;
			throw new Error(message);
		}
		const result = payload.result?.[0] ?? {};
		return { rows: result.results ?? [], meta: { changes: result.meta?.changes ?? 0, last_row_id: result.meta?.last_row_id ?? 0 } };
	}

	private async onlyAccount(): Promise<string> {
		const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=20", {
			headers: { Authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		const payload = (await response.json()) as { success?: boolean; errors?: { message?: string }[]; result?: { id?: string; name?: string }[] };
		if (!response.ok || payload.success === false) {
			const message = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || `Cloudflare account lookup failed (${response.status})`;
			throw new Error(message);
		}
		const accounts = payload.result ?? [];
		if (accounts.length !== 1 || !accounts[0]?.id) {
			const names = accounts.map((account) => account.name).filter(Boolean).join(", ");
			throw new Error(names ? `Set CLOUDFLARE_ACCOUNT_ID. This token can see: ${names}` : "Set CLOUDFLARE_ACCOUNT_ID.");
		}
		return accounts[0].id;
	}
}

export function createHttpD1(options: HttpD1Options): D1Database {
	return new HttpD1(options) as unknown as D1Database;
}
