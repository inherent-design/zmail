import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	bootDb,
	insertConversationRow,
	insertMessageLabelRow,
	insertMessageRow,
	seedLegacyPreSecondarySchema,
	seedTestAccount,
} from "#/test/helpers/db";
import { setEnv } from "#/test/helpers/env";
import { buildMessageLabelV3 } from "#/test/helpers/labels";
import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("new server actions", () => {
	it("loadAccountsData returns an empty array on a fresh database", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountsData();

		expect(result.accounts).toEqual([]);
	});

	it("fails with a reset-required error before loaders touch old-schema tables", async () => {
		const runtime = await createTestRuntime();
		await seedLegacyPreSecondarySchema();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(actions.loadAccountsData()).rejects.toMatchObject({
			name: "SchemaResetRequiredError",
		});
		await expect(actions.loadAccountsData()).rejects.toThrow(
			/This local database predates the rewritten zmail baseline/,
		);
	});

	it("loadAccountsData includes message and tombstone counts from seeded data", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		const { insertMessageRow } = await import("#/test/helpers/db");
		await seedTestAccount(db);

		const messageId = await insertMessageRow(db);
		await db
			.insertInto("message_sources")
			.values({
				id: "source-1",
				message_id: messageId,
				account_id: "acct-1",
				remote_message_id: null,
				remote_thread_id: null,
				mailbox: null,
				imap_uid: null,
				uidvalidity: null,
				raw_rfc822_path: null,
				raw_sha256: null,
				state: "tombstoned",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: "2026-01-02T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountsData();
		const account = result.accounts.find((a) => a.id === "acct-1");

		expect(account).toBeTruthy();
		expect(account?.label).toBe("Test Account");
		expect(account?.has_oauth_token).toBe(false);
		expect(account?.connection_state).toBe("disconnected");
		expect(account?.message_count).toBe(1);
		expect(account?.tombstone_count).toBe(1);
	});

	it("loadMessagesData paginates message rows", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		for (let index = 0; index < 55; index += 1) {
			const id = `msg-page-${String(index).padStart(2, "0")}`;
			await insertMessageRow(db, {
				id,
				accountId: "acct-1",
				subject: `Page message ${index}`,
				receivedAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
				contentSha256: `sha-${id}`,
			});
		}

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadMessagesData({
			page: "2",
			pageSize: "50",
		});

		expect(result.pagination).toMatchObject({
			page: 2,
			pageSize: 50,
			total: 55,
			totalPages: 2,
			hasPreviousPage: true,
			hasNextPage: false,
		});
		expect(result.rows).toHaveLength(5);
		expect(result.rows[0]?.id).toBe("msg-page-04");
	});

	it("loadMessagesData filters by search, account, bucket, and parse status", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		await seedTestAccount(db, {
			id: "acct-2",
			label: "Filtered Account",
			emailAddress: "filtered@example.com",
		});
		const matchingId = await insertMessageRow(db, {
			id: "msg-matching-filter",
			accountId: "acct-2",
			senderAddress: "billing@example.com",
			subject: "Needle receipt",
			bodyTextNormalized: "needle body",
			contentSha256: "sha-matching-filter",
		});
		await insertMessageLabelRow(db, {
			messageId: matchingId,
			primaryBucket: "finance",
			contentSha256: "sha-matching-filter",
		});
		const wrongBucketId = await insertMessageRow(db, {
			id: "msg-wrong-bucket",
			accountId: "acct-2",
			subject: "Needle personal",
			bodyTextNormalized: "needle body",
			contentSha256: "sha-wrong-bucket",
		});
		await insertMessageLabelRow(db, {
			messageId: wrongBucketId,
			primaryBucket: "personal",
			contentSha256: "sha-wrong-bucket",
		});
		await insertMessageRow(db, {
			id: "msg-wrong-account",
			accountId: "acct-1",
			subject: "Needle other account",
			bodyTextNormalized: "needle body",
			contentSha256: "sha-wrong-account",
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadMessagesData({
			q: "needle",
			accountId: "acct-2",
			bucket: "finance",
			parseStatus: "parsed",
			pageSize: "50",
		});

		expect(result.rows.map((row) => row.id)).toEqual(["msg-matching-filter"]);
		expect(result.filters).toMatchObject({
			q: "needle",
			accountId: "acct-2",
			bucket: "finance",
			parseStatus: "parsed",
			pageSize: 50,
		});
		expect(result.options.accounts.map((account) => account.id)).toContain(
			"acct-2",
		);
		expect(result.options.buckets).toEqual(
			expect.arrayContaining(["finance", "personal"]),
		);
	});

	it("queues finance registry and knowledge jobs through server commands", async () => {
		const runtime = await createTestRuntime();
		await bootDb({ seedDefaultAccount: true });

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");

		const financeBacklog = await actions.queueAccountFinanceBacklogCommand({
			accountId: "acct-1",
		});
		const importRegistry = await actions.queueImportOperatorRegistryCommand();
		const rebuildKnowledge =
			await actions.queueRebuildFinanceKnowledgeCommand();

		const jobs = await dbModule
			.getDb()
			.selectFrom("jobs")
			.select(["id", "kind", "scope_type", "scope_id"])
			.where("id", "in", [financeBacklog, importRegistry, rebuildKnowledge])
			.orderBy("kind")
			.execute();

		expect(jobs).toEqual([
			{
				id: financeBacklog,
				kind: "classify_finance_backlog",
				scope_type: "account",
				scope_id: "acct-1",
			},
			{
				id: importRegistry,
				kind: "import_operator_registry",
				scope_type: "system",
				scope_id: "operator_registry",
			},
			{
				id: rebuildKnowledge,
				kind: "rebuild_finance_knowledge",
				scope_type: "system",
				scope_id: "finance",
			},
		]);
	});

	it("confines browser finance export paths to the org runtime export directory", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		const defaultExport = await actions.queueFinanceExportCommand({
			year: 2026,
		});
		expect(defaultExport.outDir).toContain(
			resolve(
				runtime.dataDir,
				"orgs",
				"local",
				"operator",
				"exports",
				"finance",
				"local",
			),
		);

		const customExport = await actions.queueFinanceExportCommand({
			year: 2026,
			outDir: "manual/april",
		});
		expect(customExport.outDir).toBe(
			resolve(
				runtime.dataDir,
				"orgs",
				"local",
				"operator",
				"exports",
				"finance",
				"manual",
				"april",
			),
		);

		await expect(
			actions.queueFinanceExportCommand({
				year: 2026,
				outDir: "../escape",
			}),
		).rejects.toThrow(/inside the org finance export directory/);
		await expect(
			actions.queueFinanceExportCommand({
				year: 2026,
				outDir: "/tmp/zmail-export",
			}),
		).rejects.toThrow(/relative path/);
	});

	it("loadAccountsData defaults grouped counts to zero for accounts without rows", async () => {
		const runtime = await createTestRuntime();
		const { db, dbModule } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			label: "Account One",
		});
		await seedTestAccount(db, {
			id: "acct-2",
			label: "Account Two",
		});

		const messageId = await insertMessageRow(db, {
			accountId: "acct-1",
		});
		await db
			.insertInto("message_sources")
			.values({
				id: "source-2",
				message_id: messageId,
				account_id: "acct-1",
				remote_message_id: null,
				remote_thread_id: null,
				mailbox: null,
				imap_uid: null,
				uidvalidity: null,
				raw_rfc822_path: null,
				raw_sha256: null,
				state: "tombstoned",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: "2026-01-02T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("jobs")
			.values({
				id: "job-root-running",
				kind: "classify_account_backlog",
				scope_type: "account",
				scope_id: "acct-1",
				status: "running",
				model: null,
				prompt_version: null,
				request_count: 10,
				success_count: 2,
				error_count: 0,
				claimed_at: "2026-01-02T00:00:00.000Z",
				lease_expires_at: null,
				lane: "root_llm",
				priority: 100,
				run_after_at: null,
				claim_owner: "worker-a",
				attempts: 1,
				last_error: null,
				created_at: "2026-01-02T00:00:00.000Z",
				started_at: "2026-01-02T00:00:00.000Z",
				finished_at: null,
				meta_json: dbModule.jsonText({
					processed: 2,
					total: 10,
					etaSeconds: 60,
					updatedAt: "2026-01-02T00:00:05.000Z",
				}),
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountsData();

		expect(result.accounts).toEqual([
			expect.objectContaining({
				id: "acct-1",
				label: "Account One",
				message_count: 1,
				tombstone_count: 1,
				lane_progress: expect.arrayContaining([
					expect.objectContaining({
						lane: "root_llm",
						state: "running",
						processed: 2,
						total: 10,
						etaSeconds: 60,
					}),
				]),
			}),
			expect.objectContaining({
				id: "acct-2",
				label: "Account Two",
				message_count: 0,
				tombstone_count: 0,
				lane_progress: expect.arrayContaining([
					expect.objectContaining({
						lane: "root_llm",
						state: "idle",
					}),
				]),
			}),
		]);
	});

	it("queues finance follow-up jobs when reviews are accepted or overridden", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb({ seedDefaultAccount: true });
		const financeMessageId = await insertMessageRow(db, {
			id: "msg-review-finance",
			accountId: "acct-1",
			contentSha256: "content-review-finance",
		});
		const nonFinanceMessageId = await insertMessageRow(db, {
			id: "msg-review-nonfinance",
			accountId: "acct-1",
			contentSha256: "content-review-nonfinance",
		});
		const overrideFinanceMessageId = await insertMessageRow(db, {
			id: "msg-review-override-finance",
			accountId: "acct-1",
			contentSha256: "content-review-override-finance",
		});
		await insertMessageLabelRow(db, {
			messageId: financeMessageId,
			primaryBucket: "finance",
			contentSha256: "content-review-finance",
			label: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Software receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				explanation: "finance",
			}),
		});
		await insertMessageLabelRow(db, {
			messageId: nonFinanceMessageId,
			contentSha256: "content-review-nonfinance",
		});
		await insertMessageLabelRow(db, {
			messageId: overrideFinanceMessageId,
			primaryBucket: "finance",
			contentSha256: "content-review-override-finance",
			label: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Software receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				explanation: "finance",
			}),
		});
		await db
			.insertInto("reviews")
			.values([
				{
					id: "review-finance",
					message_id: financeMessageId,
					source_classification_result_id: "classification-msg-review-finance",
					status: "open",
					reviewer_note: null,
					override_label_json: null,
					resolved_at: null,
					created_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "review-nonfinance",
					message_id: nonFinanceMessageId,
					source_classification_result_id:
						"classification-msg-review-nonfinance",
					status: "open",
					reviewer_note: null,
					override_label_json: null,
					resolved_at: null,
					created_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "review-override-finance",
					message_id: overrideFinanceMessageId,
					source_classification_result_id:
						"classification-msg-review-override-finance",
					status: "open",
					reviewer_note: null,
					override_label_json: null,
					resolved_at: null,
					created_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();

		const writeManualOverride = vi.fn(async () => undefined);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/classify", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/classify")>(
					"#/lib/classify",
				);
			return {
				...actual,
				writeManualOverride,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const accepted = await actions.resolveReviewCommand({
			reviewId: "review-finance",
			action: "accept",
		});
		const overridden = await actions.resolveReviewCommand({
			reviewId: "review-nonfinance",
			action: "override",
			override: buildMessageLabelV3({
				finance: {
					relevant: false,
					signal: "none",
					operational: false,
					bookHint: "unknown",
					requiresFinanceIntel: false,
					confidence: 1,
					evidence: null,
				},
				routing: {
					primaryBucket: "relationships",
					secondaryBuckets: [],
					tags: ["social"],
				},
				explanation: "manual override",
			}),
		});
		const overriddenFinance = await actions.resolveReviewCommand({
			reviewId: "review-override-finance",
			action: "override",
			override: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Software receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				explanation: "manual override finance",
			}),
		});

		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "scope_type", "scope_id"])
			.orderBy("kind")
			.execute();

		expect(accepted.status).toBe("accepted");
		expect(overridden.status).toBe("overridden");
		expect(overriddenFinance.status).toBe("overridden");
		expect(writeManualOverride).toHaveBeenCalledTimes(2);
		expect(jobs).toEqual([
			{
				kind: "classify_finance_backlog",
				scope_type: "account",
				scope_id: "acct-1",
			},
			{
				kind: "rebuild_finance_knowledge",
				scope_type: "system",
				scope_id: "finance",
			},
			{
				kind: "rebuild_overseer",
				scope_type: "account",
				scope_id: "acct-1",
			},
		]);
	});

	it("loadMessagesData returns empty rows on a fresh database", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		const result = await actions.loadMessagesData();
		expect(result.rows).toEqual([]);
		expect(result.pagination).toMatchObject({
			page: 1,
			total: 0,
			totalPages: 1,
			hasNextPage: false,
		});
	});

	it("loadMessageDetailData prefers the newest source row when states tie", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		const conversationId = await insertConversationRow(db, {
			id: "conv-detail-source",
			accountId: "acct-1",
			gmailThreadId: "thr-detail-source",
			messageCount: 1,
			firstMessageReceivedAt: "2026-01-01T00:00:00.000Z",
			lastMessageReceivedAt: "2026-01-01T00:00:00.000Z",
		});
		const messageId = await insertMessageRow(db, {
			id: "msg-detail-source",
			accountId: "acct-1",
			conversationId,
			contentSha256: "content-detail-source",
		});
		await db
			.insertInto("message_sources")
			.values([
				{
					id: "source-detail-old",
					message_id: messageId,
					account_id: "acct-1",
					remote_message_id: "gm-detail-old",
					remote_thread_id: "thr-detail-old",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 10,
					uidvalidity: 1,
					raw_rfc822_path: "/tmp/detail-old.eml",
					raw_sha256: "raw-old",
					state: "tombstoned",
					first_seen_at: "2026-01-01T00:00:00.000Z",
					last_seen_at: "2026-01-01T00:00:00.000Z",
					tombstoned_at: "2026-01-02T00:00:00.000Z",
					updated_at: "2026-01-02T00:00:00.000Z",
				},
				{
					id: "source-detail-new",
					message_id: messageId,
					account_id: "acct-1",
					remote_message_id: "gm-detail-new",
					remote_thread_id: "thr-detail-new",
					mailbox: "[Gmail]/All Mail",
					imap_uid: 11,
					uidvalidity: 1,
					raw_rfc822_path: "/tmp/detail-new.eml",
					raw_sha256: "raw-new",
					state: "tombstoned",
					first_seen_at: "2026-01-01T00:00:00.000Z",
					last_seen_at: "2026-01-03T00:00:00.000Z",
					tombstoned_at: "2026-01-03T00:00:00.000Z",
					updated_at: "2026-01-03T00:00:00.000Z",
				},
			])
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const detail = await actions.loadMessageDetailData({ messageId });

		expect(detail.message.remote_thread_id).toBe("thr-detail-new");
		expect(detail.message.raw_rfc822_path).toBe("/tmp/detail-new.eml");
		expect(detail.message.raw_sha256).toBe("raw-new");
	});

	it("loadMessageDetailData returns finance-intel current data, history, and evidence", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		const messageId = await insertMessageRow(db, {
			id: "msg-detail-finance-intel",
			accountId: "acct-1",
			contentSha256: "content-detail-finance-intel",
		});
		await db
			.insertInto("message_secondary_results")
			.values([
				{
					id: "secondary-finance-history",
					message_id: messageId,
					classifier_key: "finance_intel",
					schema_version: "finance-intel.v1",
					job_id: null,
					model: "gpt-5.4-mini",
					prompt_version: "finance-intel-v1",
					source: "model",
					result_json: '{"history":true}',
					raw_response_json: '{"raw":"history"}',
					usage_json: '{"totalTokens":4}',
					input_content_sha256: "content-detail-finance-intel",
					input_registry_sha256: "registry-detail-finance-intel",
					created_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "secondary-finance-current",
					message_id: messageId,
					classifier_key: "finance_intel",
					schema_version: "finance-intel.v1",
					job_id: null,
					model: "gpt-5.4-mini",
					prompt_version: "finance-intel-v1",
					source: "model",
					result_json: '{"current":true}',
					raw_response_json: '{"raw":"current"}',
					usage_json: '{"totalTokens":8}',
					input_content_sha256: "content-detail-finance-intel",
					input_registry_sha256: "registry-detail-finance-intel",
					created_at: "2026-01-02T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("message_secondary_heads")
			.values({
				message_id: messageId,
				classifier_key: "finance_intel",
				secondary_result_id: "secondary-finance-current",
				status: "review",
				low_confidence: 1,
				content_sha256: "content-detail-finance-intel",
				registry_sha256: "registry-detail-finance-intel",
				updated_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_event_candidates")
			.values({
				id: "finance-event-detail",
				canonical_key: "tx:detail",
				status: "review",
				event_kind: "card_charge",
				direction: "expense",
				amount_value: "42.00",
				currency: "USD",
				occurred_at: "2026-01-01",
				merchant_or_counterparty: "Acme",
				owner_identity_id: null,
				financial_account_id: null,
				institution_id: null,
				category_hint: null,
				tax_relevance_hint: null,
				evidence_count: 1,
				first_message_received_at: "2026-01-01T00:00:00.000Z",
				last_message_received_at: "2026-01-01T00:00:00.000Z",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_document_candidates")
			.values({
				id: "finance-document-detail",
				canonical_key: "doc:detail",
				status: "candidate",
				document_type: "receipt",
				issuer: "Acme",
				external_id: null,
				statement_period_start: null,
				statement_period_end: null,
				due_at: null,
				tax_year: null,
				owner_identity_id: null,
				financial_account_id: null,
				institution_id: null,
				evidence_count: 1,
				first_message_received_at: "2026-01-01T00:00:00.000Z",
				last_message_received_at: "2026-01-01T00:00:00.000Z",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_event_evidence")
			.values({
				id: "finance-evidence-detail",
				event_candidate_id: "finance-event-detail",
				document_candidate_id: "finance-document-detail",
				message_id: messageId,
				secondary_result_id: "secondary-finance-current",
				transaction_index: 0,
				document_index: 0,
				evidence_json: '{"detail":true}',
				created_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const detail = await actions.loadMessageDetailData({ messageId });

		expect(detail.financeIntel).toEqual({
			head: {
				status: "review",
				lowConfidence: 1,
				contentSha256: "content-detail-finance-intel",
				registrySha256: "registry-detail-finance-intel",
				updatedAt: "2026-01-03T00:00:00.000Z",
			},
			current: {
				id: "secondary-finance-current",
				schemaVersion: "finance-intel.v1",
				model: "gpt-5.4-mini",
				promptVersion: "finance-intel-v1",
				source: "model",
				createdAt: "2026-01-02T00:00:00.000Z",
				result: { current: true },
				rawResponse: { raw: "current" },
				usage: { totalTokens: 8 },
			},
			history: [
				{
					id: "secondary-finance-current",
					schemaVersion: "finance-intel.v1",
					model: "gpt-5.4-mini",
					promptVersion: "finance-intel-v1",
					source: "model",
					createdAt: "2026-01-02T00:00:00.000Z",
					result: { current: true },
					rawResponse: { raw: "current" },
					usage: { totalTokens: 8 },
				},
				{
					id: "secondary-finance-history",
					schemaVersion: "finance-intel.v1",
					model: "gpt-5.4-mini",
					promptVersion: "finance-intel-v1",
					source: "model",
					createdAt: "2026-01-01T00:00:00.000Z",
					result: { history: true },
					rawResponse: { raw: "history" },
					usage: { totalTokens: 4 },
				},
			],
			evidence: [
				{
					id: "finance-evidence-detail",
					eventCandidateId: "finance-event-detail",
					documentCandidateId: "finance-document-detail",
					transactionIndex: 0,
					documentIndex: 0,
					eventCanonicalKey: "tx:detail",
					eventStatus: "review",
					documentCanonicalKey: "doc:detail",
					documentStatus: "candidate",
					evidenceJson: '{"detail":true}',
				},
			],
		});
	});

	it("loadMessageDetailData returns a finance head without a current result", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		const messageId = await insertMessageRow(db, {
			id: "msg-detail-finance-head-only",
			accountId: "acct-1",
			contentSha256: "content-detail-finance-head-only",
		});
		await db
			.insertInto("message_secondary_heads")
			.values({
				message_id: messageId,
				classifier_key: "finance_intel",
				secondary_result_id: null,
				status: "blocked_parse_error",
				low_confidence: 0,
				content_sha256: "content-detail-finance-head-only",
				registry_sha256: "registry-detail-finance-head-only",
				updated_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_secondary_results")
			.values({
				id: "secondary-finance-head-only-history",
				message_id: messageId,
				classifier_key: "finance_intel",
				schema_version: "finance-intel.v1",
				job_id: null,
				model: "gpt-5.4-mini",
				prompt_version: "finance-intel-v1",
				source: "model",
				result_json: '{"history":true}',
				raw_response_json: "{}",
				usage_json: null,
				input_content_sha256: "content-detail-finance-head-only",
				input_registry_sha256: "registry-detail-finance-head-only",
				created_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const detail = await actions.loadMessageDetailData({ messageId });

		expect(detail.financeIntel).toEqual({
			head: {
				status: "blocked_parse_error",
				lowConfidence: 0,
				contentSha256: "content-detail-finance-head-only",
				registrySha256: "registry-detail-finance-head-only",
				updatedAt: "2026-01-03T00:00:00.000Z",
			},
			current: null,
			history: [
				{
					id: "secondary-finance-head-only-history",
					schemaVersion: "finance-intel.v1",
					model: "gpt-5.4-mini",
					promptVersion: "finance-intel-v1",
					source: "model",
					createdAt: "2026-01-02T00:00:00.000Z",
					result: { history: true },
					rawResponse: {},
					usage: null,
				},
			],
			evidence: [],
		});
	});

	it("loadMessageDetailData returns a current finance result with null usage", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		const messageId = await insertMessageRow(db, {
			id: "msg-detail-finance-current-null-usage",
			accountId: "acct-1",
			contentSha256: "content-detail-finance-current-null-usage",
		});
		await db
			.insertInto("message_secondary_results")
			.values({
				id: "secondary-finance-current-null-usage",
				message_id: messageId,
				classifier_key: "finance_intel",
				schema_version: "finance-intel.v1",
				job_id: null,
				model: "gpt-5.4-mini",
				prompt_version: "finance-intel-v1",
				source: "model",
				result_json: '{"current":true}',
				raw_response_json: '{"raw":"current"}',
				usage_json: null,
				input_content_sha256: "content-detail-finance-current-null-usage",
				input_registry_sha256: "registry-detail-finance-current-null-usage",
				created_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_secondary_heads")
			.values({
				message_id: messageId,
				classifier_key: "finance_intel",
				secondary_result_id: "secondary-finance-current-null-usage",
				status: "ready",
				low_confidence: 0,
				content_sha256: "content-detail-finance-current-null-usage",
				registry_sha256: "registry-detail-finance-current-null-usage",
				updated_at: "2026-01-03T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const detail = await actions.loadMessageDetailData({ messageId });

		expect(detail.financeIntel?.current).toEqual({
			id: "secondary-finance-current-null-usage",
			schemaVersion: "finance-intel.v1",
			model: "gpt-5.4-mini",
			promptVersion: "finance-intel-v1",
			source: "model",
			createdAt: "2026-01-02T00:00:00.000Z",
			result: { current: true },
			rawResponse: { raw: "current" },
			usage: null,
		});
	});

	it("loadAccountNewData returns oauth readiness (false without env vars)", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountNewData();

		expect(result.oauthReady).toBe(false);
		expect(result.missingVars).toBeInstanceOf(Array);
		expect(result.missingVars.length).toBeGreaterThan(0);
		expect(result.redirectUrl).toBe(
			"http://127.0.0.1:56711/oauth/google/callback",
		);
	});

	it("loadAccountNewData returns readiness and redirectUrl from env", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
		process.env.GOOGLE_OAUTH_REDIRECT_URL =
			"http://localhost:56711/oauth/google/callback";
		vi.resetModules();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountNewData();

		expect(result.oauthReady).toBe(true);
		expect(result.missingVars).toEqual([]);
		expect(result.redirectUrl).toBe(
			"http://localhost:56711/oauth/google/callback",
		);
	});

	it("loadAccountDetailData returns account, null syncState, empty jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountDetailData({
			accountId: "acct-1",
		});

		expect(result.account).toBeTruthy();
		expect(result.account.id).toBe("acct-1");
		expect(result.account.label).toBe("Test Account");
		expect(result.account.has_oauth_token).toBe(false);
		expect(result.account.connection_state).toBe("disconnected");
		expect(result.has_oauth_token).toBe(false);
		expect(result.connection_state).toBe("disconnected");
		expect(result.syncState).toBeNull();
		expect(result.recentJobs).toEqual([]);
		expect(result.messageCount).toBe(0);
		expect(result.tombstoneCount).toBe(0);
	});

	it("loadFinanceData returns registry state and staged ledger evidence", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		const conversationId = await insertConversationRow(db, {
			id: "conv-finance-data",
			accountId: "acct-1",
			gmailThreadId: "thr-finance-data",
			messageCount: 1,
			firstMessageReceivedAt: "2026-01-10T00:00:00.000Z",
			lastMessageReceivedAt: "2026-01-10T00:00:00.000Z",
		});
		const messageId = await insertMessageRow(db, {
			id: "msg-finance-data",
			accountId: "acct-1",
			conversationId,
			subject: "Receipt",
			contentSha256: "content-finance-data",
		});
		const mysteryMessageId = await insertMessageRow(db, {
			id: "msg-finance-data-mystery",
			accountId: "acct-1",
			contentSha256: "content-finance-data-mystery",
		});
		await db
			.insertInto("message_secondary_results")
			.values({
				id: "secondary-finance-data",
				message_id: messageId,
				classifier_key: "finance_intel",
				schema_version: "finance-intel.v1",
				job_id: null,
				model: "gpt-5.4-mini",
				prompt_version: "finance-intel-v1",
				source: "model",
				result_json: JSON.stringify({ ok: true }),
				raw_response_json: "{}",
				usage_json: null,
				input_content_sha256: "content-finance-data",
				input_registry_sha256: "registry-finance-data",
				created_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("message_secondary_heads")
			.values({
				message_id: messageId,
				classifier_key: "finance_intel",
				secondary_result_id: "secondary-finance-data",
				status: "ready",
				low_confidence: 0,
				content_sha256: "content-finance-data",
				registry_sha256: "registry-finance-data",
				updated_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await insertMessageLabelRow(db, {
			messageId,
			primaryBucket: "finance",
			contentSha256: "content-finance-data",
			label: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Software receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				explanation: "finance",
			}),
		});
		await insertMessageLabelRow(db, {
			messageId: mysteryMessageId,
			primaryBucket: "finance",
			contentSha256: "content-finance-data-mystery",
			label: buildMessageLabelV3({
				finance: {
					relevant: true,
					signal: "receipt",
					operational: true,
					bookHint: "business",
					requiresFinanceIntel: true,
					confidence: 0.95,
					evidence: "Software receipt.",
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt"],
					tags: ["receipt"],
				},
				explanation: "finance",
			}),
		});
		await db
			.insertInto("message_secondary_heads")
			.values({
				message_id: mysteryMessageId,
				classifier_key: "finance_intel",
				secondary_result_id: null,
				status: "mystery",
				low_confidence: 0,
				content_sha256: "content-finance-data-mystery",
				registry_sha256: "registry-finance-data",
				updated_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_event_candidates")
			.values([
				{
					id: "finance-event-1",
					canonical_key: "tx:finance-event-1",
					status: "candidate",
					event_kind: "card_charge",
					direction: "expense",
					amount_value: "42.00",
					currency: "USD",
					occurred_at: "2026-01-10",
					merchant_or_counterparty: "Acme",
					owner_identity_id: null,
					financial_account_id: null,
					institution_id: null,
					category_hint: "software",
					tax_relevance_hint: "business expense",
					evidence_count: 1,
					first_message_received_at: "2026-01-10T00:00:00.000Z",
					last_message_received_at: "2026-01-10T00:00:00.000Z",
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "finance-event-2",
					canonical_key: "tx:finance-event-2",
					status: "candidate",
					event_kind: "card_charge",
					direction: "expense",
					amount_value: null,
					currency: null,
					occurred_at: null,
					merchant_or_counterparty: null,
					owner_identity_id: null,
					financial_account_id: null,
					institution_id: null,
					category_hint: null,
					tax_relevance_hint: null,
					evidence_count: 0,
					first_message_received_at: null,
					last_message_received_at: null,
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_document_candidates")
			.values([
				{
					id: "finance-document-1",
					canonical_key: "doc:finance-document-1",
					status: "candidate",
					document_type: "receipt",
					issuer: "Acme",
					external_id: "receipt-1",
					statement_period_start: null,
					statement_period_end: null,
					due_at: null,
					tax_year: 2026,
					owner_identity_id: null,
					financial_account_id: null,
					institution_id: null,
					evidence_count: 1,
					first_message_received_at: "2026-01-10T00:00:00.000Z",
					last_message_received_at: "2026-01-10T00:00:00.000Z",
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "finance-document-2",
					canonical_key: "doc:finance-document-2",
					status: "candidate",
					document_type: "receipt",
					issuer: null,
					external_id: null,
					statement_period_start: null,
					statement_period_end: null,
					due_at: null,
					tax_year: null,
					owner_identity_id: null,
					financial_account_id: null,
					institution_id: null,
					evidence_count: 0,
					first_message_received_at: null,
					last_message_received_at: null,
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_event_evidence")
			.values([
				{
					id: "finance-evidence-event-1",
					event_candidate_id: "finance-event-1",
					document_candidate_id: null,
					message_id: messageId,
					secondary_result_id: "secondary-finance-data",
					transaction_index: 0,
					document_index: null,
					evidence_json: '{"kind":"event"}',
					created_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "finance-evidence-document-1",
					event_candidate_id: null,
					document_candidate_id: "finance-document-1",
					message_id: messageId,
					secondary_result_id: "secondary-finance-data",
					transaction_index: null,
					document_index: 0,
					evidence_json: '{"kind":"document"}',
					created_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "finance-evidence-orphan-1",
					event_candidate_id: null,
					document_candidate_id: null,
					message_id: messageId,
					secondary_result_id: "secondary-finance-data",
					transaction_index: null,
					document_index: null,
					evidence_json: '{"kind":"orphan"}',
					created_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_ledger_entries")
			.values([
				{
					id: "ledger-finance-data-ready",
					canonical_key: "email:msg-finance-data:42.00:2026-01-10",
					status: "ready",
					source_authority: "email",
					occurred_at: "2026-01-10",
					posted_at: null,
					cleared_at: null,
					description: "Acme",
					counterparty: "Acme",
					direction: "expense",
					amount_value: "42.00",
					amount_minor: 4200,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: "Expenses:Business:Software",
					credit_account: "Assets:Business:Bank:Checking",
					account_mapping_key: "amex",
					field_confidence_json: JSON.stringify({ overall: 0.95 }),
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "software_services",
						categorySecondary: "saas",
						ownerIdentityId: null,
						institutionId: "inst:finance-data",
						financialAccountId: "acct:finance-data",
					}),
					raw_payload_json: JSON.stringify({ seeded: true }),
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "ledger-finance-data-review",
					canonical_key: "email:msg-finance-data-mystery",
					status: "review",
					source_authority: "email",
					occurred_at: "2026-01-09",
					posted_at: null,
					cleared_at: null,
					description: "Unknown",
					counterparty: null,
					direction: "expense",
					amount_value: null,
					amount_minor: null,
					currency: "USD",
					book: "business",
					business_use_percent: null,
					debit_account: null,
					credit_account: null,
					account_mapping_key: null,
					field_confidence_json: JSON.stringify({ overall: 0.4 }),
					ledger_metadata_json: JSON.stringify({
						categoryPrimary: "uncategorized",
						categorySecondary: null,
					}),
					raw_payload_json: JSON.stringify({ seeded: true }),
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_ledger_entry_sources")
			.values({
				id: "ledger-source-finance-data-ready",
				ledger_entry_id: "ledger-finance-data-ready",
				source_kind: "email",
				message_id: messageId,
				secondary_result_id: "secondary-finance-data",
				import_run_id: null,
				import_transaction_id: null,
				import_document_id: null,
				evidence_json: JSON.stringify({ kind: "event" }),
				created_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("registry_import_state")
			.values({
				key: "operator_registry",
				combined_sha256: "registry-finance-data",
				source_dir: "/tmp/registry",
				counts_json: JSON.stringify({
					identities: 1,
					institutions: 1,
					financialAccounts: 1,
					senderRules: 1,
				}),
				imported_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadFinanceData();

		expect(result.registry.sha256).toBe("registry-finance-data");
		expect(result.coverage.rootFinanceRelevantCount).toBe(2);
		expect(result.ledgerPreview[0]).toMatchObject({
			canonicalKey: "email:msg-finance-data:42.00:2026-01-10",
			status: "ready",
			sourceKind: "email",
			accountId: "acct-1",
			primaryCategory: "software_services",
		});
		expect(result.reviewRows[0]).toMatchObject({
			canonicalKey: "email:msg-finance-data-mystery",
			status: "review",
			primaryCategory: "uncategorized",
		});
		expect(result.eventCandidates).toEqual([]);
		expect(result.documentCandidates).toEqual([]);
	});

	it("loadFinanceData counts finance head statuses across all finance-intel states", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		for (const [suffix, status] of [
			["ready", "ready"],
			["review", "review"],
			["stale", "stale"],
			["blocked", "blocked_parse_error"],
			["mystery", "mystery"],
		] as const) {
			const messageId = await insertMessageRow(db, {
				id: `msg-finance-status-${suffix}`,
				accountId: "acct-1",
				contentSha256: `content-finance-status-${suffix}`,
			});
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket: "finance",
				contentSha256: `content-finance-status-${suffix}`,
				label: buildMessageLabelV3({
					finance: {
						relevant: true,
						signal: "receipt",
						operational: true,
						bookHint: "business",
						requiresFinanceIntel: true,
						confidence: 0.95,
						evidence: "Software receipt.",
					},
					routing: {
						primaryBucket: "finance",
						secondaryBuckets: ["receipt"],
						tags: ["receipt"],
					},
					explanation: "finance",
				}),
			});
			await db
				.insertInto("message_secondary_heads")
				.values({
					message_id: messageId,
					classifier_key: "finance_intel",
					secondary_result_id: null,
					status,
					low_confidence: 0,
					content_sha256: `content-finance-status-${suffix}`,
					registry_sha256: "registry-finance-statuses",
					updated_at: "2026-01-10T00:00:00.000Z",
				})
				.execute();
		}
		const nonFinanceMessageId = await insertMessageRow(db, {
			id: "msg-finance-status-non-finance",
			accountId: "acct-1",
			contentSha256: "content-finance-status-non-finance",
		});
		await insertMessageLabelRow(db, {
			messageId: nonFinanceMessageId,
			primaryBucket: "other",
			contentSha256: "content-finance-status-non-finance",
			label: buildMessageLabelV3({
				finance: {
					relevant: false,
					signal: "none",
					operational: false,
					bookHint: "unknown",
					requiresFinanceIntel: false,
					confidence: 0.95,
					evidence: null,
				},
				routing: {
					primaryBucket: "other",
					secondaryBuckets: [],
					tags: [],
				},
				explanation: "not finance",
			}),
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadFinanceData();

		expect(result.coverage).toMatchObject({
			rootFinanceRelevantCount: 5,
			totalHeads: 5,
			readyCount: 1,
			reviewCount: 1,
			staleCount: 1,
			blockedParseErrorCount: 1,
			eventCandidateCount: 0,
			documentCandidateCount: 0,
		});
	});

	it("loadAccountDetailData scopes finance coverage to one account", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);
		await db
			.insertInto("accounts")
			.values({
				id: "acct-2",
				label: "Other Account",
				email_address: "acct-2@example.com",
				provider_kind: "gmail",
				sync_enabled: 1,
				sync_status: "idle",
				source_truth: "corpus_mirror",
				selected_mailbox: "[Gmail]/All Mail",
				last_synced_at: null,
				last_error: null,
				created_at: "2026-01-10T00:00:00.000Z",
				updated_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();

		const primaryMessageId = await insertMessageRow(db, {
			id: "msg-account-finance-primary",
			accountId: "acct-1",
			contentSha256: "content-account-finance-primary",
		});
		const otherMessageId = await insertMessageRow(db, {
			id: "msg-account-finance-other",
			accountId: "acct-2",
			contentSha256: "content-account-finance-other",
		});
		for (const [messageId, accountId, contentSha256] of [
			[primaryMessageId, "acct-1", "content-account-finance-primary"],
			[otherMessageId, "acct-2", "content-account-finance-other"],
		] as const) {
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket: "finance",
				contentSha256,
				label: buildMessageLabelV3({
					finance: {
						relevant: true,
						signal: "receipt",
						operational: true,
						bookHint: "business",
						requiresFinanceIntel: true,
						confidence: 0.95,
						evidence: `Software receipt for ${accountId}.`,
					},
					routing: {
						primaryBucket: "finance",
						secondaryBuckets: ["receipt"],
						tags: ["receipt"],
					},
					explanation: "finance",
				}),
			});
			await db
				.insertInto("message_secondary_heads")
				.values({
					message_id: messageId,
					classifier_key: "finance_intel",
					secondary_result_id: null,
					status: "ready",
					low_confidence: 0,
					content_sha256: contentSha256,
					registry_sha256: "registry-account-finance",
					updated_at: "2026-01-10T00:00:00.000Z",
				})
				.execute();
		}
		await db
			.insertInto("message_secondary_results")
			.values({
				id: "secondary-account-finance-primary",
				message_id: primaryMessageId,
				classifier_key: "finance_intel",
				schema_version: "finance-intel.v1",
				job_id: null,
				model: "gpt-5.4-mini",
				prompt_version: "finance-intel-v1",
				source: "model",
				result_json: '{"ok":true}',
				raw_response_json: "{}",
				usage_json: null,
				input_content_sha256: "content-account-finance-primary",
				input_registry_sha256: "registry-account-finance",
				created_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_event_candidates")
			.values({
				id: "finance-event-account-finance",
				canonical_key: "tx:account-finance",
				status: "candidate",
				event_kind: "card_charge",
				direction: "expense",
				amount_value: "42.00",
				currency: "USD",
				occurred_at: "2026-01-10",
				merchant_or_counterparty: "Acme",
				owner_identity_id: null,
				financial_account_id: null,
				institution_id: null,
				category_hint: null,
				tax_relevance_hint: null,
				evidence_count: 1,
				first_message_received_at: "2026-01-10T00:00:00.000Z",
				last_message_received_at: "2026-01-10T00:00:00.000Z",
				created_at: "2026-01-10T00:00:00.000Z",
				updated_at: "2026-01-10T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("finance_document_candidates")
			.values([
				{
					id: "finance-document-account-finance",
					canonical_key: "doc:account-finance",
					status: "candidate",
					document_type: "receipt",
					issuer: "Acme",
					external_id: null,
					statement_period_start: null,
					statement_period_end: null,
					due_at: null,
					tax_year: 2026,
					owner_identity_id: null,
					financial_account_id: null,
					institution_id: null,
					evidence_count: 1,
					first_message_received_at: "2026-01-10T00:00:00.000Z",
					last_message_received_at: "2026-01-10T00:00:00.000Z",
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "finance-document-account-finance-empty",
					canonical_key: "doc:account-finance-empty",
					status: "candidate",
					document_type: "receipt",
					issuer: "Acme",
					external_id: null,
					statement_period_start: null,
					statement_period_end: null,
					due_at: null,
					tax_year: 2026,
					owner_identity_id: null,
					financial_account_id: null,
					institution_id: null,
					evidence_count: 0,
					first_message_received_at: null,
					last_message_received_at: null,
					created_at: "2026-01-10T00:00:00.000Z",
					updated_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();
		await db
			.insertInto("finance_event_evidence")
			.values([
				{
					id: "finance-evidence-account-finance-event",
					event_candidate_id: "finance-event-account-finance",
					document_candidate_id: null,
					message_id: primaryMessageId,
					secondary_result_id: "secondary-account-finance-primary",
					transaction_index: 0,
					document_index: null,
					evidence_json: '{"kind":"event"}',
					created_at: "2026-01-10T00:00:00.000Z",
				},
				{
					id: "finance-evidence-account-finance-document",
					event_candidate_id: null,
					document_candidate_id: "finance-document-account-finance",
					message_id: primaryMessageId,
					secondary_result_id: "secondary-account-finance-primary",
					transaction_index: null,
					document_index: 0,
					evidence_json: '{"kind":"document"}',
					created_at: "2026-01-10T00:00:00.000Z",
				},
			])
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountDetailData({ accountId: "acct-1" });

		expect(result.financeCoverage).toMatchObject({
			rootFinanceRelevantCount: 1,
			totalHeads: 1,
			readyCount: 1,
			eventCandidateCount: 0,
			documentCandidateCount: 0,
		});
	});

	it("loadAccountDetailData throws for unknown account", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await expect(
			actions.loadAccountDetailData({ accountId: "nonexistent" }),
		).rejects.toThrow();
	});

	it("loadAccountReconnectData returns account connection state and oauth readiness", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
		vi.resetModules();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconnect",
			label: "Reconnect Me",
			emailAddress: "reconnect@example.com",
			syncEnabled: 0,
			syncStatus: "needs_reconnect",
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountReconnectData({
			accountId: "acct-reconnect",
		});

		expect(result.account).toMatchObject({
			id: "acct-reconnect",
			label: "Reconnect Me",
			email_address: "reconnect@example.com",
			connection_state: "needs_reconnect",
			has_oauth_token: false,
		});
		expect(result.oauthReady).toBe(true);
		expect(result.connection_state).toBe("needs_reconnect");
		expect(result.has_oauth_token).toBe(false);
	});

	it("deriveAccountConnectionState returns config_error for Google bootstrap failures", async () => {
		const runtime = await createTestRuntime();
		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		expect(
			actions.deriveAccountConnectionState(
				{
					last_error:
						"Google OAuth client credentials were rejected by Google. Verify GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for redirect URL http://127.0.0.1:56711/oauth/google/callback. Start local server with mise run dev.",
					sync_enabled: 1,
					sync_status: "needs_reconnect",
				},
				false,
			),
		).toBe("config_error");
	});

	it("loadAccountDeleteData returns counts and running account-scoped jobs", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-delete-loader",
			label: "Delete Me",
			emailAddress: "delete@example.com",
		});
		const messageId = await insertMessageRow(db, {
			id: "msg-delete-loader",
			accountId: "acct-delete-loader",
		});
		await db
			.insertInto("message_sources")
			.values({
				id: "source-delete-loader",
				message_id: messageId,
				account_id: "acct-delete-loader",
				remote_message_id: null,
				remote_thread_id: null,
				mailbox: null,
				imap_uid: null,
				uidvalidity: null,
				raw_rfc822_path: null,
				raw_sha256: null,
				state: "tombstoned",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: "2026-01-02T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("jobs")
			.values({
				id: "job-delete-loader",
				kind: "sync_account_full",
				scope_type: "account",
				scope_id: "acct-delete-loader",
				status: "running",
				model: null,
				prompt_version: null,
				request_count: 0,
				success_count: 0,
				error_count: 0,
				claimed_at: null,
				lease_expires_at: null,
				attempts: 1,
				last_error: null,
				created_at: "2026-01-03T00:00:00.000Z",
				started_at: null,
				finished_at: null,
				meta_json: "{}",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.loadAccountDeleteData({
			accountId: "acct-delete-loader",
		});

		expect(result.account).toMatchObject({
			id: "acct-delete-loader",
			email_address: "delete@example.com",
		});
		expect(result.messageCount).toBe(1);
		expect(result.tombstoneCount).toBe(1);
		expect(result.runningJobs).toEqual([
			expect.objectContaining({
				id: "job-delete-loader",
				kind: "sync_account_full",
				status: "running",
			}),
		]);
	});

	it("completeGoogleConnectCommand creates a new account, token file, sync state, and full sync job", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Personal Gmail",
					ownerPrincipalEmail: "mannie@inherent.design",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "User@Example.com"),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const dbModule =
			await runtime.importFresh<typeof import("#/lib/db")>("#/lib/db");
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		const db = dbModule.getDb();
		const account = await db
			.selectFrom("accounts")
			.selectAll()
			.where("id", "=", result.accountId)
			.executeTakeFirstOrThrow();
		const syncState = await db
			.selectFrom("account_sync_state")
			.selectAll()
			.where("account_id", "=", result.accountId)
			.executeTakeFirstOrThrow();
		const job = await db
			.selectFrom("jobs")
			.selectAll()
			.where("scope_id", "=", result.accountId)
			.where("kind", "=", "sync_account_full")
			.executeTakeFirstOrThrow();

		expect(account.email_address).toBe("user@example.com");
		expect(account.label).toBe("Personal Gmail");
		expect(account.owner_principal_email).toBe("mannie@inherent.design");
		expect(account.sync_enabled).toBe(1);
		expect(syncState.account_id).toBe(result.accountId);
		expect(job.scope_id).toBe(result.accountId);
		expect(job.kind).toBe("sync_account_full");

		const oauthPath = config.accountOAuthPath(result.accountId);
		expect(existsSync(oauthPath)).toBe(true);
		expect(JSON.parse(readFileSync(oauthPath, "utf8"))).toMatchObject({
			emailAddress: "user@example.com",
			accessToken: "access-token",
		});
	});

	it("completeGoogleConnectCommand reconnects by reusing an existing account row case-insensitively", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing",
			label: "Old Label",
			emailAddress: "user@example.com",
			syncEnabled: 0,
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Renamed Gmail",
					ownerPrincipalEmail: "mannie@inherent.design",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "USER@example.com"),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		const rows = await db.selectFrom("accounts").selectAll().execute();
		const account = rows.find((row) => row.id === "acct-existing");

		expect(result.accountId).toBe("acct-existing");
		expect(rows).toHaveLength(1);
		expect(account).toMatchObject({
			label: "Renamed Gmail",
			email_address: "user@example.com",
			owner_principal_email: "mannie@inherent.design",
			sync_enabled: 1,
		});
	});

	it("completeGoogleConnectCommand rejects connect when the Gmail account is already owned by someone else", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-existing-owner",
			label: "Existing Owner",
			emailAddress: "user@example.com",
			ownerPrincipalEmail: "other@inherent.design",
			syncEnabled: 0,
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Renamed Gmail",
					ownerPrincipalEmail: "mannie@inherent.design",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "USER@example.com"),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "oauth-state",
			}),
		).rejects.toThrow(/already linked to another zmail owner/i);

		const account = await db
			.selectFrom("accounts")
			.select(["label", "owner_principal_email", "sync_enabled"])
			.where("id", "=", "acct-existing-owner")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			label: "Existing Owner",
			owner_principal_email: "other@inherent.design",
			sync_enabled: 0,
		});
	});

	it("completeGoogleConnectCommand coalesces concurrent connects for the same email", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
		vi.resetModules();
		const { db } = await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doUnmock("#/lib/google-oauth");

		let exchangeCalls = 0;
		let releaseExchange = () => {};
		const exchangeBarrier = new Promise<void>((resolve) => {
			releaseExchange = resolve;
		});
		const oauth =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		vi.spyOn(oauth, "exchangeCode").mockImplementation(async () => {
			exchangeCalls += 1;
			if (exchangeCalls === 2) {
				releaseExchange();
			}
			await exchangeBarrier;
			return {
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "openid email https://mail.google.com/",
			};
		});
		vi.spyOn(oauth, "fetchEmailIdentity").mockResolvedValue("USER@example.com");

		const firstAuth = oauth.buildAuthUrl({
			label: "Connect A",
			ownerPrincipalEmail: "mannie@inherent.design",
		});
		const secondAuth = oauth.buildAuthUrl({
			label: "Connect B",
			ownerPrincipalEmail: "mannie@inherent.design",
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const [first, second] = await Promise.all([
			actions.completeGoogleConnectCommand({
				code: "auth-code-a",
				state: firstAuth.state,
			}),
			actions.completeGoogleConnectCommand({
				code: "auth-code-b",
				state: secondAuth.state,
			}),
		]);

		const accounts = await db
			.selectFrom("accounts")
			.selectAll()
			.where("email_address", "=", "user@example.com")
			.execute();
		const syncStates = await db
			.selectFrom("account_sync_state")
			.selectAll()
			.where("account_id", "=", first.accountId)
			.execute();
		const jobs = await db
			.selectFrom("jobs")
			.select(["scope_id"])
			.where("kind", "=", "sync_account_full")
			.execute();

		expect(first.accountId).toBe(second.accountId);
		expect(accounts).toHaveLength(1);
		expect(syncStates).toHaveLength(1);
		expect(jobs).toEqual([{ scope_id: first.accountId }]);
	});

	it("completeGoogleConnectCommand throws for invalid or expired OAuth state", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => null),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "missing-state",
			}),
		).rejects.toThrow("Invalid or expired OAuth state");
	});

	it("completeGoogleConnectCommand surfaces token exchange failures", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Broken Gmail",
					ownerPrincipalEmail: "mannie@inherent.design",
				})),
				exchangeCode: vi.fn(async () => {
					throw new Error(
						"Google OAuth client credentials were rejected by Google. Verify GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for redirect URL http://127.0.0.1:56711/oauth/google/callback. Start local server with mise run dev.",
					);
				}),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "oauth-state",
			}),
		).rejects.toThrow(
			"Google OAuth client credentials were rejected by Google.",
		);
	});

	it("completeGoogleConnectCommand tolerates duplicate active full-sync jobs", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Personal Gmail",
					ownerPrincipalEmail: "mannie@inherent.design",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "user@example.com"),
			};
		});
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJob: vi.fn(async () => {
					throw new Error("SQLITE_CONSTRAINT: jobs_open_scope_idx");
				}),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		expect(result.accountId).toBeTruthy();
	});

	it("beginGoogleConnectCommand returns the Google auth URL payload", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl: vi.fn(
					(
						input: string | { label: string; ownerPrincipalEmail?: string },
					) => ({
						url: `https://accounts.google.com/?label=${encodeURIComponent(
							typeof input === "string" ? input : input.label,
						)}`,
						state: "oauth-state",
					}),
				),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.beginGoogleConnectCommand({
			label: "Personal Gmail",
			ownerPrincipalEmail: "mannie@inherent.design",
		});

		expect(result).toEqual({
			url: "https://accounts.google.com/?label=Personal%20Gmail",
			state: "oauth-state",
		});
	});

	it("beginGoogleConnectCommand runs migrations only once across repeated bootServer calls", async () => {
		const runtime = await createTestRuntime();
		const runMigrations = vi.fn();
		const ensureWorkerStarted = vi.fn();
		const buildAuthUrl = vi.fn(
			(input: string | { label: string; ownerPrincipalEmail?: string }) => ({
				url: `https://accounts.google.com/?label=${encodeURIComponent(
					typeof input === "string" ? input : input.label,
				)}`,
				state: `state-${typeof input === "string" ? input : input.label}`,
			}),
		);

		vi.doMock("#/lib/db", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/db")>("#/lib/db");
			return {
				...actual,
				runMigrations,
			};
		});
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted,
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl,
			};
		});

		try {
			const actions =
				await runtime.importFresh<typeof import("#/server/actions")>(
					"#/server/actions",
				);

			await actions.beginGoogleConnectCommand({
				label: "One",
				ownerPrincipalEmail: "mannie@inherent.design",
			});
			await actions.beginGoogleConnectCommand({
				label: "Two",
				ownerPrincipalEmail: "mannie@inherent.design",
			});

			expect(runMigrations).toHaveBeenCalledTimes(1);
			expect(ensureWorkerStarted).toHaveBeenCalledTimes(1);
			expect(buildAuthUrl).toHaveBeenNthCalledWith(1, {
				label: "One",
				flow: "connect",
				ownerPrincipalEmail: "mannie@inherent.design",
			});
			expect(buildAuthUrl).toHaveBeenNthCalledWith(2, {
				label: "Two",
				flow: "connect",
				ownerPrincipalEmail: "mannie@inherent.design",
			});
		} finally {
			vi.doUnmock("#/lib/db");
			vi.doUnmock("#/lib/worker");
			vi.doUnmock("#/lib/google-oauth");
		}
	});

	it("beginGoogleConnectCommand retries bootServer initialization after a migration failure", async () => {
		const runtime = await createTestRuntime();
		const runMigrations = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("migration failed");
			})
			.mockImplementation(() => undefined);
		const ensureWorkerStarted = vi.fn();
		const buildAuthUrl = vi.fn(
			(input: string | { label: string; ownerPrincipalEmail?: string }) => ({
				url: `https://accounts.google.com/?label=${encodeURIComponent(
					typeof input === "string" ? input : input.label,
				)}`,
				state: "oauth-state",
			}),
		);

		vi.doMock("#/lib/db", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/db")>("#/lib/db");
			return {
				...actual,
				runMigrations,
			};
		});
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted,
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl,
			};
		});

		try {
			const actions =
				await runtime.importFresh<typeof import("#/server/actions")>(
					"#/server/actions",
				);

			await expect(
				actions.beginGoogleConnectCommand({
					label: "Retry",
					ownerPrincipalEmail: "mannie@inherent.design",
				}),
			).rejects.toThrow("migration failed");

			await expect(
				actions.beginGoogleConnectCommand({
					label: "Retry",
					ownerPrincipalEmail: "mannie@inherent.design",
				}),
			).resolves.toEqual({
				url: "https://accounts.google.com/?label=Retry",
				state: "oauth-state",
			});

			expect(runMigrations).toHaveBeenCalledTimes(2);
			expect(ensureWorkerStarted).toHaveBeenCalledTimes(1);
			expect(buildAuthUrl).toHaveBeenCalledTimes(1);
		} finally {
			vi.doUnmock("#/lib/db");
			vi.doUnmock("#/lib/worker");
			vi.doUnmock("#/lib/google-oauth");
		}
	});

	it("beginGoogleReconnectCommand writes reconnect flow metadata for the target account", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconnect",
			label: "Reconnect Me",
			emailAddress: "reconnect@example.com",
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl: vi.fn(
					(input: {
						label: string;
						flow?: "connect" | "reconnect";
						accountId?: string;
					}) => ({
						url: `https://accounts.google.com/?label=${encodeURIComponent(input.label)}`,
						state: "oauth-state",
					}),
				),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.beginGoogleReconnectCommand({
			accountId: "acct-reconnect",
			label: "Renamed Gmail",
		});

		expect(result).toEqual({
			url: "https://accounts.google.com/?label=Renamed%20Gmail",
			state: "oauth-state",
		});
	});

	it("beginGoogleConnectCommand backfills ownerless accounts to the bootstrap admin", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-ownerless",
			emailAddress: "ownerless@example.com",
			ownerPrincipalEmail: null,
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl: vi.fn(() => ({
					url: "https://accounts.google.com/?label=Personal%20Gmail",
					state: "oauth-state",
				})),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await actions.beginGoogleConnectCommand({
			label: "Personal Gmail",
			ownerPrincipalEmail: "mannie@inherent.design",
		});

		const account = await db
			.selectFrom("accounts")
			.select(["owner_principal_email"])
			.where("id", "=", "acct-ownerless")
			.executeTakeFirstOrThrow();
		expect(account.owner_principal_email).toBe("mannie@inherent.design");
	});

	it("completeGoogleConnectCommand reconnect flow updates the requested account in place", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconnect-flow",
			label: "Old Label",
			emailAddress: "reconnect@example.com",
			syncEnabled: 0,
			syncStatus: "needs_reconnect",
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Renamed Gmail",
					flow: "reconnect" as const,
					accountId: "acct-reconnect-flow",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "Reconnect@Example.com"),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const result = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});

		const rows = await db.selectFrom("accounts").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(result.accountId).toBe("acct-reconnect-flow");
		expect(rows[0]).toMatchObject({
			id: "acct-reconnect-flow",
			label: "Renamed Gmail",
			email_address: "reconnect@example.com",
			sync_enabled: 1,
			sync_status: "idle",
		});
	});

	it("completeGoogleConnectCommand reconnect flow rejects the wrong Gmail identity without mutating the account", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-reconnect-mismatch",
			label: "Old Label",
			emailAddress: "expected@example.com",
			syncEnabled: 0,
			syncStatus: "needs_reconnect",
		});

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Wrong Gmail",
					flow: "reconnect" as const,
					accountId: "acct-reconnect-mismatch",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "wrong@example.com"),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "oauth-state",
			}),
		).rejects.toThrow(/wrong Gmail identity/);

		const account = await db
			.selectFrom("accounts")
			.select(["label", "sync_enabled", "sync_status"])
			.where("id", "=", "acct-reconnect-mismatch")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			label: "Old Label",
			sync_enabled: 0,
			sync_status: "needs_reconnect",
		});
	});

	it("queues account jobs idempotently with the expected kinds and metadata", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
			syncStatus: "idle",
		});

		const queueJobIdempotent = vi.fn(async () => "job-1");
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await actions.queueAccountFullSyncCommand({ accountId: "acct-1" });
		await actions.queueAccountDeltaSyncCommand({ accountId: "acct-1" });
		await actions.queueAccountReconcileCommand({ accountId: "acct-1" });
		await actions.queueAccountClassifyBacklogCommand({ accountId: "acct-1" });

		expect(queueJobIdempotent).toHaveBeenNthCalledWith(1, {
			kind: "sync_account_full",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenNthCalledWith(2, {
			kind: "sync_account_delta",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenNthCalledWith(3, {
			kind: "sync_account_reconcile",
			scopeType: "account",
			scopeId: "acct-1",
		});
		expect(queueJobIdempotent).toHaveBeenNthCalledWith(4, {
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-1",
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v3",
		});
	});

	it("rejects paused remote sync commands while still allowing backlog classification", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-paused",
			syncEnabled: 0,
			syncStatus: "paused",
		});

		const queueJobIdempotent = vi.fn(async () => "job-local");
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.queueAccountFullSyncCommand({ accountId: "acct-paused" }),
		).rejects.toThrow(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);
		await expect(
			actions.queueAccountDeltaSyncCommand({ accountId: "acct-paused" }),
		).rejects.toThrow(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);
		await expect(
			actions.queueAccountReconcileCommand({ accountId: "acct-paused" }),
		).rejects.toThrow(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);

		await expect(
			actions.queueAccountClassifyBacklogCommand({ accountId: "acct-paused" }),
		).resolves.toBe("job-local");
		expect(queueJobIdempotent).toHaveBeenCalledTimes(1);
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: "acct-paused",
			model: "gpt-5.4-mini",
			promptVersion: "classify-email-v3",
		});
	});

	it("queues overseer rebuilds with the configured model and prompt version", async () => {
		const runtime = await createTestRuntime();
		setEnv({
			ZMAIL_FALLBACK_MODEL: "gpt-5.4-mini",
		});
		vi.resetModules();
		await bootDb();

		const queueJob = vi.fn(async () => "job-overseer");
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJob,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		await actions.enqueueOverseerCommand({ accountId: "acct-1" });

		expect(queueJob).toHaveBeenCalledWith({
			kind: "rebuild_overseer",
			scopeType: "account",
			scopeId: "acct-1",
			model: config.APP_CONFIG.fallbackModel,
			promptVersion: config.OVERSEER_PROMPT_VERSION,
		});
	});

	it("pauses, resumes, and disconnects account sync", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		await db
			.insertInto("account_sync_state")
			.values({
				account_id: "acct-1",
				uidvalidity: 100,
				latest_uid_cursor: 42,
				earliest_uid_cursor: 1,
				backfill_snapshot_uid: 42,
				backfill_next_uid: null,
				last_bootstrap_started_at: "2026-01-01T00:00:00.000Z",
				last_bootstrap_completed_at: "2026-01-01T00:05:00.000Z",
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: "2026-01-01T00:05:00.000Z",
				backfill_completed_at: "2026-01-01T00:05:00.000Z",
				last_idle_started_at: null,
				last_idle_heartbeat_at: null,
				watcher_status: "stopped",
				consecutive_failures: 0,
				backoff_until: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const stopWatcher = vi.fn(async () => undefined);
		const startWatcher = vi.fn(async () => undefined);
		const deleteOAuthToken = vi.fn(() => undefined);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			stopWatcher,
			startWatcher,
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				deleteOAuthToken,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.pauseAccountSyncCommand({ accountId: "acct-1" }),
		).resolves.toEqual({ status: "paused" });
		let account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status"])
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 0,
			sync_status: "paused",
		});
		expect(stopWatcher).toHaveBeenCalledWith("acct-1");

		await expect(
			actions.resumeAccountSyncCommand({ accountId: "acct-1" }),
		).resolves.toEqual({ status: "resumed" });
		account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status"])
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 1,
			sync_status: "idle",
		});
		expect(startWatcher).toHaveBeenCalledWith("acct-1");

		await expect(
			actions.disconnectAccountCommand({ accountId: "acct-1" }),
		).resolves.toEqual({ status: "disconnected" });
		account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status", "last_error"])
			.where("id", "=", "acct-1")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 0,
			sync_status: "idle",
			last_error: null,
		});
		expect(stopWatcher).toHaveBeenCalledTimes(2);
		expect(deleteOAuthToken).toHaveBeenCalledWith("acct-1");
	});

	it("purgeAccountCommand blocks while account-scoped jobs are running", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-purge-blocked",
			emailAddress: "blocked@example.com",
		});
		await db
			.insertInto("jobs")
			.values({
				id: "job-purge-blocked",
				kind: "sync_account_full",
				scope_type: "account",
				scope_id: "acct-purge-blocked",
				status: "running",
				model: null,
				prompt_version: null,
				request_count: 0,
				success_count: 0,
				error_count: 0,
				claimed_at: null,
				lease_expires_at: null,
				attempts: 1,
				last_error: null,
				created_at: "2026-01-03T00:00:00.000Z",
				started_at: null,
				finished_at: null,
				meta_json: "{}",
			})
			.execute();

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.purgeAccountCommand({
				accountId: "acct-purge-blocked",
				confirmationEmail: "blocked@example.com",
			}),
		).rejects.toThrow(/blocked while jobs are running/);
	});

	it("purgeAccountCommand deletes the local account, storage, and account-scoped jobs, then queues finance rebuilds", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-purge",
			emailAddress: "purge@example.com",
		});
		const messageId = await insertMessageRow(db, {
			id: "msg-purge",
			accountId: "acct-purge",
		});
		await db
			.insertInto("message_sources")
			.values({
				id: "source-purge",
				message_id: messageId,
				account_id: "acct-purge",
				remote_message_id: "remote-purge",
				remote_thread_id: "thread-purge",
				mailbox: "[Gmail]/All Mail",
				imap_uid: 42,
				uidvalidity: 99,
				raw_rfc822_path: "data/accounts/acct-purge/raw/remote-purge.eml",
				raw_sha256: "raw-purge",
				state: "active",
				first_seen_at: "2026-01-01T00:00:00.000Z",
				last_seen_at: "2026-01-01T00:00:00.000Z",
				tombstoned_at: null,
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("account_sync_state")
			.values({
				account_id: "acct-purge",
				uidvalidity: null,
				latest_uid_cursor: null,
				earliest_uid_cursor: null,
				backfill_snapshot_uid: null,
				backfill_next_uid: null,
				last_bootstrap_started_at: null,
				last_bootstrap_completed_at: null,
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: null,
				backfill_completed_at: null,
				last_idle_started_at: null,
				last_idle_heartbeat_at: null,
				watcher_status: "stopped",
				consecutive_failures: 0,
				backoff_until: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("jobs")
			.values([
				{
					id: "job-purge-queued",
					kind: "sync_account_delta",
					scope_type: "account",
					scope_id: "acct-purge",
					status: "queued",
					model: null,
					prompt_version: null,
					request_count: 0,
					success_count: 0,
					error_count: 0,
					claimed_at: null,
					lease_expires_at: null,
					attempts: 0,
					last_error: null,
					created_at: "2026-01-02T00:00:00.000Z",
					started_at: null,
					finished_at: null,
					meta_json: "{}",
				},
				{
					id: "job-unrelated",
					kind: "sync_account_full",
					scope_type: "account",
					scope_id: "acct-other",
					status: "queued",
					model: null,
					prompt_version: null,
					request_count: 0,
					success_count: 0,
					error_count: 0,
					claimed_at: null,
					lease_expires_at: null,
					attempts: 0,
					last_error: null,
					created_at: "2026-01-02T00:00:00.000Z",
					started_at: null,
					finished_at: null,
					meta_json: "{}",
				},
			])
			.execute();

		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		mkdirSync(config.accountRawDir("acct-purge"), { recursive: true });
		writeFileSync(
			config.accountOAuthPath("acct-purge"),
			JSON.stringify({
				version: 1,
				provider: "google",
				emailAddress: "purge@example.com",
				accessToken: "access-token",
				refreshToken: "refresh-token",
				expiresAt: "2099-01-01T00:00:00.000Z",
				scope: ["openid", "email"],
				tokenType: "Bearer",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		writeFileSync(
			`${config.accountRawDir("acct-purge")}/remote-purge.eml`,
			"raw message",
		);

		const stopWatcher = vi.fn(async () => undefined);

		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			stopWatcher,
			startWatcher: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.purgeAccountCommand({
				accountId: "acct-purge",
				confirmationEmail: "PURGE@example.com",
			}),
		).resolves.toEqual({ status: "deleted" });

		expect(stopWatcher).toHaveBeenCalledWith("acct-purge");
		expect(existsSync(config.accountDir("acct-purge"))).toBe(false);
		expect(
			await db
				.selectFrom("accounts")
				.select(["id"])
				.where("id", "=", "acct-purge")
				.executeTakeFirst(),
		).toBeUndefined();
		expect(
			await db
				.selectFrom("messages")
				.select(["id"])
				.where("account_id", "=", "acct-purge")
				.execute(),
		).toEqual([]);
		expect(
			await db
				.selectFrom("jobs")
				.select(["id"])
				.where("scope_id", "=", "acct-purge")
				.execute(),
		).toEqual([]);
		expect(
			await db
				.selectFrom("jobs")
				.select(["id"])
				.where("id", "=", "job-unrelated")
				.executeTakeFirst(),
		).toEqual({ id: "job-unrelated" });
		expect(
			await db
				.selectFrom("jobs")
				.select(["kind", "scope_type", "scope_id", "status"])
				.where("scope_type", "=", "system")
				.where("kind", "in", [
					"rebuild_finance_knowledge",
					"rebuild_finance_rollups",
				])
				.orderBy("kind", "asc")
				.execute(),
		).toEqual([
			{
				kind: "rebuild_finance_knowledge",
				scope_type: "system",
				scope_id: "finance",
				status: "queued",
			},
			{
				kind: "rebuild_finance_rollups",
				scope_type: "system",
				scope_id: "finance_rollups",
				status: "queued",
			},
		]);
	});

	it("resume restores backfilling state and requeues pending historical work", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-backfill",
			syncEnabled: 0,
			syncStatus: "paused",
		});
		await db
			.insertInto("account_sync_state")
			.values({
				account_id: "acct-backfill",
				uidvalidity: 100,
				latest_uid_cursor: 42,
				earliest_uid_cursor: 21,
				backfill_snapshot_uid: 42,
				backfill_next_uid: 20,
				last_bootstrap_started_at: "2026-01-01T00:00:00.000Z",
				last_bootstrap_completed_at: "2026-01-01T00:05:00.000Z",
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: "2026-01-01T00:05:00.000Z",
				backfill_completed_at: null,
				last_idle_started_at: null,
				last_idle_heartbeat_at: null,
				watcher_status: "stopped",
				consecutive_failures: 0,
				backoff_until: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		const queueJobIdempotent = vi.fn(async () => "job-backfill");
		const startWatcher = vi.fn(async () => undefined);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			startWatcher,
			stopWatcher: vi.fn(async () => undefined),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJobIdempotent,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);

		await expect(
			actions.resumeAccountSyncCommand({ accountId: "acct-backfill" }),
		).resolves.toEqual({ status: "resumed" });

		const account = await db
			.selectFrom("accounts")
			.select(["sync_enabled", "sync_status"])
			.where("id", "=", "acct-backfill")
			.executeTakeFirstOrThrow();
		expect(account).toEqual({
			sync_enabled: 1,
			sync_status: "backfilling",
		});
		expect(startWatcher).toHaveBeenCalledWith("acct-backfill");
		expect(queueJobIdempotent).toHaveBeenCalledWith({
			kind: "sync_account_backfill",
			scopeType: "account",
			scopeId: "acct-backfill",
		});
	});

	it("emits loader log events for account views", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db);

		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await actions.loadAccountsData();
		await actions.loadAccountNewData();
		await actions.loadAccountDetailData({ accountId: "acct-1" });

		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "loader",
			operation: "loadAccountsData",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "loader",
			operation: "loadAccountNewData",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "loader",
			operation: "loadAccountDetailData",
			account_id: "acct-1",
		});
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "server.action.start",
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						accounts: 1,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						oauth_ready: false,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						message_count: 0,
						tombstone_count: 0,
						recent_jobs: 0,
						has_sync_state: false,
					}),
				}),
			]),
		);
	});

	it("logs unavailable runtime backend summaries for runs data", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				listJobs: vi.fn(async () => []),
			};
		});
		vi.doMock("#/lib/pi", () => ({
			getPiStatus: vi.fn(async () => ({
				subscriptionConfigured: false,
				apiConfigured: false,
				preferredBackend: "auto",
				resolvedBackend: null,
			})),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await actions.loadRunsData();

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						jobs: 0,
						resolved_backend: "unavailable",
					}),
				}),
			]),
		);
	});

	it("emits connect and queue command log events", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const log = createMockLogModule();
		let queueIndex = 0;
		const queueJobIdempotent = vi.fn(
			async (input: { kind: string }) => `job-${input.kind}-${++queueIndex}`,
		);
		const queueJob = vi.fn(async () => "job-overseer-1");

		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				buildAuthUrl: vi.fn(
					(
						input: string | { label: string; ownerPrincipalEmail?: string },
					) => ({
						url: `https://accounts.google.com/?label=${encodeURIComponent(
							typeof input === "string" ? input : input.label,
						)}`,
						state: "oauth-state",
					}),
				),
				loadOAuthState: vi.fn(() => ({
					state: "oauth-state",
					codeVerifier: "code-verifier",
					label: "Personal Gmail",
					ownerPrincipalEmail: "mannie@inherent.design",
				})),
				exchangeCode: vi.fn(async () => ({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "openid email https://mail.google.com/",
				})),
				fetchEmailIdentity: vi.fn(async () => "user@example.com"),
			};
		});
		vi.doMock("#/lib/jobs", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/jobs")>("#/lib/jobs");
			return {
				...actual,
				queueJob,
				queueJobIdempotent,
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await actions.beginGoogleConnectCommand({
			label: "Personal Gmail",
			ownerPrincipalEmail: "mannie@inherent.design",
		});
		const { accountId } = await actions.completeGoogleConnectCommand({
			code: "auth-code",
			state: "oauth-state",
		});
		await actions.queueAccountFullSyncCommand({ accountId });
		await actions.queueAccountDeltaSyncCommand({ accountId });
		await actions.queueAccountReconcileCommand({ accountId });
		await actions.queueAccountClassifyBacklogCommand({ accountId });
		await actions.enqueueOverseerCommand({ accountId });

		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "beginGoogleConnectCommand",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "completeGoogleConnectCommand",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "queueAccountFullSyncCommand",
			account_id: accountId,
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "enqueueOverseerCommand",
			account_id: accountId,
		});
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						oauth_redirect_prepared: true,
					}),
				}),
				expect.objectContaining({
					type: "add",
					fields: expect.objectContaining({
						account_id: accountId,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						account_id: accountId,
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-sync_account_full-2",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-sync_account_delta-3",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-sync_account_reconcile-4",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-classify_account_backlog-5",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						job_id: "job-overseer-1",
					}),
				}),
			]),
		);
	});

	it("emits review, classify, and sync toggle command log events", async () => {
		const runtime = await createTestRuntime();
		const { db } = await bootDb();
		await seedTestAccount(db, {
			id: "acct-1",
			syncEnabled: 1,
			syncStatus: "idle",
		});
		const { insertMessageRow } = await import("#/test/helpers/db");
		const messageId = await insertMessageRow(db, {
			id: "message-1",
			accountId: "acct-1",
		});

		await db
			.insertInto("classification_results")
			.values({
				id: "classification-1",
				job_id: null,
				message_id: messageId,
				model: "gpt-5.4-mini",
				prompt_version: "classify-email-v1",
				source: "model",
				result_json: "{}",
				raw_response_json: "{}",
				usage_json: null,
				low_confidence: 1,
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();
		await db
			.insertInto("reviews")
			.values({
				id: "review-1",
				message_id: messageId,
				source_classification_result_id: "classification-1",
				status: "open",
				reviewer_note: null,
				override_label_json: null,
				created_at: "2026-01-01T00:00:00.000Z",
				resolved_at: null,
			})
			.execute();

		const log = createMockLogModule();
		const stopWatcher = vi.fn(async () => undefined);
		const startWatcher = vi.fn(async () => undefined);
		const deleteOAuthToken = vi.fn(() => undefined);
		const ensureModerationForMessage = vi.fn(async () => ({
			nsfwFlag: false,
			scores: {
				sexual: 0,
			},
		}));
		const classifyMessageNow = vi.fn(async () => ({
			label: buildMessageLabelV3({
				finance: {
					relevant: false,
					signal: "none",
					operational: false,
					bookHint: "unknown",
					requiresFinanceIntel: false,
					confidence: 1,
					evidence: null,
				},
				routing: {
					primaryBucket: "other",
					secondaryBuckets: [],
					tags: [],
				},
				explanation: "ok",
			}),
		}));

		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/watchers", () => ({
			startWatcher,
			stopWatcher,
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				deleteOAuthToken,
			};
		});
		vi.doMock("#/lib/moderation", () => ({
			ensureModerationForMessage,
			topModerationScores: vi.fn(() => ({ sexual: 0 })),
		}));
		vi.doMock("#/lib/classify", () => ({
			buildAttachmentSummary: vi.fn(() => "none"),
			classifyMessageNow,
			mergeAllowedTags: vi.fn(() => []),
			writeManualOverride: vi.fn(),
		}));
		vi.doMock("#/lib/overseer", () => ({
			loadLatestOverseerContext: vi.fn(async () => ({
				promptPreamble: "Known sender.",
				promotedTags: ["receipt"],
			})),
		}));

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await actions.resolveReviewCommand({
			reviewId: "review-1",
			action: "accept",
		});
		await actions.classifyOneNowCommand({ messageId });
		await actions.pauseAccountSyncCommand({ accountId: "acct-1" });
		await actions.resumeAccountSyncCommand({ accountId: "acct-1" });
		await actions.disconnectAccountCommand({ accountId: "acct-1" });

		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "resolveReviewCommand",
			review_id: "review-1",
			review_action: "accept",
		});
		expect(log.startTrace).toHaveBeenCalledWith({
			kind: "command",
			operation: "classifyOneNowCommand",
			message_id: messageId,
		});
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "add",
					fields: expect.objectContaining({
						message_id: messageId,
					}),
				}),
				expect.objectContaining({
					type: "add",
					fields: expect.objectContaining({
						account_id: "acct-1",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "accepted",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "queued",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "paused",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "resumed",
					}),
				}),
				expect.objectContaining({
					type: "complete",
					event: "server.action.complete",
					fields: expect.objectContaining({
						status: "disconnected",
					}),
				}),
			]),
		);
	});

	it("emits failure log events for action errors", async () => {
		const runtime = await createTestRuntime();
		await bootDb();

		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		vi.doMock("#/lib/worker", () => ({
			ensureWorkerStarted: vi.fn(),
		}));
		vi.doMock("#/lib/google-oauth", async () => {
			const actual =
				await vi.importActual<typeof import("#/lib/google-oauth")>(
					"#/lib/google-oauth",
				);
			return {
				...actual,
				loadOAuthState: vi.fn(() => null),
			};
		});

		const actions =
			await runtime.importFresh<typeof import("#/server/actions")>(
				"#/server/actions",
			);
		await expect(
			actions.completeGoogleConnectCommand({
				code: "auth-code",
				state: "missing-state",
			}),
		).rejects.toThrow("Invalid or expired OAuth state");

		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "server.action.start",
				}),
				expect.objectContaining({
					type: "fail",
					event: "server.action.fail",
				}),
			]),
		);
	});
});
