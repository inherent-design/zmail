import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import {
	ACCOUNTS_DIR,
	DATA_DIR,
	DB_PATH,
	ensureStorageDirs,
	nowIso,
} from "#/lib/config";
import { getDb, resetDb, runMigrations } from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import type { LogTrace } from "#/lib/log";
import { runCli } from "#/scripts/_shared";

type ResetMode = "all" | "messages" | "jobs";

interface PreservedAccount {
	id: string;
	label: string;
	email_address: string;
	provider_kind: string;
	sync_enabled: number;
	source_truth: string;
	selected_mailbox: string;
	created_at: string;
}

function deletePath(path: string) {
	rmSync(path, { recursive: true, force: true });
}

function deleteDbFiles() {
	for (const path of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
}

function parseMode(argv = process.argv): ResetMode {
	const mode = argv[2] ?? "all";
	if (mode === "all" || mode === "messages" || mode === "jobs") {
		return mode;
	}
	throw new Error(`Unsupported db reset mode: ${mode}`);
}

function loadPreservedAccounts(): PreservedAccount[] {
	if (!existsSync(DB_PATH)) {
		return [];
	}

	const sqlite = new Database(DB_PATH, { readonly: true });
	try {
		const accountsTable = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
			)
			.get() as { name: string } | undefined;
		if (!accountsTable) {
			return [];
		}

		const rows = sqlite
			.prepare(
				`
        SELECT
          id,
          label,
          email_address,
          COALESCE(provider_kind, 'gmail') AS provider_kind,
          COALESCE(sync_enabled, 1) AS sync_enabled,
          COALESCE(source_truth, 'corpus_mirror') AS source_truth,
          COALESCE(selected_mailbox, '[Gmail]/All Mail') AS selected_mailbox,
          created_at
        FROM accounts
        ORDER BY created_at ASC, id ASC
        `,
			)
			.all() as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			id: String(row.id),
			label: String(row.label),
			email_address: String(row.email_address),
			provider_kind: String(row.provider_kind ?? "gmail"),
			sync_enabled: Number(row.sync_enabled ?? 1),
			source_truth: String(row.source_truth ?? "corpus_mirror"),
			selected_mailbox: String(row.selected_mailbox ?? "[Gmail]/All Mail"),
			created_at:
				typeof row.created_at === "string" && row.created_at.length > 0
					? row.created_at
					: nowIso(),
		}));
	} finally {
		sqlite.close();
	}
}

function deleteRawMessageDirs() {
	if (!existsSync(ACCOUNTS_DIR)) {
		return;
	}

	for (const entry of readdirSync(ACCOUNTS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		deletePath(join(ACCOUNTS_DIR, entry.name, "raw"));
	}
}

async function resetAll() {
	await resetDb();
	deleteDbFiles();
	deletePath(ACCOUNTS_DIR);
	deletePath(resolve(DATA_DIR, "imports"));
	deletePath(resolve(DATA_DIR, "tmp", "oauth"));

	return {
		mode: "all" as const,
		deletedDbFiles: true,
		deletedAccountsDir: true,
		deletedImportsDir: true,
		deletedTempOAuthDir: true,
	};
}

async function resetMessages() {
	const preservedAccounts = loadPreservedAccounts();
	await resetDb();

	deleteDbFiles();
	deleteRawMessageDirs();
	deletePath(resolve(DATA_DIR, "imports"));
	deletePath(resolve(DATA_DIR, "tmp", "oauth"));

	ensureStorageDirs();
	runMigrations();

	const db = getDb();
	const restoredAt = nowIso();
	for (const account of preservedAccounts) {
		await db
			.insertInto("accounts")
			.values({
				id: account.id,
				label: account.label,
				email_address: account.email_address,
				provider_kind: account.provider_kind,
				sync_enabled: account.sync_enabled,
				sync_status: "idle",
				source_truth: account.source_truth,
				selected_mailbox: account.selected_mailbox,
				last_synced_at: null,
				last_error: null,
				created_at: account.created_at,
				updated_at: restoredAt,
			})
			.execute();
	}

	let queuedFullSyncJobs = 0;
	for (const account of preservedAccounts) {
		if (account.sync_enabled !== 1) {
			continue;
		}

		await queueJobIdempotent({
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: account.id,
		});
		queuedFullSyncJobs += 1;
	}

	return {
		mode: "messages" as const,
		preservedAccounts: preservedAccounts.length,
		queuedFullSyncJobs,
		preservedOAuthTokens: true,
		deletedRawMessageDirs: true,
		deletedDbFiles: true,
	};
}

async function resetJobs() {
	await resetDb();
	if (!existsSync(DB_PATH)) {
		return {
			mode: "jobs" as const,
			deletedJobs: 0,
			hadDatabase: false,
		};
	}

	const sqlite = new Database(DB_PATH);
	try {
		const jobsTable = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
			)
			.get() as { name: string } | undefined;
		if (!jobsTable) {
			return {
				mode: "jobs" as const,
				deletedJobs: 0,
				hadDatabase: true,
			};
		}

		const countRow = sqlite
			.prepare("SELECT COUNT(*) AS count FROM jobs")
			.get() as { count: number };
		sqlite.prepare("DELETE FROM jobs").run();
		return {
			mode: "jobs" as const,
			deletedJobs: Number(countRow.count ?? 0),
			hadDatabase: true,
		};
	} finally {
		sqlite.close();
	}
}

export async function main(_trace?: LogTrace, mode = parseMode()) {
	const summary =
		mode === "all"
			? await resetAll()
			: mode === "messages"
				? await resetMessages()
				: await resetJobs();

	console.log(JSON.stringify(summary, null, 2));
}

runCli(main, import.meta.url, "db:reset");
