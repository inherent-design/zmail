import { ensureStorageDirs } from "#/lib/config";
import {
	adoptCanonicalMigrationHistory,
	defaultMigrationTargetOrgIds,
	ensureAccountOwnershipBackfill,
	runMigrations,
} from "#/lib/db";
import type { LogTrace } from "#/lib/log";
import { runCli } from "#/scripts/_shared";

interface ParsedArgs {
	adoptHistory: boolean;
	allOrgs: boolean;
	orgId?: string;
}

function parseArgs(argv = process.argv): ParsedArgs {
	const args = argv.slice(2);
	let adoptHistory = false;
	let allOrgs = false;
	let orgId: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			continue;
		}
		switch (arg) {
			case "--adopt-history":
				adoptHistory = true;
				break;
			case "--all-orgs":
				allOrgs = true;
				break;
			case "--org": {
				const value = args[index + 1]?.trim();
				if (!value) {
					throw new Error("Missing value for --org");
				}
				orgId = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unsupported db:migrate arg: ${arg}`);
		}
	}

	if (orgId && allOrgs) {
		throw new Error("db:migrate accepts either --org <orgId> or --all-orgs");
	}

	return {
		adoptHistory,
		allOrgs,
		orgId,
	};
}

function targetOrgIds(input: ParsedArgs) {
	if (input.orgId) {
		return [input.orgId];
	}
	if (input.allOrgs) {
		return defaultMigrationTargetOrgIds();
	}
	return defaultMigrationTargetOrgIds();
}

export async function main(_trace?: LogTrace, argv = process.argv) {
	ensureStorageDirs();
	const args = parseArgs(argv);
	for (const orgId of targetOrgIds(args)) {
		if (args.adoptHistory) {
			await adoptCanonicalMigrationHistory(orgId);
			continue;
		}
		runMigrations(orgId);
		await ensureAccountOwnershipBackfill(orgId);
	}
}

runCli(main, import.meta.url, "db:migrate");
