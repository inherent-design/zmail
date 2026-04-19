import { describe, expect, it } from "vitest";

import {
	listSuitesText,
	parseCommand,
	planSteps,
	unitBucketsForDomain,
	validateCatalog,
} from "#/scripts/test-runner";

describe("test runner catalog", () => {
	it("lists domains, buckets, and gates", () => {
		const text = listSuitesText();

		expect(text).toContain("test:quick");
		expect(text).toContain("test:coverage");
		expect(text).toContain("platform/platform-config");
		expect(text).toContain("finance/domain-finance");
		expect(text).toContain("runtime/runtime-worker");
		expect(text).toContain("test/unit/test-runner.test.ts");
	});

	it("rejects unknown commands with usage", () => {
		expect(() => parseCommand("unknown")).toThrow(
			"Usage: tsx scripts/test-runner.ts",
		);
	});

	it("rejects unknown unit domains with valid domains", () => {
		expect(() => unitBucketsForDomain("missing")).toThrow(
			'Unknown unit domain "missing". Valid domains: domain, finance, platform, runtime',
		);
	});

	it("detects orphaned unit tests", () => {
		expect(() =>
			validateCatalog({
				catalog: {
					unit: [
						{
							domain: "platform",
							name: "platform-test",
							tests: [],
							coverageInclude: [],
						},
					],
					integration: [],
				},
				unitFiles: ["test/unit/orphan.test.ts"],
				integrationFiles: [],
			}),
		).toThrow(
			"Unit test is not assigned to a bucket: test/unit/orphan.test.ts",
		);
	});

	it("detects duplicate unit test assignments", () => {
		expect(() =>
			validateCatalog({
				catalog: {
					unit: [
						{
							domain: "platform",
							name: "first",
							tests: ["test/unit/example.test.ts"],
							coverageInclude: [],
						},
						{
							domain: "runtime",
							name: "second",
							tests: ["test/unit/example.test.ts"],
							coverageInclude: [],
						},
					],
					integration: [],
				},
				unitFiles: ["test/unit/example.test.ts"],
				integrationFiles: [],
			}),
		).toThrow(
			"Unit test is assigned to multiple buckets: test/unit/example.test.ts (first, second)",
		);
	});

	it("selects finance unit buckets", () => {
		const buckets = unitBucketsForDomain("finance");

		expect(buckets.map((bucket) => bucket.name)).toEqual(["domain-finance"]);
	});

	it("expands quick to lint, typecheck, unit, and integration", () => {
		expect(planSteps("quick").map((step) => step.kind)).toEqual([
			"command",
			"command",
			"unit",
			"integration",
		]);
	});

	it("expands coverage without duplicate plain Vitest passes", () => {
		const steps = planSteps("coverage");

		expect(steps.map((step) => step.kind)).toEqual([
			"command",
			"command",
			"unit",
			"integration",
			"e2e",
			"fuzz",
			"stress",
		]);
		expect(steps.filter((step) => step.kind === "unit")).toHaveLength(1);
		expect(steps.filter((step) => step.kind === "integration")).toHaveLength(1);
		expect(steps.find((step) => step.kind === "unit")).toMatchObject({
			mode: "coverage",
		});
	});
});
