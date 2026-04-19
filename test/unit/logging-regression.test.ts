import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT_DIR = process.cwd();
const ALLOWED_CONSOLE_FILES = new Set([
	"scripts/pi-connect-subscription.ts",
	"scripts/audit-corpus.ts",
	"scripts/bench-http.ts",
	"scripts/bench-sse.ts",
	"scripts/db-reset.ts",
	"scripts/import-finance-artifact.ts",
	"scripts/reextract-bad-bodies.ts",
	"scripts/reextract-parse-errors.ts",
	"scripts/test-fuzz.ts",
	"scripts/test-stress.ts",
]);
const LOGGER_BOUNDARY_FILES = [
	"server/actions.ts",
	"server/index.tsx",
	"server/auth.ts",
	"server/machine-auth.ts",
	"lib/jobs.ts",
	"lib/worker.ts",
	"lib/sync.ts",
	"lib/watchers.ts",
	"lib/google-oauth.ts",
	"lib/pi.ts",
	"scripts/_shared.ts",
	"scripts/migrate.ts",
	"scripts/worker-drain.ts",
	"scripts/db-reset.ts",
	"scripts/pi-connect-subscription.ts",
	"scripts/reextract-parse-errors.ts",
];

function listSourceFiles(directory: string, root = directory): string[] {
	const entries = readdirSync(join(ROOT_DIR, directory), {
		withFileTypes: true,
	});
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(relativePath, relativePath));
			continue;
		}

		if (
			entry.name.endsWith(".ts") ||
			entry.name.endsWith(".tsx") ||
			entry.name.endsWith(".js")
		) {
			files.push(relativePath);
		}
	}

	return files.sort();
}

describe("logging regression guardrails", () => {
	it("keeps console usage out of active runtime code except the interactive pi-connect script", () => {
		const sourceFiles = [
			...listSourceFiles("server"),
			...listSourceFiles("lib"),
			...listSourceFiles("scripts"),
			...listSourceFiles("public/client"),
		];

		const unexpectedConsoleUsage: string[] = [];
		for (const file of sourceFiles) {
			if (ALLOWED_CONSOLE_FILES.has(file)) {
				continue;
			}

			const content = readFileSync(join(ROOT_DIR, file), "utf8");
			const lines = content.split("\n");
			for (const [index, line] of lines.entries()) {
				if (/\bconsole\.(log|error|warn|debug)\b/.test(line)) {
					unexpectedConsoleUsage.push(`${file}:${index + 1}`);
				}
			}
		}

		expect(unexpectedConsoleUsage).toEqual([]);
	});

	it("keeps the logger imported at the runtime boundaries", () => {
		const missingLoggerImports = LOGGER_BOUNDARY_FILES.filter((file) => {
			const content = readFileSync(join(ROOT_DIR, file), "utf8");
			return !content.includes("#/lib/log");
		});

		expect(missingLoggerImports).toEqual([]);
	});
});
