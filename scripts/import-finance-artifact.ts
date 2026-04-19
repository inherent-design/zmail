import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureStorageDirs } from "#/lib/config";
import { ensureAccountOwnershipBackfill, runMigrations } from "#/lib/db";
import { importFinanceArtifact } from "#/lib/finance-imports";
import { rebuildFinanceRollups } from "#/lib/finance-rollups";
import type { LogTrace } from "#/lib/log";
import { reconcileRegistrySuggestions } from "#/lib/registry";
import { runWithOrgContext } from "#/lib/runtime";
import { runCli } from "#/scripts/_shared";

interface ParsedArgs {
	orgId: string;
	target: string;
}

function parseArgs(argv = process.argv): ParsedArgs {
	const args = argv.slice(2);
	let orgId: string | undefined;
	let target: string | undefined;

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
		if (target) {
			throw new Error(`Unsupported finance:import arg: ${arg}`);
		}
		target = arg;
	}

	if (!orgId) {
		throw new Error("finance:import requires --org <orgId> <artifact.json>");
	}
	if (!target) {
		throw new Error("finance:import requires --org <orgId> <artifact.json>");
	}

	return {
		orgId,
		target,
	};
}

export async function main(_trace?: LogTrace, argv = process.argv) {
	const args = parseArgs(argv);

	await runWithOrgContext(args.orgId, async () => {
		ensureStorageDirs();
		runMigrations(args.orgId);
		await ensureAccountOwnershipBackfill(args.orgId);

		const path = resolve(process.cwd(), args.target);
		const artifact = JSON.parse(readFileSync(path, "utf8"));
		const imported = await importFinanceArtifact(artifact);
		const reconciled = await reconcileRegistrySuggestions();
		const rollups = await rebuildFinanceRollups();

		console.log(
			JSON.stringify(
				{
					ok: true,
					orgId: args.orgId,
					imported,
					reconciled,
					rollups,
				},
				null,
				2,
			),
		);
	});
}

runCli(main, import.meta.url, "finance:import");
