import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

interface MockCodexLoginOptions {
	onAuth?: (input: { instructions: string; url: string }) => void;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	onPrompt?: (input: { message: string }) => Promise<string>;
}

const loginOpenAICodex = vi.fn(async () => ({
	refresh: "refresh",
	access: "access",
	expires: Date.now() + 60_000,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
	loginOpenAICodex,
}));

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: vi.fn(async () => "code"),
		close: vi.fn(),
	})),
}));

describe("scripts", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("#/lib/db");
		vi.doUnmock("#/lib/log");
		vi.doUnmock("#/lib/pi");
		vi.doUnmock("vite");
		vi.doUnmock("@tanstack/router-plugin/vite");
	});

	it("detects direct execution", async () => {
		const { isDirectExecution } = await import("#/scripts/_shared");
		expect(isDirectExecution(import.meta.url)).toBe(false);
	});

	it("handles missing argv and runCli failures with traced output", async () => {
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const { isDirectExecution, runCli } = await import("#/scripts/_shared");
		const originalArgv = process.argv;
		process.argv = ["node"];

		expect(isDirectExecution(import.meta.url)).toBe(false);

		process.argv = ["node", "/tmp/tool.ts"];
		runCli(
			async () => {
				throw new Error("boom");
			},
			pathToFileURL("/tmp/tool.ts").href,
			"test:fail",
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(process.exitCode).toBe(1);
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "cli.command.start",
				}),
				expect.objectContaining({
					type: "fail",
					event: "cli.command.fail",
				}),
			]),
		);
		process.exitCode = undefined;
		process.argv = originalArgv;
	});

	it("runCli emits traced start and completion events", async () => {
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const { runCli } = await import("#/scripts/_shared");
		const originalArgv = process.argv;
		process.argv = ["node", "/tmp/success.ts"];

		runCli(
			async () => undefined,
			pathToFileURL("/tmp/success.ts").href,
			"test:ok",
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "cli.command.start",
				}),
				expect.objectContaining({
					type: "complete",
					event: "cli.command.complete",
				}),
			]),
		);

		process.argv = originalArgv;
	});

	it("writes subscription credentials with pi:connect", async () => {
		const runtime = await createTestRuntime();
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const readline = await import("node:readline/promises");
		const createInterface = vi.mocked(readline.createInterface);

		loginOpenAICodex.mockImplementationOnce((async (
			options: MockCodexLoginOptions,
		) => {
			options.onAuth?.({
				instructions: "follow the instructions",
				url: "https://example.com",
			});
			options.onProgress?.("waiting");
			await options.onManualCodeInput?.();
			await options.onPrompt?.({ message: "Enter value" });
			return {
				refresh: "refresh",
				access: "access",
				expires: Date.now() + 60_000,
			};
		}) as never);

		const script = await runtime.importFresh<
			typeof import("#/scripts/pi-connect-subscription")
		>("#/scripts/pi-connect-subscription");
		await script.main();

		const stored = JSON.parse(
			await readFile(config.PI_SUBSCRIPTION_PATH, "utf8"),
		);
		expect(stored.provider).toBe("openai-subscription");
		expect(loginOpenAICodex).toHaveBeenCalled();
		expect(createInterface).toHaveBeenCalled();
	});

	it("uses a child trace when pi:connect receives one directly", async () => {
		const runtime = await createTestRuntime();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		const script = await runtime.importFresh<
			typeof import("#/scripts/pi-connect-subscription")
		>("#/scripts/pi-connect-subscription");
		const trace = log.module.startTrace({
			kind: "cli",
			operation: "test-root",
		});
		await script.main(trace);

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "child",
					fields: expect.objectContaining({
						kind: "cli",
						operation: "pi:connect",
					}),
				}),
			]),
		);
	});

	it("runs migrations script", async () => {
		const runtime = await createTestRuntime();
		const script =
			await runtime.importFresh<typeof import("#/scripts/migrate")>(
				"#/scripts/migrate",
			);
		await script.main();

		const db = await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const tables = db
			.getSqlite()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("accounts");
		expect(tableNames).toContain("account_sync_state");
	});

	it("drains the worker script", async () => {
		const runtime = await createTestRuntime();
		const { bootDb } = await import("#/test/helpers/db");
		const { dbModule } = await bootDb({ seedDefaultAccount: true });
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		await jobs.queueJob({
			kind: "rebuild_overseer",
			scopeType: "account",
			scopeId: "acct-1",
		});

		vi.doMock("#/lib/pi", () => ({
			piJson: vi.fn(async () => ({
				backend: "openai-api",
				modelId: "gpt-5-mini",
				parsed: {
					schemaVersion: "overseer-profile.v1",
					accountId: "acct-1",
					builtFromMessages: 0,
					knownBusinessDomains: [],
					knownPersonalDomains: [],
					knownFinancialSenders: [],
					recurringPurposeHints: [],
					confidentialityPatterns: [],
					promotedTags: [],
					promptPreamble: "none",
				},
				rawText: "{}",
				usage: null,
			})),
		}));

		const script = await runtime.importFresh<
			typeof import("#/scripts/worker-drain")
		>("#/scripts/worker-drain");
		await script.main();

		const rows = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["status"])
			.execute();
		expect(rows[0]?.status).toBe("complete");
	});

	it("runs the route-tree generator script", async () => {
		const runtime = await createTestRuntime();
		const close = vi.fn(async () => undefined);
		const createServer = vi.fn(async () => ({
			close,
		}));
		const tanstackRouterGenerator = vi.fn((input) => input);

		vi.doMock("vite", () => ({
			createServer,
		}));
		vi.doMock("@tanstack/router-plugin/vite", () => ({
			tanstackRouterGenerator,
		}));

		const script = await runtime.importFresh<
			typeof import("#/scripts/generate-route-tree")
		>("#/scripts/generate-route-tree");
		await script.main();

		expect(createServer).toHaveBeenCalled();
		expect(tanstackRouterGenerator).toHaveBeenCalledWith({
			target: "react",
			routesDirectory: "./app/routes",
			generatedRouteTree: "./app/routeTree.gen.ts",
			routeFileIgnorePrefix: "-",
			autoCodeSplitting: true,
		});
		expect(close).toHaveBeenCalled();
	});
});
