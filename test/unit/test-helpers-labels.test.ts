import { describe, expect, it } from "vitest";

import {
	buildFinanceIntelV2,
	buildFinanceIntelV3,
	buildLegacyFinanceIntelV1,
	buildLegacyMessageLabelV1,
	buildManualOverrideLabelV2,
	buildManualOverrideLabelV3,
	buildMessageLabelV2,
	buildMessageLabelV3,
} from "#/test/helpers/labels";

describe("test/helpers/labels", () => {
	it("builds current v3 label fixtures", () => {
		const label = buildMessageLabelV3({
			routing: {
				primaryBucket: "knowledge",
				secondaryBuckets: ["resources"],
				tags: ["docs"],
			},
		});

		expect(label.schemaVersion).toBe("message-label.v3");
		expect(label.routing.primaryBucket).toBe("knowledge");
		expect(label.routing.secondaryBuckets).toEqual(["resources"]);
	});

	it("builds current manual override v3 fixtures", () => {
		const label = buildManualOverrideLabelV3();

		expect(label.schemaVersion).toBe("message-label.v3");
		expect(label.finance.relevant).toBe(true);
		expect(label.finance.requiresFinanceIntel).toBe(true);
		expect(label.routing.primaryBucket).toBe("finance");
		expect(label.routing.secondaryBuckets).toContain("receipt");
	});

	it("builds current finance-intel v3 fixtures", () => {
		const result = buildFinanceIntelV3();

		expect(result.schemaVersion).toBe("finance-intel.v3");
		expect(result.transactionCandidates[0]?.categoryPrimary).toBe(
			"software_services",
		);
		expect(result.transactionCandidates[0]?.dedupe.emailEvidenceKey).toBe(
			"msg-key",
		);
	});

	it("keeps explicit legacy builders available for compatibility tests", () => {
		const label = buildLegacyMessageLabelV1();
		const result = buildLegacyFinanceIntelV1();
		const v2Label = buildMessageLabelV2();
		const v2Intel = buildFinanceIntelV2();
		const v2Override = buildManualOverrideLabelV2();

		expect(label.schemaVersion).toBe("message-label.v1");
		expect(result.schemaVersion).toBe("finance-intel.v1");
		expect(v2Label.schemaVersion).toBe("message-label.v2");
		expect(v2Intel.schemaVersion).toBe("finance-intel.v2");
		expect(v2Override.schemaVersion).toBe("message-label.v2");
	});
});
