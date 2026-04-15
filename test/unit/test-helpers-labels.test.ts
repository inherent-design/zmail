import { describe, expect, it } from "vitest";

import {
	buildFinanceIntelV2,
	buildLegacyFinanceIntelV1,
	buildLegacyMessageLabelV1,
	buildManualOverrideLabelV2,
	buildMessageLabelV2,
} from "#/test/helpers/labels";

describe("test/helpers/labels", () => {
	it("builds current v2 label fixtures", () => {
		const label = buildMessageLabelV2({
			routing: {
				primaryBucket: "knowledge",
				secondaryBuckets: ["resources"],
				tags: ["docs"],
			},
		});

		expect(label.schemaVersion).toBe("message-label.v2");
		expect(label.routing.primaryBucket).toBe("knowledge");
		expect(label.routing.secondaryBuckets).toEqual(["resources"]);
	});

	it("builds current manual override v2 fixtures", () => {
		const label = buildManualOverrideLabelV2();

		expect(label.schemaVersion).toBe("message-label.v2");
		expect(label.finance.relevant).toBe(true);
		expect(label.routing.primaryBucket).toBe("finance");
		expect(label.routing.secondaryBuckets).toContain("receipt");
	});

	it("builds current finance-intel v2 fixtures", () => {
		const result = buildFinanceIntelV2();

		expect(result.schemaVersion).toBe("finance-intel.v2");
		expect(result.transactionCandidates[0]?.categoryPrimary).toBe("shopping");
		expect(result.documentCandidates[0]?.documentType).toBe("receipt");
	});

	it("keeps explicit legacy builders available for compatibility tests", () => {
		const label = buildLegacyMessageLabelV1();
		const result = buildLegacyFinanceIntelV1();

		expect(label.schemaVersion).toBe("message-label.v1");
		expect(result.schemaVersion).toBe("finance-intel.v1");
	});
});
