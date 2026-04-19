import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { accountsDir, dbPath, ensureStorageDirs, nowIso } from "#/lib/config";
import { getDb, resetDb, runMigrations } from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import type { LogTrace } from "#/lib/log";
import { defaultOrgId } from "#/lib/runtime";
import { runCli } from "#/scripts/_shared";

type ResetMode = "all" | "messages" | "jobs";

interface ParsedArgs {
	mode: ResetMode;
	orgId: string;
}

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

function deleteDbFiles(orgId: string) {
	const targetDbPath = dbPath(orgId);
	for (const path of [
		targetDbPath,
		`${targetDbPath}-wal`,
		`${targetDbPath}-shm`,
	]) {
		rmSync(path, { force: true });
	}
}

function parseArgs(argv = process.argv): ParsedArgs {
	const args = argv.slice(2);
	let mode: ResetMode = "all";
	let orgId = defaultOrgId();

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			continue;
		}
		if (arg === "--org") {
			const value = args[index + 1]?.trim();
			if (!value) {
				throw new Error("Missing value for --org");
			}
			orgId = value;
			index += 1;
			continue;
		}
		if (arg === "all" || arg === "messages" || arg === "jobs") {
			mode = arg;
			continue;
		}
		throw new Error(`Unsupported db reset arg: ${arg}`);
	}

	return { mode, orgId };
}

function loadPreservedAccounts(orgId: string): PreservedAccount[] {
	const targetDbPath = dbPath(orgId);
	if (!existsSync(targetDbPath)) {
		return [];
	}

	const sqlite = new Database(targetDbPath, { readonly: true });
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

function deleteRawMessageDirs(orgId: string) {
	const targetAccountsDir = accountsDir(orgId);
	if (!existsSync(targetAccountsDir)) {
		return;
	}

	for (const entry of readdirSync(targetAccountsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		deletePath(join(targetAccountsDir, entry.name, "raw"));
	}
}

async function resetAll(orgId: string) {
	await resetDb(orgId);
	deleteDbFiles(orgId);
	deletePath(accountsDir(orgId));

	return {
		mode: "all" as const,
		orgId,
		deletedDbFiles: true,
		deletedAccountsDir: true,
	};
}

async function resetMessages(orgId: string) {
	const preservedAccounts = loadPreservedAccounts(orgId);
	await resetDb(orgId);

	deleteDbFiles(orgId);
	deleteRawMessageDirs(orgId);

	ensureStorageDirs();
	runMigrations(orgId);

	const db = getDb(orgId);
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
		orgId,
		preservedAccounts: preservedAccounts.length,
		queuedFullSyncJobs,
		preservedOAuthTokens: true,
		deletedRawMessageDirs: true,
		deletedDbFiles: true,
	};
}

async function resetJobs(orgId: string) {
	await resetDb(orgId);
	const targetDbPath = dbPath(orgId);
	if (!existsSync(targetDbPath)) {
		return {
			mode: "jobs" as const,
			orgId,
			deletedJobs: 0,
			hadDatabase: false,
		};
	}

	const sqlite = new Database(targetDbPath);
	try {
		const jobsTable = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
			)
			.get() as { name: string } | undefined;
		if (!jobsTable) {
			return {
				mode: "jobs" as const,
				orgId,
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
			orgId,
			deletedJobs: Number(countRow.count ?? 0),
			hadDatabase: true,
		};
	} finally {
		sqlite.close();
	}
}

export async function main(_trace?: LogTrace, argv = process.argv) {
	const args = parseArgs(argv);
	const summary =
		args.mode === "all"
			? await resetAll(args.orgId)
			: args.mode === "messages"
				? await resetMessages(args.orgId)
				: await resetJobs(args.orgId);

	console.log(JSON.stringify(summary, null, 2));
}

runCli(main, import.meta.url, "db:reset");
