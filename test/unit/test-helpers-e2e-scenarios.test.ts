import { describe, expect, it } from "vitest";

import {
	PLAYWRIGHT_ACCOUNT_IDS,
	PLAYWRIGHT_SCENARIOS,
	buildFinanceScenarioIntel,
	buildSeededReviewLabel,
} from "#/test/e2e-playwright/scenarios";

describe("test/e2e-playwright/scenarios", () => {
	it("uses dedicated account ids per browser flow", () => {
		expect(new Set(PLAYWRIGHT_ACCOUNT_IDS).size).toBe(
			PLAYWRIGHT_ACCOUNT_IDS.length,
		);
		expect(PLAYWRIGHT_SCENARIOS.review.account.id).not.toBe(
			PLAYWRIGHT_SCENARIOS.backlog.account.id,
		);
		expect(PLAYWRIGHT_SCENARIOS.delete.account.id).not.toBe(
			PLAYWRIGHT_SCENARIOS.review.account.id,
		);
	});

	it("seeds the review scenario with a current v2 low-confidence label", () => {
		const label = buildSeededReviewLabel();

		expect(label.schemaVersion).toBe("message-label.v2");
		expect(label.routing.primaryBucket).toBe("finance");
		expect(label.routing.tags).toContain("review");
	});

	it("seeds the finance scenario with v2 finance intel", () => {
		const result = buildFinanceScenarioIntel();

		expect(result.schemaVersion).toBe("finance-intel.v2");
		expect(result.transactionCandidates[0]?.institutionRef).toBe(
			"inst:finance-bank",
		);
	});
});
