import { describe, expect, it } from "vitest";

import {
	decodeUiNodeToken,
	dropNodesCoveredByIslands,
	encodeUiNodeToken,
	normalizeUiTargets,
	partitionUiTargets,
	uiMutationEnvelopeSchema,
} from "#/lib/ui-targets";

describe("ui targets", () => {
	it("dedupes targets while preserving refresh order", () => {
		const targets = normalizeUiTargets([
			{ type: "node", islandId: "finance.ledger", nodeId: "row", key: "a" },
			{ type: "island", id: "finance.ledger" },
			{ type: "main" },
			{ type: "redirect", url: "/accounts" },
			{ type: "island", id: "finance.ledger" },
		]);

		expect(targets.map((target) => target.type)).toEqual([
			"redirect",
			"main",
			"island",
			"node",
		]);
	});

	it("partitions and prunes nodes covered by islands", () => {
		const targets = [
			{ type: "island" as const, id: "finance.ledger" },
			{
				type: "node" as const,
				islandId: "finance.ledger",
				nodeId: "finance.ledger.row",
				key: "row-1",
			},
			{
				type: "node" as const,
				islandId: "runs.jobs",
				nodeId: "runs.job.row",
				key: "job-1",
			},
		];

		const partitioned = partitionUiTargets(targets);
		expect(partitioned.islands).toHaveLength(1);
		expect(partitioned.nodes).toHaveLength(2);
		expect(dropNodesCoveredByIslands(targets)).toEqual([
			{ type: "island", id: "finance.ledger" },
			{
				type: "node",
				islandId: "runs.jobs",
				nodeId: "runs.job.row",
				key: "job-1",
			},
		]);
	});

	it("encodes and decodes keyed node tokens", () => {
		const token = encodeUiNodeToken({
			nodeId: "finance:ledger.row",
			key: "acct:row 1",
		});
		expect(token).toBe("finance%3Aledger.row:acct%3Arow%201");
		expect(decodeUiNodeToken(token)).toEqual({
			nodeId: "finance:ledger.row",
			key: "acct:row 1",
		});
	});

	it("rejects unknown target types and extra contract keys", () => {
		expect(() =>
			normalizeUiTargets([
				{
					type: "node",
					islandId: "finance.ledger",
					nodeId: "finance.ledger.row",
					key: "row-1",
					extra: true,
				},
			]),
		).toThrow();
		expect(() =>
			normalizeUiTargets([{ type: "panel", id: "finance.ledger" }]),
		).toThrow();
		expect(() =>
			uiMutationEnvelopeSchema.parse({
				ok: true,
				status: "queued",
				ui: {
					toast: { tone: "success", text: "Queued.", extra: true },
				},
			}),
		).toThrow();
	});
});
