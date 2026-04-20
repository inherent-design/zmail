import { exportFinanceBeancountPackage } from "#/lib/beancount-export";
import { ensureStorageDirs } from "#/lib/config";
import { ensureAccountOwnershipBackfill, runMigrations } from "#/lib/db";
import type { LogTrace } from "#/lib/log";
import { runWithOrgContext } from "#/lib/runtime";
import { runCli } from "#/scripts/_shared";

interface ParsedArgs {
	orgId: string;
	outDir: string;
	year?: number;
	strict: boolean;
	force: boolean;
}

export function parseFinanceExportArgs(argv = process.argv): ParsedArgs {
	const args = argv.slice(2);
	let orgId: string | undefined;
	let outDir: string | undefined;
	let year: number | undefined;
	let strict = true;
	let force = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			continue;
		}
		switch (arg) {
			case "--org": {
				const value = args[index + 1]?.trim();
				if (!value) {
					throw new Error("Missing value for --org");
				}
				orgId = value;
				index += 1;
				break;
			}
			case "--out": {
				const value = args[index + 1]?.trim();
				if (!value) {
					throw new Error("Missing value for --out");
				}
				outDir = value;
				index += 1;
				break;
			}
			case "--year": {
				const value = args[index + 1]?.trim();
				if (!value) {
					throw new Error("Missing value for --year");
				}
				const parsed = Number.parseInt(value, 10);
				if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2500) {
					throw new Error("Invalid --year value");
				}
				year = parsed;
				index += 1;
				break;
			}
			case "--strict":
				strict = true;
				break;
			case "-f":
			case "--force":
				force = true;
				break;
			default:
				throw new Error(`Unsupported finance:export arg: ${arg}`);
		}
	}

	if (!orgId || !outDir) {
		throw new Error(
			"finance:export requires --org <orgId> --out <dir> [--year YYYY] [--strict]",
		);
	}

	return {
		orgId,
		outDir,
		year,
		strict,
		force,
	};
}

export async function main(_trace?: LogTrace, argv = process.argv) {
	const args = parseFinanceExportArgs(argv);

	await runWithOrgContext(args.orgId, async () => {
		ensureStorageDirs();
		runMigrations(args.orgId);
		await ensureAccountOwnershipBackfill(args.orgId);

		const result = await exportFinanceBeancountPackage({
			orgId: args.orgId,
			outDir: args.outDir,
			year: args.year,
			strict: args.strict,
			force: args.force,
		});

		process.stdout.write(
			`${JSON.stringify({ ok: true, orgId: args.orgId, ...result }, null, 2)}\n`,
		);
	});
}

runCli(main, import.meta.url, "finance:export");
