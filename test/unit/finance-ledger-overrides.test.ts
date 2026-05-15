import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("finance ledger overrides", () => {
	it("reapplies active metadata and relationship patches to rebuilt entries", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await db
			.insertInto("finance_ledger_entry_overrides")
			.values({
				id: "override-1",
				canonical_key: "entry-1",
				patch_json: JSON.stringify({
					status: "ready",
					occurredAt: "2026-02",
					postedAt: "2026-02-03T00:00:00.000Z",
					categoryPrimary: "travel",
					categorySecondary: "airfare",
				}),
				relationship_patch_json: JSON.stringify({
					ownerIdentityId: "owner-1",
					relatedMessageIds: ["msg-1"],
				}),
				note: null,
				actor_ref: "test",
				status: "active",
				created_at: "2026-01-05T00:00:00.000Z",
				updated_at: "2026-01-05T00:00:00.000Z",
				superseded_at: null,
			})
			.execute();
		const entries = new Map<string, Record<string, unknown>>([
			[
				"entry-1",
				{
					status: "review",
					occurred_at: "2026-01-01",
					occurred_at_precision: "day",
					posted_at: null,
					posted_at_precision: "unknown",
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "uncategorized",
					}),
				},
			],
		]);

		const financeLedgerOverrides = await runtime.importFresh<
			typeof import("#/lib/finance-ledger-overrides")
		>("#/lib/finance-ledger-overrides");
		await financeLedgerOverrides.reapplyActiveFinanceLedgerOverrides(entries);

		const entry = entries.get("entry-1");
		const metadata = JSON.parse(String(entry?.ledger_metadata_json));
		expect(entry?.status).toBe("ready");
		expect(entry?.occurred_at).toBe("2026-02");
		expect(entry?.occurred_at_precision).toBe("month");
		expect(entry?.posted_at).toBe("2026-02-03T00:00:00.000Z");
		expect(entry?.posted_at_precision).toBe("datetime");
		expect(metadata).toMatchObject({
			categoryPrimary: "travel",
			categorySecondary: "airfare",
			ownerIdentityId: "owner-1",
			manualRelationships: {
				ownerIdentityId: "owner-1",
				relatedMessageIds: ["msg-1"],
			},
		});
	});
});
