import { ensureStorageDirs } from "#/lib/config";
import { runMigrations } from "#/lib/db";
import type { LogTrace } from "#/lib/log";
import { runCli } from "#/scripts/_shared";

export async function main(_trace?: LogTrace) {
	ensureStorageDirs();
	runMigrations();
}

runCli(main, import.meta.url, "db:migrate");
