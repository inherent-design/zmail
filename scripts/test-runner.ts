import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Command =
	| "list"
	| "quick"
	| "coverage"
	| "unit"
	| "integration"
	| "e2e"
	| "fuzz"
	| "stress";
type VitestMode = "test" | "coverage";
type UnitDomain = "platform" | "domain" | "runtime" | "finance";
type StepKind = "command" | "unit" | "integration" | "e2e" | "fuzz" | "stress";

interface UnitBucket {
	domain: UnitDomain;
	name: string;
	tests: string[];
	coverageInclude: string[];
}

interface IntegrationBucket {
	name: string;
	tests: string[];
}

interface CommandStep {
	kind: StepKind;
	name: string;
	mode?: VitestMode;
	command?: string;
	args?: string[];
	buckets?: UnitBucket[] | IntegrationBucket[];
}

interface Catalog {
	unit: UnitBucket[];
	integration: IntegrationBucket[];
}

type RunCommand = (
	command: string,
	args: string[],
	options?: { env?: NodeJS.ProcessEnv },
) => SpawnSyncReturns<Buffer> | SpawnSyncReturns<string>;

const ROOT_DIR = process.cwd();
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

export const UNIT_BUCKETS: UnitBucket[] = [
	{
		domain: "platform",
		name: "platform-config",
		tests: [
			"test/unit/app-config.test.ts",
			"test/unit/db.test.ts",
			"test/unit/new-schemas.test.ts",
			"test/unit/schemas.test.ts",
		],
		coverageInclude: [
			"lib/app-config.ts",
			"lib/config.ts",
			"lib/db.ts",
			"lib/runtime.ts",
			"lib/schemas.ts",
		],
	},
	{
		domain: "platform",
		name: "platform-auth",
		tests: [
			"test/unit/google-oauth.test.ts",
			"test/unit/machine-auth.test.ts",
			"test/unit/server-auth.test.ts",
		],
		coverageInclude: [
			"lib/google-oauth.ts",
			"server/auth.ts",
			"server/machine-auth.ts",
		],
	},
	{
		domain: "platform",
		name: "platform-observability",
		tests: [
			"test/unit/log.test.ts",
			"test/unit/logging-regression.test.ts",
			"test/unit/observability.test.ts",
			"test/unit/runtime-events.test.ts",
		],
		coverageInclude: [
			"lib/log.ts",
			"lib/observability.ts",
			"lib/runtime-events.ts",
		],
	},
	{
		domain: "domain",
		name: "domain-classification",
		tests: [
			"test/unit/category-rules.test.ts",
			"test/unit/classify.test.ts",
			"test/unit/moderation.test.ts",
			"test/unit/normalize.test.ts",
			"test/unit/overseer.test.ts",
			"test/unit/review-classifier.test.ts",
			"test/unit/secondary.test.ts",
		],
		coverageInclude: [
			"lib/category-rules.ts",
			"lib/classify.ts",
			"lib/moderation.ts",
			"lib/normalize.ts",
			"lib/overseer.ts",
			"lib/review-classifier.ts",
			"lib/secondary.ts",
		],
	},
	{
		domain: "finance",
		name: "domain-finance",
		tests: [
			"test/unit/beancount-export.test.ts",
			"test/unit/finance-upload.test.ts",
			"test/unit/finance-mapping-candidates.test.ts",
			"test/unit/finance-intel.test.ts",
			"test/unit/finance-knowledge.test.ts",
			"test/unit/finance-v3-scripts.test.ts",
			"test/unit/tax-reporting.test.ts",
		],
		coverageInclude: [
			"lib/beancount-export.ts",
			"lib/finance-upload.ts",
			"lib/finance-mapping-candidates.ts",
			"lib/finance-intel.ts",
			"lib/finance-knowledge.ts",
			"lib/tax-reporting.ts",
			"scripts/classify-migrate-finance-v3.ts",
		],
	},
	{
		domain: "domain",
		name: "domain-registry",
		tests: ["test/unit/registry.test.ts"],
		coverageInclude: ["lib/registry.ts"],
	},
	{
		domain: "runtime",
		name: "runtime-actions",
		tests: ["test/unit/new-actions.test.ts"],
		coverageInclude: ["server/actions.ts"],
	},
	{
		domain: "runtime",
		name: "runtime-sync",
		tests: [
			"test/unit/imap.test.ts",
			"test/unit/sync-progress.test.ts",
			"test/unit/sync-provider.test.ts",
			"test/unit/sync.test.ts",
			"test/unit/watchers.test.ts",
		],
		coverageInclude: [
			"lib/imap.ts",
			"lib/sync-progress.ts",
			"lib/sync.ts",
			"lib/watchers.ts",
		],
	},
	{
		domain: "runtime",
		name: "runtime-worker",
		tests: [
			"test/unit/job-lane-progress.test.ts",
			"test/unit/jobs.test.ts",
			"test/unit/worker-backlog.test.ts",
			"test/unit/worker-finance.test.ts",
			"test/unit/worker-iteration.test.ts",
			"test/unit/worker-progress.test.ts",
			"test/unit/worker-startup.test.ts",
		],
		coverageInclude: [
			"lib/job-lane-progress.ts",
			"lib/jobs.ts",
			"lib/worker.ts",
		],
	},
	{
		domain: "runtime",
		name: "runtime-scripts",
		tests: [
			"test/unit/scripts.test.ts",
			"test/unit/island-registry.test.ts",
			"test/unit/shell-nav.test.ts",
			"test/unit/test-helpers-e2e-scenarios.test.ts",
			"test/unit/test-helpers-labels.test.ts",
			"test/unit/test-runner.test.ts",
		],
		coverageInclude: [
			"public/client/core/island-registry.js",
			"public/client/core/shell-nav.ts",
			"scripts/**/*.ts",
			"test/helpers/**/*.ts",
			"test/e2e-playwright/scenarios.ts",
		],
	},
	{
		domain: "runtime",
		name: "runtime-pi",
		tests: ["test/unit/pi.test.ts"],
		coverageInclude: ["lib/pi.ts"],
	},
];

export const INTEGRATION_BUCKETS: IntegrationBucket[] = [
	{
		name: "integration-finance",
		tests: [
			"test/integration/api-finance-imports.test.ts",
			"test/integration/finance-loader.test.ts",
		],
	},
	{
		name: "integration-platform",
		tests: [
			"test/integration/health-and-metrics.test.ts",
			"test/integration/runtime.test.ts",
			"test/integration/web-routes.test.ts",
		],
	},
	{
		name: "integration-worker",
		tests: [
			"test/integration/worker-actions.test.ts",
			"test/integration/worker-branches.test.ts",
		],
	},
];

export const DEFAULT_CATALOG: Catalog = {
	unit: UNIT_BUCKETS,
	integration: INTEGRATION_BUCKETS,
};

function listTestFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const entries = readdirSync(dir, { withFileTypes: true });
	return entries
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				return listTestFiles(path);
			}
			if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
				return [relative(ROOT_DIR, path)];
			}
			return [];
		})
		.sort((left, right) => left.localeCompare(right));
}

export function validateCatalog(input: {
	catalog: Catalog;
	unitFiles: string[];
	integrationFiles: string[];
}) {
	const errors: string[] = [];
	const seenUnit = new Map<string, string[]>();
	const seenIntegration = new Map<string, string[]>();

	for (const bucket of input.catalog.unit) {
		for (const test of bucket.tests) {
			seenUnit.set(test, [...(seenUnit.get(test) ?? []), bucket.name]);
		}
	}
	for (const bucket of input.catalog.integration) {
		for (const test of bucket.tests) {
			seenIntegration.set(test, [
				...(seenIntegration.get(test) ?? []),
				bucket.name,
			]);
		}
	}

	for (const test of input.unitFiles) {
		if (!seenUnit.has(test)) {
			errors.push(`Unit test is not assigned to a bucket: ${test}`);
		}
	}
	for (const [test, buckets] of seenUnit) {
		if (!input.unitFiles.includes(test)) {
			errors.push(`Unit bucket references missing test file: ${test}`);
		}
		if (buckets.length > 1) {
			errors.push(
				`Unit test is assigned to multiple buckets: ${test} (${buckets.join(", ")})`,
			);
		}
	}

	for (const test of input.integrationFiles) {
		if (!seenIntegration.has(test)) {
			errors.push(`Integration test is not assigned to a bucket: ${test}`);
		}
	}
	for (const [test, buckets] of seenIntegration) {
		if (!input.integrationFiles.includes(test)) {
			errors.push(`Integration bucket references missing test file: ${test}`);
		}
		if (buckets.length > 1) {
			errors.push(
				`Integration test is assigned to multiple buckets: ${test} (${buckets.join(", ")})`,
			);
		}
	}

	if (errors.length > 0) {
		throw new Error(`Invalid test catalog:\n${errors.join("\n")}`);
	}
}

function validateDefaultCatalog() {
	validateCatalog({
		catalog: DEFAULT_CATALOG,
		unitFiles: listTestFiles(resolve(ROOT_DIR, "test/unit")),
		integrationFiles: listTestFiles(resolve(ROOT_DIR, "test/integration")),
	});
}

export function unitBucketsForDomain(domain?: string) {
	if (!domain) {
		return DEFAULT_CATALOG.unit;
	}
	const validDomains = new Set(
		DEFAULT_CATALOG.unit.map((bucket) => bucket.domain),
	);
	if (!validDomains.has(domain as UnitDomain)) {
		throw new Error(
			`Unknown unit domain "${domain}". Valid domains: ${[...validDomains].sort().join(", ")}`,
		);
	}
	return DEFAULT_CATALOG.unit.filter((bucket) => bucket.domain === domain);
}

function commandStep(
	name: string,
	command: string,
	args: string[],
): CommandStep {
	return {
		kind: "command",
		name,
		command,
		args,
	};
}

export function planSteps(
	command: Command,
	args: string[] = [],
): CommandStep[] {
	switch (command) {
		case "list":
			return [];
		case "quick":
			return [
				commandStep("lint", "pnpm", ["lint"]),
				commandStep("typecheck", "pnpm", ["typecheck"]),
				{
					kind: "unit",
					name: "unit",
					mode: "test",
					buckets: DEFAULT_CATALOG.unit,
				},
				{
					kind: "integration",
					name: "integration",
					mode: "test",
					buckets: DEFAULT_CATALOG.integration,
				},
			];
		case "coverage":
			return [
				commandStep("lint", "pnpm", ["lint"]),
				commandStep("typecheck", "pnpm", ["typecheck"]),
				{
					kind: "unit",
					name: "unit coverage",
					mode: "coverage",
					buckets: DEFAULT_CATALOG.unit,
				},
				{
					kind: "integration",
					name: "integration",
					mode: "coverage",
					buckets: DEFAULT_CATALOG.integration,
				},
				{ kind: "e2e", name: "e2e" },
				{ kind: "fuzz", name: "fuzz" },
				{ kind: "stress", name: "stress" },
			];
		case "unit":
			return [
				{
					kind: "unit",
					name: args[0] ? `unit:${args[0]}` : "unit",
					mode: "test",
					buckets: unitBucketsForDomain(args[0]),
				},
			];
		case "integration":
			return [
				{
					kind: "integration",
					name: "integration",
					mode: "test",
					buckets: DEFAULT_CATALOG.integration,
				},
			];
		case "e2e":
			return [{ kind: "e2e", name: "e2e" }];
		case "fuzz":
			return [{ kind: "fuzz", name: "fuzz" }];
		case "stress":
			return [{ kind: "stress", name: "stress" }];
	}
}

export const USAGE_TEXT = `Usage: tsx scripts/test-runner.ts <command> [domain]

Commands:
  list
  quick
  coverage
  unit [platform|domain|finance|runtime]
  integration
  e2e
  fuzz
  stress
`;

export function parseCommand(rawCommand: string | undefined): Command {
	const commands = new Set<Command>([
		"list",
		"quick",
		"coverage",
		"unit",
		"integration",
		"e2e",
		"fuzz",
		"stress",
	]);
	if (rawCommand && commands.has(rawCommand as Command)) {
		return rawCommand as Command;
	}
	throw new Error(USAGE_TEXT);
}

export function listSuitesText(catalog = DEFAULT_CATALOG) {
	const lines: string[] = [
		"zmail test suites",
		"",
		"gates:",
		"  test          quick local gate",
		"  test:quick    lint, typecheck, unit, integration",
		"  test:coverage lint, typecheck, unit coverage, integration, e2e, fuzz, stress",
		"",
		"unit buckets:",
	];
	for (const bucket of catalog.unit) {
		lines.push(`  ${bucket.domain}/${bucket.name}`);
		for (const test of bucket.tests) {
			lines.push(`    ${test}`);
		}
	}
	lines.push("", "integration buckets:");
	for (const bucket of catalog.integration) {
		lines.push(`  ${bucket.name}`);
		for (const test of bucket.tests) {
			lines.push(`    ${test}`);
		}
	}
	lines.push("", "other harnesses:", "  e2e", "  fuzz", "  stress");
	return `${lines.join("\n")}\n`;
}

function vitestArgs(input: {
	bucket: UnitBucket | IntegrationBucket;
	mode: VitestMode;
	tests: string[];
}) {
	const args = [
		"exec",
		"vitest",
		"run",
		"--reporter=default",
		"--maxWorkers=1",
		"--minWorkers=1",
		"--no-file-parallelism",
		...input.tests,
	];
	if (
		input.mode === "coverage" &&
		"coverageInclude" in input.bucket &&
		input.bucket.coverageInclude.length > 0
	) {
		args.push(
			"--coverage",
			"--coverage.provider",
			"v8",
			"--coverage.reporter",
			"text",
			"--coverage.reporter",
			"json-summary",
			"--coverage.reportsDirectory",
			`coverage/${input.bucket.name}`,
			"--coverage.thresholds.statements",
			"0",
			"--coverage.thresholds.branches",
			"0",
			"--coverage.thresholds.functions",
			"0",
			"--coverage.thresholds.lines",
			"0",
		);
		for (const pattern of input.bucket.coverageInclude) {
			args.push("--coverage.include", pattern);
		}
	}
	return args;
}

function runSync(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv } = {},
) {
	return spawnSync(
		process.platform === "win32" ? `${command}.cmd` : command,
		args,
		{
			cwd: ROOT_DIR,
			env: {
				...process.env,
				...options.env,
				NODE_OPTIONS:
					process.env.NODE_OPTIONS?.trim() || "--max-old-space-size=4096",
			},
			stdio: "inherit",
		},
	);
}

function assertSuccess(
	result: SpawnSyncReturns<Buffer> | SpawnSyncReturns<string>,
) {
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function runVitestBuckets(
	buckets: Array<UnitBucket | IntegrationBucket>,
	mode: VitestMode,
	runCommand: RunCommand,
) {
	for (const bucket of buckets) {
		const isCoverage =
			mode === "coverage" &&
			"coverageInclude" in bucket &&
			bucket.coverageInclude.length > 0;
		const label = isCoverage ? bucket.name : `${bucket.name} (tests only)`;
		process.stdout.write(`\n==> Vitest bucket: ${label}\n`);
		assertSuccess(
			runCommand("pnpm", vitestArgs({ bucket, mode, tests: bucket.tests })),
		);
	}
}

async function waitForHealth(url: string) {
	const startedAt = Date.now();
	let lastError = "";
	while (Date.now() - startedAt < 180_000) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				return;
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	throw new Error(
		`Timed out waiting for stress server at ${url}: ${lastError}`,
	);
}

async function runManagedStress(runCommand: RunCommand) {
	const runtimeRoot = resolve(ROOT_DIR, "test/.runtime/stress");
	const dataDir = resolve(runtimeRoot, "data");
	const port = "3031";
	const baseUrl = `http://127.0.0.1:${port}`;
	const env = {
		...process.env,
		NODE_ENV: "test",
		PORT: port,
		RUN_WORKER: "true",
		ZMAIL_DATA_DIR: dataDir,
		ZMAIL_TEST_RUNTIME_ROOT: runtimeRoot,
		ZMAIL_PI_BACKEND: process.env.ZMAIL_PI_BACKEND ?? "auto",
		ZMAIL_TEST_AUTH_BYPASS: "true",
		ZMAIL_TEST_AUTH_ORG_ID: "local",
		ZMAIL_TEST_AUTH_ROLE: "org_admin",
		ZMAIL_BASE_URL: baseUrl,
	};

	await rm(runtimeRoot, { recursive: true, force: true });
	const server = spawn(
		process.platform === "win32" ? "pnpm.cmd" : "pnpm",
		["exec", "tsx", "test/e2e-playwright/webserver.ts"],
		{
			cwd: ROOT_DIR,
			env,
			stdio: "inherit",
		},
	);
	try {
		await waitForHealth(`${baseUrl}/healthz`);
		assertSuccess(runCommand("pnpm", ["raw:stress"], { env }));
	} finally {
		server.kill("SIGTERM");
		await new Promise((resolveKill) => {
			server.once("exit", resolveKill);
			setTimeout(resolveKill, 2_000);
		});
		await rm(runtimeRoot, { recursive: true, force: true });
	}
}

async function runSteps(steps: CommandStep[], runCommand: RunCommand) {
	for (const step of steps) {
		process.stdout.write(`\n==> ${step.name}\n`);
		switch (step.kind) {
			case "command":
				assertSuccess(runCommand(step.command ?? "pnpm", step.args ?? []));
				break;
			case "unit":
			case "integration":
				runVitestBuckets(
					(step.buckets ?? []) as Array<UnitBucket | IntegrationBucket>,
					step.mode ?? "test",
					runCommand,
				);
				break;
			case "e2e":
				assertSuccess(runCommand("pnpm", ["raw:e2e"]));
				break;
			case "fuzz":
				assertSuccess(runCommand("pnpm", ["raw:fuzz"]));
				break;
			case "stress":
				await runManagedStress(runCommand);
				break;
		}
	}
}

export async function main(
	argv = process.argv,
	runCommand: RunCommand = runSync,
) {
	validateDefaultCatalog();
	const command = parseCommand(argv[2]);
	const args = argv.slice(3).filter((arg) => arg.length > 0);
	if (command === "list") {
		process.stdout.write(listSuitesText());
		return;
	}
	await runSteps(planSteps(command, args), runCommand);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	});
}
