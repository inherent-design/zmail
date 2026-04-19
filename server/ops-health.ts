import { existsSync, readdirSync } from "node:fs";

import { loadResolvedConfig } from "#/lib/app-config";
import { MIGRATIONS_DIR } from "#/lib/config";
import { getActiveWatcherCount } from "#/lib/watchers";
import { getDb, getSqlite } from "#/lib/db";
import { dataRootDir, orgRootDir, runtimePaths } from "#/lib/runtime";

export async function loadOpsHealth(input: {
	orgId: string;
	details?: boolean;
}) {
	const config = loadResolvedConfig();
	const paths = runtimePaths(input.orgId);
	const dataRootExists = existsSync(dataRootDir());
	const orgRootExists = existsSync(orgRootDir(input.orgId));
	let sqliteReachable = false;
	let migrationsStamped = false;
	let appliedMigrationCount = 0;
	let expectedMigrationCount = 0;
	let queuedJobs = 0;
	let runningJobs = 0;
	let failedRecentJobs = 0;
	let oldestQueuedAgeSeconds: number | null = null;
	let accounts = 0;
	let syncingAccounts = 0;
	let backfillingAccounts = 0;
	let needsReconnectAccounts = 0;
	let accountDetails: Array<{ accountId: string; syncStatus: string }> = [];

	try {
		const sqlite = getSqlite(input.orgId);
		sqlite.prepare("SELECT 1").get();
		sqliteReachable = true;
		const migrationRows = sqlite
			.prepare("SELECT name FROM _migrations")
			.all() as Array<{ name: string }>;
		appliedMigrationCount = migrationRows.length;
		expectedMigrationCount = readdirSync(MIGRATIONS_DIR).filter((name) =>
			name.endsWith(".sql"),
		).length;
		migrationsStamped = appliedMigrationCount >= expectedMigrationCount;
	} catch {
		return {
			ok: false,
			status: "degraded" as const,
			orgId: input.orgId,
			storage: {
				dataRootExists,
				orgRootExists,
				sqliteReachable,
			},
			database: {
				migrationsStamped,
				appliedMigrationCount,
				expectedMigrationCount,
			},
			worker: {
				enabled: config.worker.enabled,
				activeWatcherCount: getActiveWatcherCount(),
				queuedJobs,
				runningJobs,
				failedRecentJobs,
				oldestQueuedAgeSeconds,
			},
			sync: {
				accounts,
				syncingAccounts,
				backfillingAccounts,
				needsReconnectAccounts,
			},
			...(input.details ? { details: { accounts: accountDetails } } : {}),
		};
	}

	const db = getDb();
	const [jobRows, accountRows] = await Promise.all([
		db
			.selectFrom("jobs")
			.select(["status", "created_at"])
			.where("status", "in", ["queued", "running", "failed"])
			.execute(),
		db.selectFrom("accounts").select(["id", "sync_status"]).execute(),
	]);
	const now = Date.now();
	for (const job of jobRows) {
		if (job.status === "queued") {
			queuedJobs += 1;
			const ageSeconds = Math.max(
				0,
				(now - new Date(job.created_at).getTime()) / 1000,
			);
			oldestQueuedAgeSeconds =
				oldestQueuedAgeSeconds === null
					? ageSeconds
					: Math.max(oldestQueuedAgeSeconds, ageSeconds);
		}
		if (job.status === "running") {
			runningJobs += 1;
		}
		if (job.status === "failed") {
			failedRecentJobs += 1;
		}
	}
	for (const account of accountRows) {
		accounts += 1;
		if (account.sync_status === "syncing") {
			syncingAccounts += 1;
		}
		if (account.sync_status === "backfilling") {
			backfillingAccounts += 1;
		}
		if (account.sync_status === "needs_reconnect") {
			needsReconnectAccounts += 1;
		}
		if (input.details) {
			accountDetails.push({
				accountId: account.id,
				syncStatus: account.sync_status,
			});
		}
	}

	const ok = sqliteReachable && migrationsStamped;
	return {
		ok,
		status: ok ? ("ok" as const) : ("degraded" as const),
		orgId: input.orgId,
		storage: {
			dataRootExists,
			orgRootExists,
			sqliteReachable,
		},
		database: {
			migrationsStamped,
			appliedMigrationCount,
			expectedMigrationCount,
		},
		worker: {
			enabled: config.worker.enabled,
			activeWatcherCount: getActiveWatcherCount(),
			queuedJobs,
			runningJobs,
			failedRecentJobs,
			oldestQueuedAgeSeconds,
		},
		sync: {
			accounts,
			syncingAccounts,
			backfillingAccounts,
			needsReconnectAccounts,
		},
		...(input.details ? { details: { accounts: accountDetails } } : {}),
		paths: {
			layout: paths.layout,
		},
	};
}
