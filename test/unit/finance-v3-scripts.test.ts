import { describe, expect, it } from "vitest";

import { parseClassifyMigrateFinanceV3Args } from "#/scripts/classify-migrate-finance-v3";
import { parseFinanceExportArgs } from "#/scripts/export-finance-beancount";

describe("finance v3 scripts", () => {
	it("parses finance export args", () => {
		expect(
			parseFinanceExportArgs([
				"node",
				"script",
				"--org",
				"org_1",
				"--out",
				"/tmp/export",
				"--year",
				"2026",
				"--strict",
				"--force",
			]),
		).toEqual({
			orgId: "org_1",
			outDir: "/tmp/export",
			year: 2026,
			strict: true,
			force: true,
		});

		expect(() =>
			parseFinanceExportArgs(["node", "script", "--org", "org_1"]),
		).toThrow("finance:export requires");
	});

	it("parses finance v3 migration args with safety gates", () => {
		expect(
			parseClassifyMigrateFinanceV3Args([
				"node",
				"script",
				"--org",
				"org_1",
				"--archive",
				"--reclassify",
				"--dry-run",
			]),
		).toMatchObject({
			orgId: "org_1",
			archive: true,
			reclassify: true,
			dryRun: true,
		});

		expect(() =>
			parseClassifyMigrateFinanceV3Args([
				"node",
				"script",
				"--org",
				"org_1",
				"--archive",
			]),
		).toThrow("pass --dry-run or --confirm");

		expect(() =>
			parseClassifyMigrateFinanceV3Args([
				"node",
				"script",
				"--org",
				"org_1",
				"--all-orgs",
				"--dry-run",
			]),
		).toThrow("either --org <orgId> or --all-orgs");
	});
});
