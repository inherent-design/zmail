import { rm } from "node:fs/promises";

import { afterEach, vi } from "vitest";

declare global {
	var __zmailTestRuntimeDirs__: Set<string> | undefined;
}

const originalEnv = { ...process.env };
globalThis.__zmailTestRuntimeDirs__ ??= new Set<string>();

afterEach(async () => {
	const runtimeDirs = globalThis.__zmailTestRuntimeDirs__ ?? new Set<string>();

	try {
		const db = await import("#/lib/db");
		await db.resetDb();
	} catch {
		// Ignore import failures for tests that never initialized the DB layer.
	}

	delete globalThis.__zmailSqlite__;
	delete globalThis.__zmailDb__;
	delete globalThis.__zmailWorkerStarted__;
	delete globalThis.__zmailWorkerLoop__;

	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.resetModules();

	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, originalEnv);

	for (const dir of runtimeDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	runtimeDirs.clear();
	globalThis.__zmailTestRuntimeDirs__ = runtimeDirs;
});
