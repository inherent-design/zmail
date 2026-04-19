import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootDb, seedTestAccount } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("observability", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("normalizes HTTP routes without raw identifiers", async () => {
		const runtime = await createTestRuntime();
		const observability =
			await runtime.importFresh<typeof import("#/lib/observability")>(
				"#/lib/observability",
			);

		expect(observability.normalizeHttpRoute("/messages/msg-123")).toBe(
			"/messages/:messageId",
		);
		expect(
			observability.normalizeHttpRoute("/accounts/acct-1/reconnect"),
		).toBe("/accounts/:accountId/reconnect");
		expect(
			observability.normalizeHttpRoute("/rpc/accounts/acct-1/sync/full"),
		).toBe("/rpc/accounts/:accountId/sync/full");
		expect(
			observability.normalizeHttpRoute("/rpc/messages/msg-1/classify"),
		).toBe("/rpc/messages/:messageId/classify");
		expect(observability.normalizeHttpRoute("/assets/app.abc.js")).toBe(
			"/assets/*",
		);
		expect(observability.normalizeHttpRoute("/unknown/raw-id")).toBe(
			"/unknown/*",
		);
	});

	it("records HTTP metrics and refreshes DB gauges", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-metrics",
			emailAddress: "private@example.com",
			syncStatus: "backfilling",
		});
		const jobs = await runtime.importFresh<typeof import("#/lib/jobs")>(
			"#/lib/jobs",
		);
		await jobs.queueJob({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "acct-metrics",
		});
		const observability =
			await runtime.importFresh<typeof import("#/lib/observability")>(
				"#/lib/observability",
			);

		observability.recordHttpRequest({
			method: "GET",
			route: "/accounts/:accountId",
			status: 200,
			durationMs: 25,
		});

		const metrics = await observability.metricsText();
		expect(metrics).toContain("zmail_http_requests_total");
		expect(metrics).toContain("zmail_jobs_active");
		expect(metrics).toContain("zmail_sync_account_status");
		expect(metrics).not.toContain("private@example.com");
		expect(metrics).not.toContain("acct-1/reconnect");
	});
});

