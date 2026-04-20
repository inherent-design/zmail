import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertConversationRow,
	insertMessageRow,
	seedTestAccount,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

async function loadServerApp(input?: {
	metricsEnabled?: boolean;
	role?: "org_admin" | "org_operator" | "org_viewer";
}) {
	const runtime = await createTestRuntime();
	process.env.NODE_ENV = "test";
	process.env.ZMAIL_TEST_AUTH_BYPASS = "true";
	process.env.ZMAIL_TEST_AUTH_ORG_ID = "local";
	process.env.ZMAIL_TEST_AUTH_ROLE = input?.role ?? "org_admin";
	process.env.ZMAIL_TEST_AUTH_EMAIL = "operator@inherent.design";
	if (input?.metricsEnabled) {
		process.env.ZMAIL_METRICS_ENABLED = "true";
	} else {
		delete process.env.ZMAIL_METRICS_ENABLED;
	}
	vi.resetModules();
	const { app } =
		await runtime.importFresh<typeof import("#/server/index")>(
			"#/server/index",
		);
	return { app, runtime };
}

describe("health and metrics routes", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("serves shallow health checks without auth", async () => {
		const { app } = await loadServerApp();

		const health = await app.request("http://localhost/healthz");
		expect(health.status).toBe(200);
		expect(health.headers.get("x-content-type-options")).toBe("nosniff");
		expect(health.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(health.headers.get("referrer-policy")).toBe("no-referrer");
		expect(health.headers.get("permissions-policy")).toContain("camera=()");
		await expect(health.json()).resolves.toMatchObject({
			ok: true,
			status: "ok",
			service: "zmail",
		});

		const ready = await app.request("http://localhost/readyz");
		expect(ready.status).toBe(200);
		await expect(ready.json()).resolves.toMatchObject({
			ok: true,
			status: "ready",
			metrics_enabled: false,
			log_file_enabled: false,
			base_path: "/",
			data_root_configured: true,
		});
	});

	it("returns 404 for metrics when disabled", async () => {
		const { app } = await loadServerApp();
		const response = await app.request("http://localhost/metrics");

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: "not_found",
		});
	});

	it("serves Prometheus metrics when enabled without leaking message data", async () => {
		const { app, runtime } = await loadServerApp({ metricsEnabled: true });
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-secret",
			emailAddress: "secret@example.com",
			syncStatus: "syncing",
		});
		const conversationId = await insertConversationRow(db, {
			id: "conv-secret",
			accountId: "acct-secret",
		});
		await insertMessageRow(db, {
			id: "msg-secret",
			accountId: "acct-secret",
			conversationId,
			subject: "Private Subject",
			snippet: "private snippet",
		});
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-secret",
		});

		const response = await app.request("http://localhost/metrics");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		const text = await response.text();
		expect(text).toContain("zmail_http_requests_total");
		expect(text).toContain("zmail_jobs_active");
		expect(text).toContain("zmail_sync_account_status");
		expect(text).not.toContain("secret@example.com");
		expect(text).not.toContain("Private Subject");
		expect(text).not.toContain("private snippet");
	});

	it("requires operator access for org health", async () => {
		const viewer = await loadServerApp({ role: "org_viewer" });
		await bootDb({ seedDefaultAccount: true });
		const denied = await viewer.app.request("http://localhost/ops/health");
		expect(denied.status).toBe(403);

		const operator = await loadServerApp({ role: "org_operator" });
		await bootDb({ seedDefaultAccount: true });
		const response = await operator.app.request("http://localhost/ops/health");
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			status: "ok",
			orgId: "local",
			storage: {
				sqliteReachable: true,
			},
			worker: {
				enabled: false,
			},
			sync: {
				accounts: 1,
			},
		});
	});

	it("counts only recent failed jobs in org health", async () => {
		const { app, runtime } = await loadServerApp({ role: "org_operator" });
		const { db } = await bootDb({ seedDefaultAccount: true });
		const jobs =
			await runtime.importFresh<typeof import("#/lib/jobs")>("#/lib/jobs");
		const recentFailedId = await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-recent-failed",
		});
		jobs.claimNextJob();
		await jobs.failJob(recentFailedId, new Error("recent boom"));
		const staleFailedId = await jobs.queueJob({
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-stale-failed",
		});
		jobs.claimNextJob();
		await jobs.failJob(staleFailedId, new Error("stale boom"));
		const staleTimestamp = new Date(
			Date.now() - 48 * 60 * 60 * 1000,
		).toISOString();
		await db
			.updateTable("jobs")
			.set({
				created_at: staleTimestamp,
				finished_at: staleTimestamp,
			})
			.where("id", "=", staleFailedId)
			.execute();

		const response = await app.request("http://localhost/ops/health");

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			worker: {
				failedRecentJobs: 1,
			},
		});
	});
});
