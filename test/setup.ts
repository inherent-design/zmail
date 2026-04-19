import { rm } from "node:fs/promises";

import { afterEach, vi } from "vitest";

declare global {
	var __zmailTestRuntimeDirs__: Set<string> | undefined;
	var __zmailWorkerStarted__: boolean | undefined;
	var __zmailWorkerLoop__: Promise<void> | undefined;
}

const originalEnv = { ...process.env };
globalThis.__zmailTestRuntimeDirs__ ??= new Set<string>();

const MODULES_TO_UNMOCK = [
	"#/lib/category-rules",
	"#/lib/classify",
	"#/lib/db",
	"#/lib/finance-intel",
	"#/lib/finance-knowledge",
	"#/lib/google-oauth",
	"#/lib/imap",
	"#/lib/jobs",
	"#/lib/log",
	"#/lib/moderation",
	"#/lib/overseer",
	"#/lib/pi",
	"#/lib/registry",
	"#/lib/secondary",
	"#/lib/sync",
	"#/lib/watchers",
	"#/lib/worker",
	"#/server/actions",
	"#/server/machine-auth",
	"imapflow",
	"mailparser",
	"node:crypto",
] as const;

afterEach(async () => {
	const runtimeDirs = globalThis.__zmailTestRuntimeDirs__ ?? new Set<string>();

	try {
		const runtimeEvents = await import("#/lib/runtime-events");
		await runtimeEvents.flushRuntimeEventTasks();
	} catch {
		// Ignore import failures for tests that never initialized runtime events.
	}

	try {
		const db = await import("#/lib/db");
		await db.resetDb();
	} catch {
		// Ignore import failures for tests that never initialized the DB layer.
	}

	delete (
		globalThis as typeof globalThis & {
			__zmailSqliteMap__?: unknown;
			__zmailDbMap__?: unknown;
		}
	).__zmailSqliteMap__;
	delete (
		globalThis as typeof globalThis & {
			__zmailSqliteMap__?: unknown;
			__zmailDbMap__?: unknown;
		}
	).__zmailDbMap__;
	delete globalThis.__zmailWorkerStarted__;
	delete globalThis.__zmailWorkerLoop__;

	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const moduleId of MODULES_TO_UNMOCK) {
		vi.doUnmock(moduleId);
	}
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
