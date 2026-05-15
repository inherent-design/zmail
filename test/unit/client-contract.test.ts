import { describe, expect, it } from "vitest";

import {
	normalizeInvalidationKeys,
	parseClientMutationEnvelope,
} from "#/lib/client-contract";

describe("client mutation contract", () => {
	it("accepts invalidation envelopes", () => {
		const parsed = parseClientMutationEnvelope({
			ok: true,
			status: "queued",
			toast: { tone: "success", text: "Queued." },
			redirectTo: "/runs",
			invalidate: ["zmail:finance", "zmail:runs"],
			jobs: [{ jobId: "job-1", kind: "finance", scopeId: "local" }],
			events: [
				{ topic: "finance", eventType: "job.updated", entityId: "job-1" },
			],
		});

		expect(parsed.invalidate).toEqual(["zmail:finance", "zmail:runs"]);
	});

	it("rejects removed ui targets", () => {
		expect(() =>
			parseClientMutationEnvelope({
				ok: true,
				status: "ok",
				ui: { targets: [{ type: "main" }] },
			}),
		).toThrow();
	});

	it("dedupes invalidation keys", () => {
		expect(
			normalizeInvalidationKeys([
				"zmail:finance",
				"zmail:finance",
				"zmail:account:acct-1",
			]),
		).toEqual(["zmail:finance", "zmail:account:acct-1"]);
	});
});
