import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertAccountSyncStateRow,
	insertConversationRow,
	insertMessageLabelRow,
	insertMessageRow,
	insertMessageSourceRow,
	insertReviewRow,
	seedTestAccount,
} from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

async function loadServerApp(input?: {
	basePath?: string;
	role?: "org_admin" | "org_operator" | "org_viewer";
	email?: string;
}) {
	const runtime = await createTestRuntime();
	process.env.NODE_ENV = "test";
	process.env.ZMAIL_TEST_AUTH_BYPASS = "true";
	process.env.ZMAIL_TEST_AUTH_ORG_ID = "local";
	process.env.ZMAIL_TEST_AUTH_ROLE = input?.role ?? "org_admin";
	process.env.ZMAIL_TEST_AUTH_EMAIL = input?.email ?? "mannie@inherent.design";
	if (input?.basePath) {
		process.env.ZMAIL_BASE_PATH = input.basePath;
	} else {
		delete process.env.ZMAIL_BASE_PATH;
	}
	vi.resetModules();
	const { app } =
		await runtime.importFresh<typeof import("#/server/index")>(
			"#/server/index",
		);
	return { app, runtime };
}

describe("Hono web routes", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("renders the live shell and primary page routes", async () => {
		const { app } = await loadServerApp();
		const { db } = await bootDb();
		const runtimeEvents = await import("#/lib/runtime-events");
		await seedTestAccount(db, {
			id: "acct-1",
			label: "Primary Account",
			emailAddress: "primary@example.com",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		await insertAccountSyncStateRow(db, {
			accountId: "acct-1",
			watcherStatus: "running",
		});
		const conversationId = await insertConversationRow(db, {
			id: "conv-1",
			accountId: "acct-1",
			gmailThreadId: "thread-1",
		});
		const messageId = await insertMessageRow(db, {
			id: "msg-1",
			accountId: "acct-1",
			conversationId,
			subject: "Route coverage message",
			snippet: "Review this message",
			contentSha256: "content-msg-1",
		});
		await insertMessageSourceRow(db, {
			messageId,
			accountId: "acct-1",
			remoteMessageId: "remote-msg-1",
			remoteThreadId: "remote-thread-1",
		});
		await insertMessageLabelRow(db, {
			messageId,
			contentSha256: "content-msg-1",
			primaryBucket: "review",
		});
		await insertReviewRow(db, {
			id: "review-1",
			messageId,
			sourceClassificationResultId: `classification-${messageId}`,
		});
		const latestEvent = await runtimeEvents.publishActionEvent({
			topic: "jobs",
			eventType: "job.updated",
			entityKind: "job",
			entityId: "job-route-test",
			payload: {
				jobId: "job-route-test",
				status: "queued",
			},
		});

		const home = await app.request("http://localhost/");
		expect(home.status).toBe(200);
		const homeHtml = await home.text();
		expect(homeHtml).toContain("Gmail live-sync analysis workspace.");
		expect(homeHtml).toContain('"echarts/":"/vendor/echarts/"');
		expect(homeHtml).toContain('"tslib":"/vendor/tslib/tslib.es6.js"');
		expect(homeHtml).not.toContain("&quot;echarts/&quot;");
		expect(homeHtml).toContain(
			`data-zmail-event-cursor="${String(latestEvent.id)}"`,
		);
		expect(homeHtml).toContain('data-zmail-state-scope="org:local"');
		expect(homeHtml).not.toContain('data-zmail-state-scope="local"');
		expect(homeHtml).toContain(`data-event-cursor="${String(latestEvent.id)}"`);

		const accounts = await app.request("http://localhost/accounts");
		expect(accounts.status).toBe(200);
		const accountsHtml = await accounts.text();
		expect(accountsHtml).toContain("<h1>Accounts</h1>");
		expect(accountsHtml).toContain("Connect Gmail");

		const accountDetail = await app.request("http://localhost/accounts/acct-1");
		expect(accountDetail.status).toBe(200);
		const accountDetailHtml = await accountDetail.text();
		expect(accountDetailHtml).toContain("Classify backlog");
		expect(accountDetailHtml).toContain("Delete local account");
		expect(accountDetailHtml).toContain("<h2>Mailbox sync</h2>");

		const messages = await app.request(
			"http://localhost/messages?q=Route&pageSize=50",
		);
		expect(messages.status).toBe(200);
		const messagesHtml = await messages.text();
		expect(messagesHtml).toContain("Route coverage message");
		expect(messagesHtml).toContain('name="q"');
		expect(messagesHtml).toContain("Page 1 of 1");
		expect(messagesHtml).not.toContain("Latest 250 normalized messages.");

		const messageDetail = await app.request("http://localhost/messages/msg-1");
		expect(messageDetail.status).toBe(200);
		const messageDetailHtml = await messageDetail.text();
		expect(messageDetailHtml).toContain("Classify now");
		expect(messageDetailHtml).toContain("Current label");

		const review = await app.request("http://localhost/review");
		expect(review.status).toBe(200);
		await expect(review.text()).resolves.toContain(
			"Review classifier findings",
		);

		const finance = await app.request("http://localhost/finance");
		expect(finance.status).toBe(200);
		const financeHtml = await finance.text();
		expect(financeHtml).toContain("Registry has not been imported yet.");
		expect(financeHtml).toContain("<h2>Filters</h2>");

		const runs = await app.request("http://localhost/runs");
		expect(runs.status).toBe(200);
		const runsHtml = await runs.text();
		expect(runsHtml).toContain("<h1>Runs</h1>");
		expect(runsHtml).toContain("<th>ETA</th>");
		expect(runsHtml).toContain("<th>Progress</th>");
	});

	it("returns fragment-only finance content for enhanced navigation", async () => {
		const { app } = await loadServerApp();
		await bootDb({ seedDefaultAccount: true });
		const runtimeEvents = await import("#/lib/runtime-events");
		const latestEvent = await runtimeEvents.publishActionEvent({
			topic: "finance",
			eventType: "job.updated",
			entityKind: "job",
			entityId: "job-fragment-test",
			payload: {
				jobId: "job-fragment-test",
				status: "running",
			},
		});

		const response = await app.request("http://localhost/finance", {
			headers: {
				"X-Zmail-Partial": "main",
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Zmail-Title")).toBe("Finance");
		expect(response.headers.get("X-Zmail-Url")).toBe("/finance");
		expect(response.headers.get("X-Zmail-Page")).toBe("finance");
		expect(response.headers.get("X-Zmail-Event-Cursor")).toBe(
			String(latestEvent.id),
		);
		const html = await response.text();
		expect(html).toContain('id="app-main"');
		expect(html).toContain(`data-event-cursor="${String(latestEvent.id)}"`);
		expect(html).not.toContain("<html");
	});

	it("returns requested finance island fragments only", async () => {
		const { app } = await loadServerApp();
		await bootDb({ seedDefaultAccount: true });
		const runtimeEvents = await import("#/lib/runtime-events");
		const latestEvent = await runtimeEvents.publishActionEvent({
			topic: "finance",
			eventType: "finance.ledger_rebuilt",
			entityKind: "finance",
			entityId: "ledger",
			payload: {
				status: "complete",
			},
		});

		const response = await app.request("http://localhost/finance", {
			headers: {
				"X-Zmail-Partial": "islands",
				"X-Zmail-Islands": "finance.summary,finance.cashflow",
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Zmail-Page")).toBe("finance");
		expect(response.headers.get("X-Zmail-Event-Cursor")).toBe(
			String(latestEvent.id),
		);
		expect(response.headers.get("X-Zmail-Islands")).toBe(
			"finance.summary,finance.cashflow",
		);
		const html = await response.text();
		expect(html).toContain('data-zmail-island-fragments="finance"');
		expect(html).toContain('data-zmail-island="finance.summary"');
		expect(html).toContain('data-zmail-island="finance.cashflow"');
		expect(html).not.toContain('id="app-main"');
		expect(html).not.toContain('data-zmail-island="finance.filters"');
	});

	it("returns requested account, home, and runs island fragments only", async () => {
		const { app } = await loadServerApp();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-islands",
			label: "Island Account",
			emailAddress: "islands@example.com",
		});
		await insertAccountSyncStateRow(db, {
			accountId: "acct-islands",
			backfillSnapshotUid: 200,
			backfillNextUid: 50,
		});

		const account = await app.request(
			"http://localhost/accounts/acct-islands",
			{
				headers: {
					"X-Zmail-Partial": "islands",
					"X-Zmail-Islands": "account.mailbox-sync,account.lanes",
				},
			},
		);
		expect(account.status).toBe(200);
		expect(account.headers.get("X-Zmail-Islands")).toBe(
			"account.mailbox-sync,account.lanes",
		);
		const accountHtml = await account.text();
		expect(accountHtml).toContain('data-zmail-island="account.mailbox-sync"');
		expect(accountHtml).toContain('data-zmail-island="account.lanes"');
		expect(accountHtml).not.toContain('data-zmail-island="account.header"');
		expect(accountHtml).not.toContain('id="app-main"');

		const home = await app.request("http://localhost/", {
			headers: {
				"X-Zmail-Partial": "islands",
				"X-Zmail-Islands": "home.stats,home.lanes",
			},
		});
		expect(home.status).toBe(200);
		expect(home.headers.get("X-Zmail-Islands")).toBe("home.stats,home.lanes");
		const homeHtml = await home.text();
		expect(homeHtml).toContain('data-zmail-island="home.stats"');
		expect(homeHtml).toContain('data-zmail-island="home.lanes"');
		expect(homeHtml).not.toContain('data-zmail-island="home.actions"');

		const runs = await app.request("http://localhost/runs", {
			headers: {
				"X-Zmail-Partial": "islands",
				"X-Zmail-Islands": "runs.lanes,runs.jobs",
			},
		});
		expect(runs.status).toBe(200);
		expect(runs.headers.get("X-Zmail-Islands")).toBe("runs.lanes,runs.jobs");
		const runsHtml = await runs.text();
		expect(runsHtml).toContain('data-zmail-island="runs.lanes"');
		expect(runsHtml).toContain('data-zmail-island="runs.jobs"');
		expect(runsHtml).not.toContain("<h1>Runs</h1>");
	});

	it("returns the active finance tab island without unrelated tab content", async () => {
		const { app } = await loadServerApp();
		await bootDb({ seedDefaultAccount: true });

		const response = await app.request(
			"http://localhost/finance?tab=mappings",
			{
				headers: {
					"X-Zmail-Partial": "islands",
					"X-Zmail-Islands": "finance.mappings",
				},
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Zmail-Islands")).toBe("finance.mappings");
		const html = await response.text();
		expect(html).toContain('data-zmail-island="finance.mappings"');
		expect(html).toContain("YAML-backed mapping editor");
		expect(html).not.toContain("Readiness workbench");
		expect(html).not.toContain("Review classifier findings");
		expect(html).not.toContain('data-zmail-island="finance.ledger-preview"');
	});

	it("escapes JSON island props in raw script bodies", async () => {
		const { app } = await loadServerApp();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const hostile = "</script><img src=x onerror=alert(1)>";

		await db
			.insertInto("finance_ledger_entries")
			.values({
				id: "ledger-hostile-category",
				canonical_key: "hostile-category:2026-03-15",
				status: "ready",
				source_authority: "email",
				occurred_at: "2026-03-15",
				posted_at: null,
				cleared_at: null,
				description: "Hostile category fixture",
				counterparty: "Fixture",
				direction: "expense",
				amount_value: "12.34",
				amount_minor: 1234,
				currency: "USD",
				book: "business",
				business_use_percent: null,
				debit_account: null,
				credit_account: null,
				account_mapping_key: null,
				field_confidence_json: JSON.stringify({ overall: 1 }),
				ledger_metadata_json: JSON.stringify({
					categoryPrimary: hostile,
					categorySecondary: "fixture",
				}),
				raw_payload_json: JSON.stringify({ seeded: true }),
				created_at: "2026-03-31T00:00:00.000Z",
				updated_at: "2026-03-31T00:00:00.000Z",
			})
			.execute();

		const response = await app.request("http://localhost/finance?year=2026");

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("\\u003c/script");
		expect(html).not.toContain("<img src=x");
		const dom = new JSDOM(html);
		const script = dom.window.document.querySelector(
			'script[data-zmail-island-props="finance.categories"]',
		);
		expect(script).not.toBeNull();
		const props = JSON.parse(script?.textContent ?? "{}");
		expect(props.categories[0].primaryCategory).toBe(hostile);
	});

	it("marks missing finance islands for same-page fallback", async () => {
		const { app } = await loadServerApp();
		await bootDb({ seedDefaultAccount: true });

		const response = await app.request("http://localhost/finance", {
			headers: {
				"X-Zmail-Partial": "islands",
				"X-Zmail-Islands": "finance.unknown",
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Zmail-Islands")).toBe("");
		expect(response.headers.get("X-Zmail-Island-Missing")).toBe(
			"finance.unknown",
		);
		const html = await response.text();
		expect(html).toContain('data-zmail-island-fragments="finance"');
		expect(html).not.toContain("finance.unknown");
	});

	it("mounts browser pages under a non-root base path", async () => {
		const { app } = await loadServerApp({ basePath: "/zmail" });
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			label: "Base Path Account",
			emailAddress: "basepath@example.com",
		});
		const response = await app.request("http://localhost/zmail/accounts");

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<h1>Accounts</h1>");
		expect(html).toContain('href="/zmail/accounts/new"');
	});

	it("serves browser vendor assets without app shell fallback", async () => {
		const { app } = await loadServerApp();
		await bootDb();

		for (const path of [
			"/vendor/echarts/core.js",
			"/vendor/tslib/tslib.es6.js",
			"/vendor/zrender/lib/zrender.js",
		]) {
			const response = await app.request(`http://localhost${path}`);
			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).not.toContain("<html");
			expect(body).not.toContain('id="app-main"');
		}

		const missing = await app.request(
			"http://localhost/vendor/echarts/not-found.js",
		);
		expect(missing.status).toBe(404);
		await expect(missing.text()).resolves.not.toContain('id="app-main"');

		const missingTslib = await app.request(
			"http://localhost/vendor/tslib/not-found.js",
		);
		expect(missingTslib.status).toBe(404);
		await expect(missingTslib.text()).resolves.not.toContain('id="app-main"');
	});

	it("renders a friendly WorkOS role-configuration shell error", async () => {
		vi.doMock("#/server/auth", async () => {
			const actual =
				await vi.importActual<typeof import("#/server/auth")>("#/server/auth");
			return {
				...actual,
				createOrganizationForBrowserSession: vi.fn(async () => {
					throw new actual.WorkOsRoleConfigurationError(
						new Error("role is invalid"),
					);
				}),
			};
		});

		try {
			const { app } = await loadServerApp();
			await bootDb();
			const response = await app.request("http://localhost/org/create", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					organizationName: "Inherent",
				}).toString(),
			});

			expect(response.status).toBe(500);
			const html = await response.text();
			expect(html).toContain("Authentication configuration error");
			expect(html).toContain(
				"zmail could not ensure required WorkOS environment roles.",
			);
			expect(html).not.toContain("role is invalid");
		} finally {
			vi.doUnmock("#/server/auth");
		}
	});

	it("lets viewer owners load account lifecycle pages and hides operator-only actions", async () => {
		const { app } = await loadServerApp({
			role: "org_viewer",
			email: "owner@inherent.design",
		});
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-owner",
			label: "Owner Account",
			emailAddress: "owner-account@example.com",
			ownerPrincipalEmail: "owner@inherent.design",
			syncEnabled: 0,
			syncStatus: "needs_reconnect",
		});

		const newPage = await app.request("http://localhost/accounts/new");
		expect(newPage.status).toBe(200);

		const detail = await app.request("http://localhost/accounts/acct-owner");
		expect(detail.status).toBe(200);
		const detailHtml = await detail.text();
		expect(detailHtml).toContain("Reconnect Gmail");
		expect(detailHtml).toContain("Delete local account");
		expect(detailHtml).not.toContain("Classify backlog");
		expect(detailHtml).not.toContain("Open overseer");

		const reconnect = await app.request(
			"http://localhost/accounts/acct-owner/reconnect",
		);
		expect(reconnect.status).toBe(200);
		await expect(reconnect.text()).resolves.toContain(
			"Reconnect Gmail account",
		);

		const deletePage = await app.request(
			"http://localhost/accounts/acct-owner/delete",
		);
		expect(deletePage.status).toBe(200);
		await expect(deletePage.text()).resolves.toContain("Confirmation email");

		const accounts = await app.request("http://localhost/accounts");
		expect(accounts.status).toBe(200);
		const accountsHtml = await accounts.text();
		expect(accountsHtml).toContain('href="/accounts/new"');
		expect(accountsHtml).toContain('href="/accounts/acct-owner/reconnect"');
	});

	it("renders config_error accounts as configuration failures instead of reconnect guidance", async () => {
		const { app } = await loadServerApp();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-config-error",
			label: "Config Error Account",
			emailAddress: "config-error@example.com",
			syncEnabled: 1,
			syncStatus: "needs_reconnect",
		});
		await db
			.updateTable("accounts")
			.set({
				last_error:
					"Google OAuth client credentials were rejected by Google. Verify GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for redirect URL http://127.0.0.1:56711/oauth/google/callback. Start local server with mise run dev.",
			})
			.where("id", "=", "acct-config-error")
			.execute();

		const accounts = await app.request("http://localhost/accounts");
		expect(accounts.status).toBe(200);
		const accountsHtml = await accounts.text();
		expect(accountsHtml).toContain("Config error");
		expect(accountsHtml).toContain("Retry after config fix");

		const detail = await app.request(
			"http://localhost/accounts/acct-config-error",
		);
		expect(detail.status).toBe(200);
		const detailHtml = await detail.text();
		expect(detailHtml).toContain("Config error");
		expect(detailHtml).toContain("Retry after config fix");
	});

	it("sanitizes claim legacy cancel targets", async () => {
		const { app } = await loadServerApp();
		await bootDb();

		const response = await app.request(
			"http://localhost/org/claim-legacy?returnTo=javascript%3Aalert(document.cookie)",
		);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Claim legacy runtime");
		expect(html).not.toContain("javascript:");
		expect(html).toContain('href="/">Cancel</a>');
	});

	it("renders a safe Google OAuth callback error message", async () => {
		vi.doMock("#/server/actions", async () => {
			const actual =
				await vi.importActual<typeof import("#/server/actions")>(
					"#/server/actions",
				);
			return {
				...actual,
				completeGoogleConnectCommand: vi.fn(async () => {
					throw new Error(
						"Google OAuth client credentials were rejected by Google. Verify GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for redirect URL http://127.0.0.1:56711/oauth/google/callback. Start local server with mise run dev.",
					);
				}),
			};
		});

		try {
			const { app } = await loadServerApp();
			await bootDb();
			const response = await app.request(
				"http://localhost/oauth/google/callback?code=oauth-code&state=oauth-state",
			);

			expect(response.status).toBe(200);
			const html = await response.text();
			expect(html).toContain("OAuth callback error");
			expect(html).toContain(
				"Google OAuth client credentials were rejected by Google.",
			);
			expect(html).not.toContain('"error": "invalid_client"');
		} finally {
			vi.doUnmock("#/server/actions");
		}
	});

	it("blocks non-owner viewers from lifecycle pages and lifecycle RPCs", async () => {
		const { app } = await loadServerApp({
			role: "org_viewer",
			email: "other@inherent.design",
		});
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-owner",
			label: "Owner Account",
			emailAddress: "owner-account@example.com",
			ownerPrincipalEmail: "owner@inherent.design",
			syncEnabled: 0,
			syncStatus: "needs_reconnect",
		});

		const detail = await app.request("http://localhost/accounts/acct-owner");
		expect(detail.status).toBe(200);
		const detailHtml = await detail.text();
		expect(detailHtml).not.toContain("Delete local account</a>");
		expect(detailHtml).not.toContain("Reconnect Gmail");
		expect(detailHtml).toContain(
			"Account deletion is restricted to the account owner or an org admin.",
		);
		expect(detailHtml).not.toContain("Open overseer");

		const reconnect = await app.request(
			"http://localhost/accounts/acct-owner/reconnect",
		);
		expect(reconnect.status).toBe(403);
		await expect(reconnect.text()).resolves.toContain("Forbidden");

		const deletePage = await app.request(
			"http://localhost/accounts/acct-owner/delete",
		);
		expect(deletePage.status).toBe(403);
		await expect(deletePage.text()).resolves.toContain(
			"You do not have permission to manage this Gmail account.",
		);

		const reconnectRpc = await app.request(
			"http://localhost/rpc/accounts/acct-owner/reconnect",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-requested-with": "zmail-client",
				},
				body: JSON.stringify({
					label: "Rename",
				}),
			},
		);
		expect(reconnectRpc.status).toBe(403);
		await expect(reconnectRpc.json()).resolves.toMatchObject({
			ok: false,
			error: "forbidden",
		});

		const disconnectRpc = await app.request(
			"http://localhost/rpc/accounts/acct-owner/disconnect",
			{
				method: "POST",
				headers: {
					"x-requested-with": "zmail-client",
				},
			},
		);
		expect(disconnectRpc.status).toBe(403);
		await expect(disconnectRpc.json()).resolves.toMatchObject({
			ok: false,
			error: "forbidden",
		});

		const deleteRpc = await app.request(
			"http://localhost/rpc/accounts/acct-owner/delete",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-requested-with": "zmail-client",
				},
				body: JSON.stringify({
					confirmationEmail: "owner-account@example.com",
				}),
			},
		);
		expect(deleteRpc.status).toBe(403);
		await expect(deleteRpc.json()).resolves.toMatchObject({
			ok: false,
			error: "forbidden",
		});

		const accounts = await app.request("http://localhost/accounts");
		expect(accounts.status).toBe(200);
		const accountsHtml = await accounts.text();
		expect(accountsHtml).toContain('<span class="muted">None</span>');
		expect(accountsHtml).not.toContain('href="/accounts/acct-owner/reconnect"');
	});
});
