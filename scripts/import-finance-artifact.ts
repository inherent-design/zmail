import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { importFinanceArtifact } from "#/lib/finance-imports";
import { rebuildFinanceRollups } from "#/lib/finance-rollups";
import { reconcileRegistrySuggestions } from "#/lib/registry";

async function main() {
	const target = process.argv[2];
	if (!target) {
		throw new Error("Usage: pnpm finance:import <artifact.json>");
	}

	const path = resolve(process.cwd(), target);
	const artifact = JSON.parse(readFileSync(path, "utf8"));
	const imported = await importFinanceArtifact(artifact);
	const reconciled = await reconcileRegistrySuggestions();
	const rollups = await rebuildFinanceRollups();

	console.log(
		JSON.stringify(
			{
				ok: true,
				imported,
				reconciled,
				rollups,
			},
			null,
			2,
		),
	);
}

await main();
