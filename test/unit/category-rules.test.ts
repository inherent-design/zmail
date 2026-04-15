import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootDb, insertMessageLabelRow, insertMessageRow } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("category rules", () => {
	it("materializes default classification yaml files on first load", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });
		const rules =
			await runtime.importFresh<typeof import("#/lib/category-rules")>(
				"#/lib/category-rules",
			);

		const config = await rules.loadClassificationConfig();
		const baseDir = join(runtime.dataDir, "operator", "classification");

		expect(config.rootTaxonomy.primaryBuckets).toContain("finance");
		expect(
			config.financeTaxonomy.categories.some((row) => row.primary === "income"),
		).toBe(true);
		expect(config.rules.length).toBeGreaterThan(0);
		expect(existsSync(join(baseDir, "root-taxonomy.yaml"))).toBe(true);
		expect(existsSync(join(baseDir, "finance-taxonomy.yaml"))).toBe(true);
		expect(existsSync(join(baseDir, "rules.yaml"))).toBe(true);
		expect(readFileSync(join(baseDir, "root-taxonomy.yaml"), "utf8")).toContain(
			"schemaVersion: root-taxonomy.v1",
		);
		expect(
			readFileSync(join(baseDir, "finance-taxonomy.yaml"), "utf8"),
		).toContain("schemaVersion: finance-taxonomy.v1");
		expect(readFileSync(join(baseDir, "rules.yaml"), "utf8")).toContain(
			"schemaVersion: classification-rules.v1",
		);
	});

	it("lists messages without assignment heads as pending rebuild work", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const rules =
			await runtime.importFresh<typeof import("#/lib/category-rules")>(
				"#/lib/category-rules",
			);
		const messageId = await insertMessageRow(db, {
			contentSha256: "category-pending-sha",
		});
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "category-pending-sha",
		});

		const pendingIds = await rules.listPendingMessageCategoryAssignmentIds({
			limit: 10,
		});

		expect(pendingIds).toContain(messageId);
	});
});
