import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT_DIR = process.cwd();
const ALLOWED_CONSOLE_FILES = new Set(["scripts/pi-connect-subscription.ts"]);
const LOGGER_BOUNDARY_FILES = [
	"app/server/actions.server.ts",
	"lib/jobs.ts",
	"lib/worker.ts",
	"lib/sync.ts",
	"lib/watchers.ts",
	"lib/google-oauth.ts",
	"lib/pi.ts",
	"scripts/_shared.ts",
	"scripts/migrate.ts",
	"scripts/worker-drain.ts",
	"scripts/generate-route-tree.ts",
	"scripts/pi-connect-subscription.ts",
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

		if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
			files.push(relativePath);
		}
	}

	return files.sort();
}

describe("logging regression guardrails", () => {
	it("keeps console usage out of active runtime code except the interactive pi-connect script", () => {
		const sourceFiles = [
			...listSourceFiles("app"),
			...listSourceFiles("lib"),
			...listSourceFiles("scripts"),
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
